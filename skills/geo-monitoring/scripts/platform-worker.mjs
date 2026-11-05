import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { parseArgs, option, required } from './lib/cli.mjs';
import { analyzeBrandMentions, analyzeOwnedDomainCitations } from './lib/brand.mjs';
import { isLikelyProfileLock, resolveBrowserExecutable } from './lib/browser.mjs';
import { captureCitations } from './lib/citations.mjs';
import { watchForHumanChallenge } from './lib/challenge.mjs';
import { getPlatformAdapter } from './lib/platforms/index.mjs';
import { acquireProfileLock } from './lib/profile-lock.mjs';
import { requireProfile, updateProfile } from './lib/profiles.mjs';
import {
  loadTask,
  platformDirectory,
  questionDirectory,
  submittedQuestion,
  writeJson,
} from './lib/task.mjs';

function now() {
  return new Date().toISOString();
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function emit(event) {
  process.stdout.write(`${JSON.stringify({ at: now(), ...event })}\n`);
}
function accountRestrictionError(probe) {
  const message = probe?.message ? `Account restricted: ${probe.message}` : 'Account restricted.';
  const error = new Error(message);
  error.code = 'account_restricted';
  error.loginState = probe;
  return error;
}

function classifyWorkerError(error) {
  if (error?.code === 'lease_lost') return 'lease_lost';
  if (isLikelyProfileLock(error)) return 'profile_locked';
  if (error?.code === 'account_restricted') return 'account_restricted';
  if (error?.code === 'human_challenge') return 'human_challenge';
  if (/login|verification|chat input|authenticated/iu.test(String(error?.message ?? ''))) return 'login_required';
  return 'platform_error';
}

function failurePolicy(category) {
  if (category === 'profile_locked') {
    return { retryable: true, forceRetry: true, stopBinding: true, health: null };
  }
  if (category === 'account_restricted') {
    return { retryable: true, forceRetry: true, stopBinding: true, health: 'restricted' };
  }
  if (category === 'human_challenge') {
    return { retryable: true, forceRetry: true, stopBinding: true, health: 'error' };
  }
  if (category === 'login_required') {
    return { retryable: true, forceRetry: true, stopBinding: true, health: 'expired' };
  }
  if (category === 'lease_lost') {
    return { retryable: false, forceRetry: false, stopBinding: false, health: null };
  }
  return { retryable: true, forceRetry: false, stopBinding: false, health: null };
}

async function waitForAnswerOrChallenge({ adapter, page, timeoutMs }) {
  let settled = false;
  const interactionSignal = watchForHumanChallenge({ adapter, page, isDone: () => settled })
    .then((probe) => (probe ? { interaction: probe } : new Promise(() => {})))
    .catch(() => new Promise(() => {}));
  try {
    const outcome = await Promise.race([
      adapter.waitForAnswer(page, { timeoutMs }).then((answer) => ({ answer })),
      interactionSignal,
    ]);
    if (outcome.interaction) {
      if (outcome.interaction.status === 'restricted') {
        throw accountRestrictionError(outcome.interaction);
      }
      const error = new Error('The platform requested a human challenge. Complete it in the visible browser and retry.');
      error.code = 'human_challenge';
      error.loginState = outcome.interaction;
      throw error;
    }
    return outcome.answer;
  } finally {
    settled = true;
  }
}

async function saveSnapshot(page, directory, name) {
  const screenshot = `${name}.png`;
  const html = `${name}.html`;
  await Promise.all([
    page.screenshot({ path: path.join(directory, screenshot), fullPage: true }),
    page.content().then((content) => writeFile(path.join(directory, html), content, 'utf8')),
  ]);
  return { screenshot, html };
}

function createQueueBroker({ cancel }) {
  const pending = new Map();
  let nextId = 1;
  let closed = false;

  const onMessage = (message) => {
    if (message?.type === 'cancel') {
      cancel();
      return;
    }
    if (message?.type !== 'queue_response' || !message.requestId) return;
    const waiter = pending.get(message.requestId);
    if (!waiter) return;
    pending.delete(message.requestId);
    clearTimeout(waiter.timer);
    if (message.ok) waiter.resolve(message);
    else waiter.reject(Object.assign(new Error(message.error?.message ?? 'Queue request failed.'), { code: message.error?.code ?? 'queue_error' }));
  };

  process.on('message', onMessage);
  process.once('disconnect', () => {
    closed = true;
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(Object.assign(new Error('The task coordinator disconnected.'), { code: 'coordinator_disconnected' }));
    }
    pending.clear();
  });

  return {
    async request(operation, payload = {}) {
      if (closed || !process.connected) throw Object.assign(new Error('The platform worker must run under run-task.mjs.'), { code: 'coordinator_disconnected' });
      const requestId = nextId;
      nextId += 1;
      const response = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(requestId);
          reject(Object.assign(new Error(`Queue request timed out: ${operation}`), { code: 'queue_timeout' }));
        }, 20_000);
        pending.set(requestId, { resolve, reject, timer });
        process.send({ type: 'queue_request', requestId, operation, ...payload }, (error) => {
          if (!error) return;
          const waiter = pending.get(requestId);
          if (!waiter) return;
          pending.delete(requestId);
          clearTimeout(waiter.timer);
          reject(error);
        });
      });
      return response;
    },
    close() {
      closed = true;
      process.removeListener('message', onMessage);
    },
  };
}

