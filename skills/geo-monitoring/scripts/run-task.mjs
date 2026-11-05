import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseArgs, option, required } from './lib/cli.mjs';
import { requireProfile } from './lib/profiles.mjs';
import { buildReport } from './lib/report.mjs';
import { availableMemoryMiB, calculateWorkerLimit } from './lib/scheduler.mjs';
import {
  appendEvent,
  bindingDirectory,
  loadTask,
  loadWorkQueue,
  persistWorkQueue,
  questionDirectory,
  updateManifest,
} from './lib/task.mjs';
import { acquireCoordinatorLock } from './lib/coordinator-lock.mjs';
import {
  claimNext,
  completeClaim,
  expireClaims,
  failClaim,
  hasImmediateWork,
  hasOutstandingWork,
  heartbeatClaim,
  markPendingFailed,
  nextAvailableAt,
  requeueAllClaims,
  requeueClaimsForBinding,
  seedCompleted,
  summarizeQueue,
} from './lib/work-queue.mjs';

const defaultWorkerScript = path.join(path.dirname(fileURLToPath(import.meta.url)), 'platform-worker.mjs');
const QUEUE_SCAN_INTERVAL_MS = 1_000;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

async function readJsonIfPresent(filePath) {
  try { return JSON.parse(await readFile(filePath, 'utf8')); } catch { return null; }
}

function sendToWorker(child, message) {
  if (!child?.connected) return;
  try { child.send(message); } catch { /* The worker exited between the check and send. */ }
}

function spawnPlatformWorker({ taskDirectory, binding, browserPath, workerScript, onEvent }) {
  const args = [workerScript, '--task', taskDirectory, '--binding', binding.bindingId];
  if (browserPath) args.push('--browser', browserPath);
  const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let stdoutBuffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk;
    const lines = stdoutBuffer.split(/\r?\n/u);
    stdoutBuffer = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      try { onEvent(JSON.parse(line)); } catch { onEvent({ level: 'info', message: line }); }
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => onEvent({ level: 'error', bindingId: binding.bindingId, message: String(chunk).trim() }));

  const completion = new Promise((resolve) => {
    child.once('error', (error) => resolve({ bindingId: binding.bindingId, code: 1, signal: null, error: error.message, child }));
    child.once('close', (code, signal) => resolve({ bindingId: binding.bindingId, code, signal, error: null, child }));
  });
  return { binding, child, completion };
}

async function resolveRunnableBindings(task, recordEvent) {
  const runnable = [];
  const rejected = [];
  for (const binding of task.platforms) {
    try {
      const profile = await requireProfile({
        profilesDirectory: task.storage.profilesDirectory,
        platformId: binding.id,
        profileId: binding.profileId,
      });
      if (profile.health === 'ready') {
        runnable.push(binding);
        continue;
      }
      rejected.push({ binding, reason: `profile health is ${profile.health}` });
    } catch (error) {
      rejected.push({ binding, reason: error.message });
    }
  }
  for (const item of rejected) {
    await recordEvent({
      level: 'error',
      bindingId: item.binding.bindingId,
      platformId: item.binding.id,
      profileId: item.binding.profileId,
      message: `Profile is not runnable: ${item.reason}`,
    });
  }
  return { runnable, rejected };
}

