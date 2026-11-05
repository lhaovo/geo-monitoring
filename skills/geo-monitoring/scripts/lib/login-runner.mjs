import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { describeAccountBinding, projectAccountBinding } from './account-identity.mjs';
import { isLikelyProfileLock, resolveBrowserExecutable } from './browser.mjs';
import {
  cleanupLoginStaging,
  clearLoginSessionControl,
  consumeLoginSessionCommand,
  moveLoginStaging,
  LOGIN_SESSION_TERMINAL_STATES,
  readLoginSession,
  updateLoginSession,
} from './login-sessions.mjs';
import { getPlatformAdapter } from './platforms/index.mjs';
import { acquireProfileLock } from './profile-lock.mjs';
import { loginMethodLabel, normalizeAccountIdentity, requireProfile, updateProfile } from './profiles.mjs';

export const TERMINAL_LOGIN_STATES = LOGIN_SESSION_TERMINAL_STATES;

function now() {
  return new Date().toISOString();
}

function errorWithCode(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function accountStatePatch(binding) {
  return {
    account: binding?.account ?? null,
    accountBinding: projectAccountBinding(binding),
  };
}

function assertProfileAccount(session, submitted) {
  const expected = normalizeAccountIdentity(session.account);
  const actual = normalizeAccountIdentity(submitted);
  if (expected && actual && expected !== actual) {
    throw errorWithCode(
      `该 Profile 保存的账号是 ${session.account}，与本次提交的 ${submitted} 不一致。请先为 ${submitted} 创建独立 Profile 再登录。`,
      'account_mismatch',
    );
  }
}

function accountNotice(message, binding) {
  return binding.decisionRequired ? message + ' ' + binding.message : message;
}

async function captureChallengeEvidence({ profilesDirectory, sessionId, page }) {
  const directory = path.join(profilesDirectory, '.sessions', `${sessionId}-evidence`);
  try {
    await fs.mkdir(directory, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
    const screenshot = path.join(directory, `challenge-${stamp}.png`);
    await page.screenshot({ path: screenshot }).catch(() => undefined);
    const { describeLoginPage } = await import('./platforms/base.mjs');
    const describe = await describeLoginPage(page).catch(() => null);
    await fs.writeFile(
      path.join(directory, 'challenge-evidence.json'),
      JSON.stringify({ capturedAt: now(), screenshot, describe }, null, 2),
      'utf8',
    );
    return screenshot;
  } catch {
    return null;
  }
}

async function setSessionState(profilesDirectory, sessionId, patch) {
  return updateLoginSession(profilesDirectory, sessionId, (session) => ({
    ...session,
    ...patch,
    lastCheckedAt: now(),
  }));
}

async function launchPersistentContext({ chromeDirectory, headless, browserExecutable }) {
  return chromium.launchPersistentContext(chromeDirectory, {
    executablePath: resolveBrowserExecutable(browserExecutable),
    headless,
    viewport: { width: 1440, height: 960 },
    locale: 'zh-CN',
  });
}

async function openAdapterPage(context, adapter) {
  const page = context.pages()[0] ?? await context.newPage();
  await page.goto(adapter.entryUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  return page;
}

async function verifyProfileLogin({ adapter, chromeDirectory, browserExecutable }) {
  let context;
  try {
    // Login (including the post-login verification re-open) always runs in a visible browser
    // so operators can watch the flow and step in when a platform needs a manual check.
    context = await launchPersistentContext({
      chromeDirectory,
      headless: false,
      browserExecutable,
    });
    const page = await openAdapterPage(context, adapter);
    const state = await adapter.inspectLoginState(page);
    if (state.status !== 'authenticated') {
      const { waitForAuthenticated } = await import('./platforms/base.mjs');
      await waitForAuthenticated(page, 30_000);
    }
    return true;
  } finally {
    await context?.close().catch(() => undefined);
  }
}

function passwordWaitingState({ adapter, message, error = null, account = null, accountBinding = null }) {
  return {
    state: 'awaiting_password',
    stage: 'password',
    nextAction: error ? 'retry_password' : 'submit_password',
    message,
    account,
    accountBinding,
    error,
  };
}

function phoneWaitingState({ adapter, message, error = null, account = null, accountBinding = null }) {
  return {
    state: 'awaiting_phone',
    stage: 'phone',
    nextAction: error ? 'retry_phone' : 'submit_phone',
    message,
    account,
    accountBinding,
    error,
  };
}

function smsCodeWaitingState({ message, error = null }) {
  return {
    state: 'awaiting_sms_code',
    stage: 'sms_code',
    nextAction: error ? 'retry_sms_code' : 'submit_sms_code',
    message,
    error,
  };
}

function loginErrorState(error, account = null) {
  return {
    state: 'retryable_error',
    stage: 'error',
    nextAction: 'inspect_login_error',
    message: `登录操作失败：${error.message}`,
    account,
    error: { code: error.code ?? 'login_action_error', message: error.message },
  };
}
function accountRestrictedState(probe) {
  const untilText = probe?.restrictedUntilText ?? probe?.restrictedUntil ?? null;
  const message = untilText
    ? `账号当前被限制或禁言，预计 ${untilText} 后解除。`
    : '账号当前被限制或禁言，暂时无法继续登录和问答。';
  return {
    state: 'account_restricted',
    stage: 'restricted',
    nextAction: 'wait_until_restriction_lifts',
    message,
    restrictedUntil: probe?.restrictedUntil ?? null,
    restriction: {
      type: probe?.restrictionType ?? 'restricted',
      message: probe?.message ?? null,
      restrictedUntil: probe?.restrictedUntil ?? null,
      restrictedUntilText: untilText,
    },
    error: { code: 'account_restricted', message },
  };
}

async function markSubmission(profilesDirectory, sessionId, action, status, patch) {
  const updated = await setSessionState(profilesDirectory, sessionId, {
    ...patch,
    lastSubmissionAt: now(),
    lastSubmissionAction: action,
    lastSubmissionStatus: status,
  });
  await updateLoginSession(profilesDirectory, sessionId, (session) => ({
    ...updated,
    actionAttempts: (session.actionAttempts ?? 0) + 1,
  }));
  return readLoginSession(profilesDirectory, sessionId);
}

async function processCredentialCommand({
  profilesDirectory,
  sessionId,
  session,
  page,
  adapter,
  command,
}) {
  const payload = command.payload ?? {};
  if (command.action === 'cancel') return { cancelled: true };

  if (command.action === 'verify') {
    const probe = await adapter.inspectLoginState(page);
    await setSessionState(profilesDirectory, sessionId, {
      verificationAttempts: (session.verificationAttempts ?? 0) + 1,
      message: probe.status === 'authenticated'
        ? '已检测到登录，正在保存并复验登录态。'
        : probe.status === 'challenge'
          ? '平台仍要求完成安全验证，请在当前可见浏览器中完成。'
          : '尚未检测到登录完成，请继续完成当前登录步骤。',
    });
    return { handled: true };
  }

  if (command.action === 'submit-password') {
    const account = String(payload.account ?? '').trim();
    const password = String(payload.password ?? '');
    if (session.loginMethod !== 'password') {
      throw errorWithCode('This profile does not use password login.', 'login_action_not_allowed');
    }
    if (!account || !password) throw errorWithCode('Both account and password are required.', 'invalid_login_credentials');
    assertProfileAccount(session, account);
    const binding = await describeAccountBinding({
      profilesDirectory,
      platformId: session.platformId,
      profileId: session.profileId,
      account,
    });
    const identity = accountStatePatch(binding);

    await setSessionState(profilesDirectory, sessionId, {
      state: 'processing_password',
      stage: 'password',
      nextAction: 'wait_for_password_submission',
      message: accountNotice(`正在自动填写 ${adapter.label} 的账号和密码并提交。`, binding),
      ...identity,
      error: null,
    });
    try {
      const result = await adapter.submitPassword(page, { account, password });
      await page.waitForTimeout(1_800);
      const loginError = await adapter.detectLoginError(page);
      if (loginError) {
        return {
          handled: true,
          state: await markSubmission(
            profilesDirectory,
            sessionId,
            command.action,
            'rejected',
            passwordWaitingState({
              adapter,
              ...identity,
              message: `平台拒绝了本次密码登录：${loginError}。请确认账号和密码后重试。`,
              error: { code: 'login_rejected', message: loginError },
            }),
          ),
        };
      }
      return {
        handled: true,
        state: await markSubmission(
          profilesDirectory,
          sessionId,
          command.action,
          'submitted',
          {
            state: 'checking_login',
            stage: 'password',
            nextAction: 'wait_for_login_result',
            message: '账号和密码已由本地脚本自动填写并提交，正在等待平台返回登录结果。',
            ...identity,
            error: null,
            result,
          },
        ),
      };
    } catch (error) {
      return {
        handled: true,
        state: await markSubmission(
          profilesDirectory,
          sessionId,
          command.action,
          'failed',
          passwordWaitingState({
            adapter,
            ...identity,
            message: `自动填写密码登录失败：${error.message}`,
            error: { code: error.code ?? 'password_submit_failed', message: error.message },
          }),
        ),
      };
    }
  }

  if (command.action === 'submit-phone') {
    const phone = String(payload.phone ?? '').trim();
    if (session.loginMethod !== 'sms_code') {
      throw errorWithCode('This profile does not use SMS-code login.', 'login_action_not_allowed');
    }
    if (!phone) throw errorWithCode('A phone number is required.', 'invalid_phone');
    assertProfileAccount(session, phone);
    const binding = await describeAccountBinding({
      profilesDirectory,
      platformId: session.platformId,
      profileId: session.profileId,
      account: phone,
    });
    const identity = accountStatePatch(binding);

    await setSessionState(profilesDirectory, sessionId, {
      state: 'processing_phone',
      stage: 'phone',
      nextAction: 'wait_for_sms_request',
      message: accountNotice(`正在自动填写 ${adapter.label} 的手机号并请求短信验证码。`, binding),
      ...identity,
      error: null,
    });
    try {
      const result = await adapter.requestSmsCode(page, { phone });
      await page.waitForTimeout(1_800);
      const loginError = await adapter.detectLoginError(page);
      if (loginError) {
        return {
          handled: true,
          state: await markSubmission(
            profilesDirectory,
            sessionId,
            command.action,
            'rejected',
            phoneWaitingState({
              adapter,
              ...identity,
              message: `平台拒绝了本次手机号或验证码请求：${loginError}。请确认手机号后重试。`,
              error: { code: 'sms_request_rejected', message: loginError },
            }),
          ),
        };
      }
      return {
        handled: true,
        state: await markSubmission(
          profilesDirectory,
          sessionId,
          command.action,
          'submitted',
          {
            ...smsCodeWaitingState({
              message: '手机号已提交，验证码请求已触发。请把收到的短信验证码交给 Agent，由 Agent 执行 submit-code 自动填写。',
            }),
            ...identity,
            result,
          },
        ),
      };
    } catch (error) {
      return {
        handled: true,
        state: await markSubmission(
          profilesDirectory,
          sessionId,
          command.action,
          'failed',
          phoneWaitingState({
            adapter,
            ...identity,
            message: `自动填写手机号或请求验证码失败：${error.message}`,
            error: { code: error.code ?? 'sms_request_failed', message: error.message },
          }),
        ),
      };
    }
  }

  if (command.action === 'submit-code') {
    const code = String(payload.code ?? '').trim();
    if (session.loginMethod !== 'sms_code') {
      throw errorWithCode('This profile does not use SMS-code login.', 'login_action_not_allowed');
    }
    if (!code) throw errorWithCode('An SMS code is required.', 'invalid_sms_code');

    await setSessionState(profilesDirectory, sessionId, {
      state: 'processing_sms_code',
      stage: 'sms_code',
      nextAction: 'wait_for_sms_code_submission',
      message: `正在自动填写 ${adapter.label} 的短信验证码并提交。`,
      error: null,
    });
    try {
      const result = await adapter.submitSmsCode(page, { code });
      await page.waitForTimeout(1_800);
      const loginError = await adapter.detectLoginError(page);
      if (loginError) {
        return {
          handled: true,
          state: await markSubmission(
            profilesDirectory,
            sessionId,
            command.action,
            'rejected',
            smsCodeWaitingState({
              message: `平台拒绝了本次短信验证码：${loginError}。请核对验证码后重试。`,
              error: { code: 'sms_code_rejected', message: loginError },
            }),
          ),
        };
      }
      return {
        handled: true,
        state: await markSubmission(
          profilesDirectory,
          sessionId,
          command.action,
          'submitted',
          {
            state: 'checking_login',
            stage: 'sms_code',
            nextAction: 'wait_for_login_result',
            message: '短信验证码已由本地脚本自动填写并提交，正在等待平台返回登录结果。',
            error: null,
            result,
          },
        ),
      };
    } catch (error) {
      return {
        handled: true,
        state: await markSubmission(
          profilesDirectory,
          sessionId,
          command.action,
          'failed',
          smsCodeWaitingState({
            message: `自动填写短信验证码失败：${error.message}`,
            error: { code: error.code ?? 'sms_code_submit_failed', message: error.message },
          }),
        ),
      };
    }
  }

  throw errorWithCode(`Unsupported login action: ${command.action}.`, 'unsupported_login_action');
}

async function waitForInteractiveLogin({
  profilesDirectory,
  sessionId,
  page,
  adapter,
  expiresAt,
  initialSession,
}) {
  let consecutiveAuthenticated = 0;
  let session = initialSession;
  let previousProbeKey = null;
  let lastCheckWrite = 0;
  while (Date.now() < Date.parse(expiresAt)) {
    if (page.isClosed()) return { status: 'closed' };

    const command = await consumeLoginSessionCommand(profilesDirectory, sessionId);
    if (command) {
      const result = await processCredentialCommand({
        profilesDirectory,
        sessionId,
        session,
        page,
        adapter,
        command,
      });
      if (result.cancelled) return { status: 'cancelled' };
      session = await readLoginSession(profilesDirectory, sessionId);
    }

    const probe = await adapter.inspectLoginState(page);
    if (probe.status === 'restricted') return { status: 'restricted', probe };
    const probeKey = `${probe.status}:${probe.reason}`;
    if (probe.status === 'authenticated') {
      consecutiveAuthenticated += 1;
      if (consecutiveAuthenticated >= 2) return { status: 'authenticated', probe };
    } else {
      consecutiveAuthenticated = 0;
      if (probe.status === 'challenge') {
        if (session.state !== 'awaiting_human_challenge') {
          const challengeEvidence = await captureChallengeEvidence({ profilesDirectory, sessionId, page });
          session = await setSessionState(profilesDirectory, sessionId, {
            state: 'awaiting_human_challenge',
            stage: 'challenge',
            nextAction: 'complete_human_challenge_in_browser',
            message: `平台要求在可见浏览器中完成安全验证；完成后 Agent 会继续自动保存登录态。`,
            challengeEvidence,
          });
        }
      } else if (session.state === 'awaiting_human_challenge') {
        // The verification overlay disappeared (solved, dismissed, or timed out). Resume the
        // normal credential flow instead of leaving the session stuck in the challenge state.
        const recovery = session.loginMethod === 'password'
          ? passwordWaitingState({
              adapter,
              account: session.account ?? null,
              accountBinding: session.accountBinding ?? null,
              message: '安全验证已结束。请继续提交账号和密码，Agent 会自动填写并提交。',
            })
          : {
              ...smsCodeWaitingState({
                message: '安全验证已结束。请把短信验证码交给 Agent；若验证码已失效，可用 submit-phone 重新获取。',
              }),
              account: session.account ?? null,
              accountBinding: session.accountBinding ?? null,
            };
        recovery.challengeEvidence = session.challengeEvidence ?? null;
        session = await setSessionState(profilesDirectory, sessionId, recovery);
      } else if (session.state === 'checking_login') {
        const submittedAt = Date.parse(session.lastSubmissionAt ?? '');
        if (Number.isFinite(submittedAt) && Date.now() - submittedAt > 8_000) {
          const patch = session.loginMethod === 'password'
            ? passwordWaitingState({
                adapter,
                account: session.account ?? null,
                accountBinding: session.accountBinding ?? null,
                message: '平台尚未确认密码登录完成。请检查浏览器提示；如有错误，可重新提交账号和密码。',
                error: { code: 'login_not_confirmed', message: 'Password login was not confirmed.' },
              })
            : smsCodeWaitingState({
                message: '平台尚未确认短信登录完成。请检查验证码提示；如验证码错误或过期，可重新提交。',
                error: { code: 'login_not_confirmed', message: 'SMS login was not confirmed.' },
              });
          session = await setSessionState(profilesDirectory, sessionId, patch);
        }
      } else if (probeKey !== previousProbeKey && ['awaiting_password', 'awaiting_phone', 'awaiting_sms_code'].includes(session.state)) {
        previousProbeKey = probeKey;
      }
    }

    if (Date.now() - lastCheckWrite > 5_000) {
      lastCheckWrite = Date.now();
      await setSessionState(profilesDirectory, sessionId, {});
    }
    await page.waitForTimeout(600);
  }
  return { status: 'expired' };
}

async function markProfileFailure({ profilesDirectory, session, error }) {
  if (error?.code === 'account_restricted') {
    const restrictedUntil = error?.loginState?.restrictedUntil ?? null;
    await updateProfile({
      profilesDirectory,
      platformId: session.platformId,
      profileId: session.profileId,
      patch: {
        health: 'restricted',
        restrictedUntil,
        lastError: {
          at: now(),
          category: 'account_restricted',
          message: String(error?.message ?? error),
          ...(restrictedUntil ? { restrictedUntil } : {}),
        },
      },
    }).catch(() => undefined);
    return;
  }
  const loginRequired = ['login_required', 'human_challenge'].includes(error?.code)
    || /login|\u767b\u5f55|\u9a8c\u8bc1\u7801|challenge|chat input/iu.test(String(error?.message ?? error));
  await updateProfile({
    profilesDirectory,
    platformId: session.platformId,
    profileId: session.profileId,
    patch: {
      health: loginRequired ? 'expired' : 'error',
      lastError: {
        at: now(),
        category: loginRequired ? 'login_required' : 'login_error',
        message: String(error?.message ?? error),
      },
    },
  }).catch(() => undefined);
}

export async function runLoginSession({ profilesDirectory, sessionId, browserExecutable = null } = {}) {
  profilesDirectory = path.resolve(profilesDirectory);
  let session = await readLoginSession(profilesDirectory, sessionId);
  const adapter = getPlatformAdapter(session.platformId);
  let lock = null;
  let context = null;

  try {
    await setSessionState(profilesDirectory, sessionId, {
      state: 'starting_browser',
      stage: 'start',
      nextAction: 'wait_for_browser',
      message: '正在启动可见浏览器并打开平台登录页。',
      startedAt: now(),
      brokerPid: process.pid,
      error: null,
    });
    lock = await acquireProfileLock({
      profilesDirectory,
      platformId: session.platformId,
      profileId: session.profileId,
      ownerType: 'login',
      ownerId: sessionId,
    });
    session = await setSessionState(profilesDirectory, sessionId, { lock: { ownerId: sessionId, acquired: true } });

    try {
      context = await launchPersistentContext({
        chromeDirectory: session.staging.chromeDirectory,
        headless: false,
        browserExecutable: browserExecutable ?? session.browserExecutable,
      });
    } catch (error) {
      if (isLikelyProfileLock(error)) error.code = 'profile_locked';
      throw error;
    }

    const page = await openAdapterPage(context, adapter);
    const prepared = await adapter.prepareLogin(page).catch((error) => ({
      prepared: false,
      state: { status: 'unknown', reason: error.message },
    }));

    if (prepared.state?.status === 'authenticated') {
      session = await setSessionState(profilesDirectory, sessionId, {
        state: 'verifying',
        stage: 'verify',
        nextAction: 'wait_for_profile_verification',
        message: '该登录态当前已登录，正在重新打开并复验。',
      });
    } else if (prepared.state?.status === 'challenge') {
      session = await setSessionState(profilesDirectory, sessionId, {
        state: 'awaiting_human_challenge',
        stage: 'challenge',
        nextAction: 'complete_human_challenge_in_browser',
        message: `请在当前可见浏览器中完成 ${adapter.label} 安全验证；完成后 Agent 会继续保存登录态。`,
      });
    } else if (prepared.state?.status === 'restricted') {
      session = await setSessionState(profilesDirectory, sessionId, accountRestrictedState(prepared.state));
    } else if (adapter.loginMethod === 'password') {
      session = await setSessionState(profilesDirectory, sessionId, passwordWaitingState({
        adapter,
        message: `可见浏览器已打开 ${adapter.label} 密码登录页。请把账号和密码交给 Agent，由 Agent 执行 login.mjs submit-password 自动填写，无需手动操作页面。`,
      }));
    } else {
      session = await setSessionState(profilesDirectory, sessionId, phoneWaitingState({
        adapter,
        message: `可见浏览器已打开 ${adapter.label} 手机号登录页。请把手机号交给 Agent，由 Agent 执行 login.mjs submit-phone 自动填写并点击获取验证码。`,
      }));
    }

    let outcome;
    if (prepared.state?.status === 'authenticated') {
      outcome = { status: 'authenticated', probe: prepared.state };
    } else if (prepared.state?.status === 'restricted') {
      outcome = { status: 'restricted', probe: prepared.state };
    } else {
      outcome = await waitForInteractiveLogin({
        profilesDirectory,
        sessionId,
        page,
        adapter,
        expiresAt: session.expiresAt,
        initialSession: session,
      });
    }

    if (outcome.status === 'cancelled') {
      await setSessionState(profilesDirectory, sessionId, {
        state: 'cancelled', stage: 'cancelled', nextAction: 'start_new_session', endedAt: now(), message: '登录会话已取消。',
      });
      return readLoginSession(profilesDirectory, sessionId);
    }
    if (outcome.status === 'closed') {
      await setSessionState(profilesDirectory, sessionId, {
        state: 'cancelled', stage: 'closed', nextAction: 'start_new_session', endedAt: now(), message: '浏览器在登录完成前被关闭，请重新开始登录。',
      });
      return readLoginSession(profilesDirectory, sessionId);
    }
    if (outcome.status === 'expired') {
      await setSessionState(profilesDirectory, sessionId, {
        state: 'expired', stage: 'expired', nextAction: 'start_new_session', endedAt: now(), message: '登录会话已超时，请重新开始。',
      });
      return readLoginSession(profilesDirectory, sessionId);
    }
    if (outcome.status === 'restricted') {
      const restricted = accountRestrictedState(outcome.probe);
      session = await setSessionState(profilesDirectory, sessionId, {
        ...restricted,
        endedAt: now(),
      });
      await updateProfile({
        profilesDirectory,
        platformId: session.platformId,
        profileId: session.profileId,
        patch: {
          health: 'restricted',
          restrictedUntil: restricted.restrictedUntil,
          lastError: { at: now(), category: 'account_restricted', message: restricted.message, ...(restricted.restrictedUntil ? { restrictedUntil: restricted.restrictedUntil } : {}) },
        },
      }).catch(() => undefined);
      return readLoginSession(profilesDirectory, sessionId);
    }

    session = await setSessionState(profilesDirectory, sessionId, {
      state: 'verifying',
      stage: 'verify',
      nextAction: 'wait_for_profile_verification',
      message: '已检测到登录，正在关闭并用同一登录态重新打开验证。',
    });
    const { waitForAuthenticated } = await import('./platforms/base.mjs');
    await waitForAuthenticated(page, 15_000);
    await context.close();
    context = null;

    session = await setSessionState(profilesDirectory, sessionId, {
      state: 'saving',
      stage: 'save',
      nextAction: 'wait_for_profile_save',
      message: '正在保存登录态并重新验证聊天界面。',
    });
    const chromeDirectory = session.staging.enabled
      ? await moveLoginStaging(profilesDirectory, session)
      : session.staging.chromeDirectory;
    await verifyProfileLogin({
      adapter,
      chromeDirectory,
      browserExecutable: browserExecutable ?? session.browserExecutable,
    });

    const completedAt = now();
    await updateProfile({
      profilesDirectory,
      platformId: session.platformId,
      profileId: session.profileId,
      patch: {
        loginMethod: session.loginMethod,
        ...(session.account ? { account: session.account } : {}),
        health: 'ready',
        lastLoginAt: completedAt,
        lastVerifiedAt: completedAt,
        lastError: null,
      },
    });
    await updateLoginSession(profilesDirectory, sessionId, (current) => ({
      ...current,
      state: 'completed',
      stage: 'completed',
      nextAction: 'none',
      endedAt: completedAt,
      lastCheckedAt: completedAt,
      message: '登录成功，登录态已经保存并通过重新打开验证。',
      accountBinding: {
        ...(current.accountBinding ?? {}),
        status: 'bound_to_current',
        decisionRequired: false,
        currentProfileId: current.profileId,
        existingProfiles: [
          ...(current.accountBinding?.existingProfiles ?? []).filter((entry) => entry.profileId !== current.profileId),
          {
            platformId: current.platformId,
            profileId: current.profileId,
            account: current.account ?? null,
            health: 'ready',
            lastLoginAt: completedAt,
          },
        ],
        message: `该账号已绑定到当前 Profile ${current.platformId}:${current.profileId}。`,
      },
      staging: { ...current.staging, chromeDirectory },
      error: null,
    }));
    return readLoginSession(profilesDirectory, sessionId);
  } catch (error) {
    const state = 'failed';
    await setSessionState(profilesDirectory, sessionId, {
      state,
      stage: 'failed',
      nextAction: error?.code === 'profile_locked' ? 'wait_for_lock_release' : 'start_new_session',
      endedAt: now(),
      message: error?.code === 'profile_locked'
        ? '该登录态正在被其它浏览器或监控任务使用，请关闭占用后重试。'
        : `登录未完成：${error.message}`,
      error: {
        code: error?.code ?? 'login_error',
        message: String(error?.message ?? error),
      },
    }).catch(() => undefined);
    await markProfileFailure({ profilesDirectory, session, error });
    return readLoginSession(profilesDirectory, sessionId);
  } finally {
    await clearLoginSessionControl(profilesDirectory, sessionId).catch(() => undefined);
    await context?.close().catch(() => undefined);
    if (context) await cleanupLoginStaging(profilesDirectory, session).catch(() => undefined);
    const finalSession = await readLoginSession(profilesDirectory, sessionId).catch(() => session);
    if (['failed', 'cancelled', 'expired'].includes(finalSession.state)) {
      await cleanupLoginStaging(profilesDirectory, finalSession).catch(() => undefined);
    }
    await lock?.release();
  }
}

export { verifyProfileLogin };