export async function runPlatformWorker({ taskDirectory, bindingId, platformId, browserPath } = {}) {
  const { task } = await loadTask(taskDirectory);
  const binding = task.platforms.find((candidate) => candidate.bindingId === bindingId)
    ?? task.platforms.find((candidate) => candidate.id === platformId);
  if (!binding) throw new Error(`Platform binding ${bindingId ?? platformId} is not selected for this task.`);
  const adapter = getPlatformAdapter(binding.id);
  const directory = platformDirectory(taskDirectory, binding);
  const effectiveMode = binding.id === 'doubao' ? 'headed' : 'headless';
  const state = {
    bindingId: binding.bindingId,
    platformId: binding.id,
    profileId: binding.profileId,
    account: binding.account ?? null,
    label: `${adapter.label} / ${binding.account ?? binding.profileId}`,
    status: 'starting',
    startedAt: now(),
    endedAt: null,
    profileDirectory: null,
    mode: effectiveMode,
    claimedQuestionIds: [],
    processedQuestionIds: [],
    completedQuestionIds: [],
    failedQuestionIds: [],
    questionStates: {},
    error: null,
  };
  await writeJson(path.join(directory, 'status.json'), state);

  let context = null;
  let lock = null;
  let broker = null;
  let cancelled = false;
  const cancel = () => {
    cancelled = true;
    void context?.close().catch(() => undefined);
  };
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  broker = createQueueBroker({ cancel });

  try {
    const profile = await requireProfile({
      profilesDirectory: task.storage.profilesDirectory,
      platformId: binding.id,
      profileId: binding.profileId,
    });
    state.profileDirectory = profile.paths.profileDirectory;
    if (profile.health !== 'ready') {
      const error = new Error(`Login required for ${binding.id}/${binding.profileId}; current health is ${profile.health}.`);
      error.code = 'login_required';
      throw error;
    }

    lock = await acquireProfileLock({
      profilesDirectory: task.storage.profilesDirectory,
      platformId: binding.id,
      profileId: binding.profileId,
      ownerType: 'task',
      ownerId: `${task.id}:${binding.bindingId}`,
    });
    const executablePath = resolveBrowserExecutable(browserPath ?? task.runtime?.browserExecutable);
    context = await chromium.launchPersistentContext(profile.paths.chromeDirectory, {
      executablePath,
      headless: effectiveMode === 'headless',
      viewport: { width: 1440, height: 960 },
      locale: 'zh-CN',
    });
    state.status = 'running';
    await updateProfile({
      profilesDirectory: task.storage.profilesDirectory,
      platformId: binding.id,
      profileId: binding.profileId,
      patch: { lastVerifiedAt: now(), lastError: null },
    });
    emit({ type: 'binding_started', bindingId: binding.bindingId, platformId: binding.id, profileId: binding.profileId, message: `${state.label} worker started.` });
    await writeJson(path.join(directory, 'status.json'), state);

    while (!cancelled) {
      let response;
      try {
        response = await broker.request('claim');
      } catch (error) {
        if (cancelled) break;
        throw error;
      }
      if (response.stop) {
        emit({ type: 'binding_idle', bindingId: binding.bindingId, platformId: binding.id, profileId: binding.profileId, message: `${state.label} found no remaining work.` });
        break;
      }
      if (!response.claim) {
        await delay(Math.max(250, Number(response.retryAfterMs) || 1_000));
        continue;
      }

      const claim = response.claim;
      const question = task.questions.find((candidate) => candidate.id === claim.questionId);
      if (!question) {
        await broker.request('fail', {
          claim,
          category: 'task_error',
          message: `Question ${claim.questionId} is missing from task.json.`,
          retryable: false,
        }).catch(() => undefined);
        continue;
      }

      state.claimedQuestionIds.push(question.id);
      state.questionStates[question.id] = 'claimed';
      await writeJson(path.join(directory, 'status.json'), state);

      let heartbeatTimer = null;
      let heartbeatBusy = false;
      let leaseLost = false;
      const heartbeat = async () => {
        if (heartbeatBusy || leaseLost) return;
        heartbeatBusy = true;
        try {
          const reply = await broker.request('heartbeat', { claim, leaseMs: task.settings.claimLeaseMs });
          if (reply.owned === false || reply.completed === false) {
            leaseLost = true;
            emit({ type: 'question_warning', level: 'warn', bindingId: binding.bindingId, platformId: binding.id, profileId: binding.profileId, questionId: question.id, message: 'The work lease is no longer owned by this worker.' });
          }
        } catch (error) {
          if (!cancelled) emit({ type: 'question_warning', level: 'warn', bindingId: binding.bindingId, platformId: binding.id, profileId: binding.profileId, questionId: question.id, message: `Heartbeat failed: ${error.message}` });
        } finally {
          heartbeatBusy = false;
        }
      };
      heartbeatTimer = setInterval(() => { void heartbeat(); }, task.settings.heartbeatIntervalMs);

      const questionDir = questionDirectory(taskDirectory, binding, question.id);
      const record = {
        question,
        bindingId: binding.bindingId,
        platformId: binding.id,
        profileId: binding.profileId,
        account: binding.account ?? null,
        attempt: claim.attempt,
        status: 'running',
        startedAt: now(),
        endedAt: null,
        submittedQuestion: submittedQuestion(question.text, task.settings.appendSearchPrompt),
        submissionMethod: null,
        responseUrl: null,
        answer: null,
        citations: null,
        share: null,
        brandMentions: null,
        ownedDomainCitations: null,
        artifacts: [],
        error: null,
      };
      state.questionStates[question.id] = 'running';
      await writeJson(path.join(directory, 'status.json'), state);
      await writeJson(path.join(questionDir, 'answer.json'), record);
      emit({ type: 'question_started', bindingId: binding.bindingId, platformId: binding.id, profileId: binding.profileId, questionId: question.id, attempt: claim.attempt, message: `${state.label} started ${question.id}.` });

      let page = null;
      let stopBinding = false;
      try {
        page = await context.newPage();
        await page.goto(adapter.entryUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
        record.artifacts.push(await saveSnapshot(page, questionDir, '01-opened'));
        const initialState = await adapter.inspectLoginState(page);
        if (initialState.status === 'restricted') throw accountRestrictionError(initialState);
        record.submissionMethod = await adapter.submitQuestion(page, record.submittedQuestion);
        record.artifacts.push(await saveSnapshot(page, questionDir, '02-submitted'));
        await page.waitForTimeout(500);
        const postSubmitState = await adapter.inspectLoginState(page);
        if (postSubmitState.status === 'restricted') throw accountRestrictionError(postSubmitState);
        record.answer = await waitForAnswerOrChallenge({
          adapter,
          page,
          timeoutMs: task.settings.answerTimeoutMs,
        });
        record.responseUrl = page.url();
        record.artifacts.push(await saveSnapshot(page, questionDir, '03-answer'));
        record.citations = await captureCitations(page, binding.id);
        await writeJson(path.join(questionDir, 'citations.json'), record.citations);
        await page.screenshot({ path: path.join(questionDir, '04-citations.png'), fullPage: true });
        record.artifacts.push({ screenshot: '04-citations.png' });
        try {
          record.share = typeof adapter.captureShareLink === 'function'
            ? await adapter.captureShareLink(page, {
              onDialogOpen: async () => {
                record.artifacts.push(await saveSnapshot(page, questionDir, '05-share'));
              },
            })
            : {
              status: 'unavailable',
              url: null,
              method: null,
              capturedAt: now(),
              dialogOpened: false,
              reason: 'share_capture_not_supported',
              error: null,
            };
        } catch (error) {
          record.share = {
            status: 'failed',
            url: null,
            method: null,
            capturedAt: now(),
            dialogOpened: false,
            reason: 'share_capture_threw',
            error: error.message,
          };
        }
        await writeJson(path.join(questionDir, 'share.json'), record.share);
        record.brandMentions = analyzeBrandMentions(record.answer, task.brand);
        record.ownedDomainCitations = analyzeOwnedDomainCitations(record.citations.citations, task.brand);
        record.status = 'completed';
        record.endedAt = now();
        await writeJson(path.join(questionDir, 'answer.json'), record);
        state.questionStates[question.id] = 'completed';
        state.processedQuestionIds.push(question.id);
        state.completedQuestionIds.push(question.id);
        clearInterval(heartbeatTimer);
        const reply = await broker.request('complete', { claim });
        if (reply.owned === false || reply.completed === false) {
          leaseLost = true;
          emit({ type: 'question_warning', level: 'warn', bindingId: binding.bindingId, platformId: binding.id, profileId: binding.profileId, questionId: question.id, message: reply.error?.message ?? 'Completion was rejected because the lease was lost.' });
        }
        emit({ type: 'question_completed', bindingId: binding.bindingId, platformId: binding.id, profileId: binding.profileId, questionId: question.id, attempt: claim.attempt, message: `${state.label} completed ${question.id}.` });
      } catch (error) {
        const category = cancelled ? 'cancelled' : classifyWorkerError(error);
        const policy = failurePolicy(category);
        record.status = cancelled ? 'cancelled' : 'failed';
        const errorRecord = { message: error.message, category };
        if (error?.loginState) errorRecord.loginState = error.loginState;
        record.error = errorRecord;
        record.endedAt = now();
        state.questionStates[question.id] = record.status;
        state.processedQuestionIds.push(question.id);
        state.failedQuestionIds.push(question.id);
        stopBinding = policy.stopBinding;
        if (stopBinding) state.error = errorRecord;
        if (page && !page.isClosed()) {
          try { record.artifacts.push(await saveSnapshot(page, questionDir, 'error')); } catch { /* Retain the original failure. */ }
        }
        await writeJson(path.join(questionDir, 'answer.json'), record);
        clearInterval(heartbeatTimer);
        const reply = await broker.request('fail', {
          claim,
          category,
          message: error.message,
          retryable: policy.retryable,
          forceRetry: cancelled || policy.forceRetry,
          maxAttempts: task.settings.maxQuestionAttempts,
          retryDelayMs: task.settings.retryBaseDelayMs,
        }).catch(() => ({ ok: false }));
        emit({ type: 'question_failed', level: 'error', bindingId: binding.bindingId, platformId: binding.id, profileId: binding.profileId, questionId: question.id, attempt: claim.attempt, category, retried: Boolean(reply.retried), message: error.message });
      } finally {
        clearInterval(heartbeatTimer);
        if (page) await page.close().catch(() => undefined);
        await writeJson(path.join(directory, 'status.json'), state);
      }

      if (cancelled) break;
      if (stopBinding) break;
    }

    if (cancelled) {
      for (const [questionId, value] of Object.entries(state.questionStates)) {
        if (value === 'claimed' || value === 'running' || value === 'pending') state.questionStates[questionId] = 'cancelled';
      }
      state.status = 'cancelled';
    } else if (state.error) {
      state.status = 'failed';
    } else if (state.failedQuestionIds.length) {
      state.status = 'completed_with_errors';
    } else {
      state.status = 'completed';
    }
  } catch (error) {
    state.status = cancelled ? 'cancelled' : 'failed';
    const errorRecord = { message: error.message, category: classifyWorkerError(error) };
    if (error?.loginState) errorRecord.loginState = error.loginState;
    state.error = errorRecord;
    emit({ type: 'binding_failed', level: 'error', bindingId: binding.bindingId, platformId: binding.id, profileId: binding.profileId, message: error.message });
  } finally {
    state.endedAt = now();
    await context?.close().catch(() => undefined);
    const finishedAt = now();
    const workerError = {
      at: finishedAt,
      category: state.error?.category ?? 'platform_error',
      message: state.error?.message ?? 'Worker failed.',
    };
    if (state.error?.loginState?.restrictedUntil) {
      workerError.restrictedUntil = state.error.loginState.restrictedUntil;
    }
    const basePatch = state.status === 'failed'
      ? { lastError: workerError }
      : { health: 'ready', lastUsedAt: finishedAt, lastError: null };
    if (state.error?.category === 'login_required') basePatch.health = 'expired';
    if (state.error?.category === 'human_challenge') basePatch.health = 'error';
    if (state.error?.category === 'account_restricted') {
      basePatch.health = 'restricted';
      basePatch.restrictedUntil = state.error?.loginState?.restrictedUntil ?? null;
    }
    await updateProfile({
      profilesDirectory: task.storage.profilesDirectory,
      platformId: binding.id,
      profileId: binding.profileId,
      patch: basePatch,
    }).catch(() => undefined);
    await writeJson(path.join(directory, 'status.json'), state);
    await lock?.release();
    broker?.close();
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
  }
  return state;
}

async function main() {
  const { options } = parseArgs();
  const state = await runPlatformWorker({
    taskDirectory: required(options, 'task'),
    bindingId: option(options, 'binding'),
    platformId: option(options, 'platform'),
    browserPath: option(options, 'browser'),
  });
  process.exitCode = state.status === 'failed' ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }).finally(() => {
    if (process.connected) process.disconnect();
  });
}