export async function runTask({ taskDirectory, browserPath, workerScript: requestedWorkerScript, coordinatorHeartbeatIntervalMs } = {}) {
  const workerScript = requestedWorkerScript ?? defaultWorkerScript;
  const { task, files } = await loadTask(taskDirectory);
  let queue = null;
  let coordinatorLock = null;
  let lockLostError = null;
  let queueOperation = Promise.resolve();
  let manifestOperation = Promise.resolve();
  let cancelled = false;
  let expiryTimer = null;
  const active = new Map();
  const children = new Map();
  const stopping = new Set();
  const scheduling = task.platforms.map((binding) => ({ ...binding }));

  const recordEvent = (event) => appendEvent(taskDirectory, event).catch(() => undefined);
  const assertCoordinatorOwned = () => {
    if (lockLostError) throw lockLostError;
    if (coordinatorLock?.lost) {
      const error = new Error('Coordinator lock is no longer owned by this process.');
      error.code = 'coordinator_lock_lost';
      throw error;
    }
  };
  const mutateManifest = (updater) => {
    const result = manifestOperation.then(
      async () => {
        assertCoordinatorOwned();
        return updateManifest(taskDirectory, updater);
      },
      async () => {
        assertCoordinatorOwned();
        return updateManifest(taskDirectory, updater);
      },
    );
    manifestOperation = result.catch(() => undefined);
    return result;
  };

  const persistQueue = async ({ updateSummary = false } = {}) => {
    assertCoordinatorOwned();
    await persistWorkQueue({ taskDirectory, queue });
    if (updateSummary) {
      await mutateManifest((manifest) => ({
        ...manifest,
        queueSummary: summarizeQueue(queue, { platformIds: task.platforms.map((binding) => binding.id) }),
      }));
    }
  };
  const serializeQueueOperation = (operation) => {
    const result = queueOperation.then(operation, operation);
    queueOperation = result.catch(() => undefined);
    return result;
  };

  const stopWorker = async (worker, reason) => {
    const { bindingId } = worker.binding;
    if (stopping.has(bindingId)) return;
    stopping.add(bindingId);
    sendToWorker(worker.child, { type: 'cancel' });
    const forceStop = setTimeout(() => {
      if (worker.child.exitCode === null && worker.child.signalCode === null) worker.child.kill('SIGTERM');
    }, 5_000);
    worker.child.once('close', () => clearTimeout(forceStop));
    await recordEvent({
      level: 'warn',
      bindingId,
      platformId: worker.binding.id,
      profileId: worker.binding.profileId,
      message: reason,
    });
  };

  const handleQueueRequest = async (worker, message) => {
    const { binding, child } = worker;
    const operation = message.operation;
    const respond = (payload) => sendToWorker(child, { type: 'queue_response', requestId: message.requestId, ok: true, ...payload });
    const failResponse = (error) => sendToWorker(child, {
      type: 'queue_response',
      requestId: message.requestId,
      ok: false,
      error: { code: error.code ?? 'queue_error', message: error.message },
    });

    try {
      if (operation === 'claim') {
        if (cancelled) {
          respond({ stop: true, reason: 'cancelled' });
        } else if (hasImmediateWork(queue, { platformId: binding.id })) {
          const claim = claimNext(queue, {
            platformId: binding.id,
            bindingId: binding.bindingId,
            leaseMs: task.settings.claimLeaseMs,
          });
          await persistQueue({ updateSummary: true });
          respond({ claim });
        } else if (hasOutstandingWork(queue, { platformId: binding.id })) {
          const availableAt = nextAvailableAt(queue, { platformIds: [binding.id] });
          const retryAfterMs = availableAt ? Math.max(250, Math.min(1_000, availableAt.getTime() - Date.now())) : 1_000;
          respond({ claim: null, retryAfterMs });
        } else {
          respond({ stop: true, reason: 'queue_empty' });
        }
        return;
      }

      const claim = message.claim;
      if (!claim) {
        respond({ accepted: false, reason: 'missing_claim' });
        return;
      }

      if (operation === 'heartbeat') {
        const owned = heartbeatClaim(queue, {
          ...claim,
          leaseMs: Number(message.leaseMs) || task.settings.claimLeaseMs,
        });
        if (owned) await persistQueue();
        respond({ owned });
        return;
      }

      if (operation === 'complete') {
        const completed = completeClaim(queue, claim);
        if (completed) await persistQueue({ updateSummary: true });
        respond({ completed: Boolean(completed), result: completed });
        return;
      }

      if (operation === 'fail') {
        const result = failClaim(queue, {
          ...claim,
          category: message.category ?? 'platform_error',
          message: message.message ?? '',
          retryable: message.retryable !== false,
          forceRetry: Boolean(message.forceRetry),
          maxAttempts: Number(message.maxAttempts) || task.settings.maxQuestionAttempts,
          retryDelayMs: Number(message.retryDelayMs) || task.settings.retryBaseDelayMs,
        });
        if (result) await persistQueue({ updateSummary: true });
        respond({ accepted: Boolean(result), ...(result ?? { retried: false }) });
        return;
      }

      respond({ accepted: false, reason: `unknown_operation:${operation}` });
    } catch (error) {
      failResponse(error);
    }
  };

  const cancel = () => {
    if (cancelled) return;
    cancelled = true;
    void recordEvent({ level: 'warn', message: 'Cancellation requested; terminating active platform workers.' });
    for (const child of children.values()) {
      sendToWorker(child, { type: 'cancel' });
      const forceStop = setTimeout(() => child.kill('SIGTERM'), 5_000);
      child.once('close', () => clearTimeout(forceStop));
    }
  };
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);

  try {
    coordinatorLock = await acquireCoordinatorLock({
      taskDirectory,
      taskId: task.id,
      heartbeatIntervalMs: coordinatorHeartbeatIntervalMs,
      onLost: (error) => {
        lockLostError = error;
        cancel();
      },
    });
    const loadedQueue = await loadWorkQueue({ taskDirectory, task, files });
    queue = loadedQueue.queue;
    const requeuedClaims = coordinatorLock.recovered ? requeueAllClaims(queue) : [];
    if (loadedQueue.recovered || requeuedClaims.length) {
      await persistQueue();
    }
    if (loadedQueue.recovered) {
      await recordEvent({
        level: "warn",
        message: "Recovered work queue from " + loadedQueue.source + (loadedQueue.reconciled ? " and reconciled " + loadedQueue.reconciled + " completed artifact(s)." : "."),
      });
    }
    if (requeuedClaims.length) {
      await recordEvent({
        level: "warn",
        message: "Recovered stale coordinator; returned " + requeuedClaims.length + " claimed question(s) to pending.",
      });
    }
    if (lockLostError) throw lockLostError;
    await mutateManifest((manifest) => ({
      ...manifest,
      status: 'running',
      startedAt: manifest.startedAt ?? new Date().toISOString(),
      queueSummary: summarizeQueue(queue, { platformIds: task.platforms.map((binding) => binding.id) }),
    }));
    await recordEvent({ message: 'Dynamic task scheduler started.' });

    const { runnable, rejected } = await resolveRunnableBindings(task, recordEvent);
    scheduling.splice(0, scheduling.length, ...runnable);
    if (rejected.length) {
      await mutateManifest((manifest) => ({
        ...manifest,
        bindingStates: {
          ...manifest.bindingStates,
          ...Object.fromEntries(rejected.map(({ binding }) => [binding.bindingId, 'failed'])),
        },
      }));
    }

    expiryTimer = setInterval(() => {
      void serializeQueueOperation(async () => {
        const expired = expireClaims(queue, { now: new Date() });
        if (!expired.length) return;
        await persistQueue({ updateSummary: true });
        const affectedBindings = new Set();
        for (const claim of expired) {
          await recordEvent({
            level: 'warn',
            bindingId: claim.bindingId,
            platformId: claim.platformId,
            questionId: claim.questionId,
            message: `Lease expired; question returned to the shared queue.`,
          });
          if (!affectedBindings.has(claim.bindingId)) {
            affectedBindings.add(claim.bindingId);
            const worker = active.get(claim.bindingId);
            if (worker) {
              await stopWorker(worker, 'Stopping a worker that lost its lease so another profile can take over.');
            }
          }
        }
      }).catch(() => undefined);
    }, QUEUE_SCAN_INTERVAL_MS);

    const finalizeWorker = async (result) => {
      const worker = active.get(result.bindingId);
      if (!worker) return;
      const stoppedByCoordinator = stopping.has(result.bindingId);
      active.delete(result.bindingId);
      children.delete(result.bindingId);
      stopping.delete(result.bindingId);
      await serializeQueueOperation(async () => {
        const requeued = requeueClaimsForBinding(queue, { bindingId: result.bindingId });
        for (const claim of requeued) {
          const record = await readJsonIfPresent(path.join(questionDirectory(taskDirectory, worker.binding, claim.questionId), 'answer.json'));
          if (record?.status === 'completed') {
            seedCompleted(queue, {
              platformId: claim.platformId,
              questionId: claim.questionId,
              bindingId: result.bindingId,
              attempt: claim.attempt,
            });
          }
        }
        await persistQueue({ updateSummary: true });
      });
      const status = await readJsonIfPresent(path.join(bindingDirectory(taskDirectory, worker.binding), 'status.json'));
      const reportedState = status?.status;
      const bindingState = stoppedByCoordinator && (!reportedState || reportedState === 'running')
        ? 'cancelled'
        : (reportedState ?? (result.code === 0 ? 'completed' : 'failed'));
      await mutateManifest((manifest) => ({
        ...manifest,
        bindingStates: { ...manifest.bindingStates, [result.bindingId]: bindingState },
      }));
      await recordEvent({
        level: result.code === 0 ? 'info' : 'error',
        bindingId: result.bindingId,
        platformId: worker.binding.id,
        profileId: worker.binding.profileId,
        message: `Platform binding exited with ${bindingState}${result.signal ? ` (${result.signal})` : ''}.`,
      });
    };

    const stopIdleWorkers = async () => {
      for (const worker of active.values()) {
        const { bindingId } = worker.binding;
        if (stopping.has(bindingId)) continue;
        if (hasOutstandingWork(queue, { platformId: worker.binding.id })) continue;
        await stopWorker(worker, 'No outstanding work remains for this platform; stopping an idle worker that no longer owns a live lease.');
      }
    };

    let lastLimit = 0;
    while (scheduling.length || active.size) {
      if (!cancelled) {
        const freeMiB = availableMemoryMiB();
        const limit = calculateWorkerLimit({
          availableMiB: freeMiB,
          ...task.settings,
          selectedBindingCount: task.platforms.length,
        });
        while (scheduling.length && active.size < limit) {
          const [binding] = scheduling.splice(0, 1);
          const decision = { at: new Date().toISOString(), bindingId: binding.bindingId, availableMemoryMiB: freeMiB, workerLimit: limit };
          await mutateManifest((manifest) => ({
            ...manifest,
            bindingStates: { ...manifest.bindingStates, [binding.bindingId]: 'starting' },
            scheduler: { ...manifest.scheduler, decisions: [...manifest.scheduler.decisions, decision] },
          }));
          await recordEvent({ bindingId: binding.bindingId, platformId: binding.id, profileId: binding.profileId, message: `Starting queued profile worker (available memory ${freeMiB} MiB; limit ${limit}).` });
          const worker = spawnPlatformWorker({
            taskDirectory,
            binding,
            browserPath,
            workerScript,
            onEvent: recordEvent,
          });
          const onMessage = (message) => {
            if (message?.type !== 'queue_request') return;
            void serializeQueueOperation(() => handleQueueRequest(worker, message)).catch(() => undefined);
          };
          worker.child.on('message', onMessage);
          worker.completion.onMessage = onMessage;
          active.set(binding.bindingId, worker);
          children.set(binding.bindingId, worker.child);
        }
        if (limit !== lastLimit) {
          lastLimit = limit;
          await recordEvent({ message: `Dynamic worker limit is ${limit}.` });
        }
      }

      await stopIdleWorkers();
      if (!active.size) break;
      const finished = await Promise.race([
        ...[...active.values()].map((worker) => worker.completion),
        delay(1_000).then(() => null),
      ]);
      if (finished) await finalizeWorker(finished);
    }

    if (lockLostError) throw lockLostError;
    if (!cancelled) {
      for (const platformId of [...new Set(task.platforms.map((binding) => binding.id))]) {
        if (!hasOutstandingWork(queue, { platformId })) continue;
        const count = markPendingFailed(queue, {
          platformId,
          category: 'no_available_profile',
          message: 'No runnable profile remains for this platform.',
        });
        if (count) {
          await recordEvent({
            level: 'error',
            platformId,
            message: `Marked ${count} unclaimed question(s) as failed because no runnable profile remains.`,
          });
        }
      }
      await persistQueue({ updateSummary: true });
    }

    const manifest = await mutateManifest((current) => {
      const queueSummary = summarizeQueue(queue, { platformIds: task.platforms.map((binding) => binding.id) });
      const totals = queueSummary.reduce((sum, row) => ({
        total: sum.total + row.total,
        completed: sum.completed + row.completed,
        failed: sum.failed + row.failed,
      }), { total: 0, completed: 0, failed: 0 });
      const status = cancelled
        ? 'cancelled'
        : totals.total > 0 && totals.completed === totals.total
          ? 'completed'
          : totals.completed > 0
            ? 'completed_with_errors'
            : 'failed';
      return {
        ...current,
        status,
        endedAt: new Date().toISOString(),
        queueSummary,
      };
    });
    await buildReport(taskDirectory);
    await recordEvent({ message: `Task finished with status ${manifest.status}.` });
    return manifest;
  } catch (error) {
    if (error?.code === "task_already_running") throw error;
    const lockLost = lockLostError ?? (error?.code === "coordinator_lock_lost" ? error : null);
    if (!lockLost) {
      const queueSummary = queue ? summarizeQueue(queue, { platformIds: task.platforms.map((binding) => binding.id) }) : [];
      await mutateManifest((manifest) => ({
        ...manifest,
        status: "failed",
        endedAt: new Date().toISOString(),
        queueSummary,
        error: { code: error.code ?? "task_failed", message: error.message },
      })).catch(() => undefined);
    }
    await recordEvent({ level: "error", message: error.message, code: error.code ?? "task_failed" });
    throw error;
  } finally {
    if (expiryTimer) clearInterval(expiryTimer);
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
    await queueOperation.catch(() => undefined);
    await coordinatorLock?.release();
  }
}

async function main() {
  const { options } = parseArgs();
  const manifest = await runTask({ taskDirectory: required(options, 'task'), browserPath: option(options, 'browser') });
  console.log(JSON.stringify({ taskId: manifest.taskId, status: manifest.status }));
  process.exitCode = ['failed', 'cancelled'].includes(manifest.status) ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(JSON.stringify({ error: { code: error.code ?? 'task_failed', message: error.message } }));
    process.exitCode = 1;
  });
}
