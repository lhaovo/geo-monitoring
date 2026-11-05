import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { option, parseArgs, required } from './lib/cli.mjs';
import {
  cleanupLoginSessions,
  createLoginSession,
  listLoginSessions,
  LOGIN_ORPHAN_GRACE_MS,
  LOGIN_SESSION_RETENTION_MS,
  projectLoginSession,
  readLoginSession,
  requestLoginSessionAction,
} from './lib/login-sessions.mjs';
import { TERMINAL_LOGIN_STATES } from './lib/login-runner.mjs';
import { isProcessAlive } from './lib/profile-lock.mjs';

const brokerScript = path.join(path.dirname(fileURLToPath(import.meta.url)), 'login-broker.mjs');
const WAITING_STATES = new Set([
  'awaiting_password',
  'awaiting_phone',
  'awaiting_sms_code',
  'awaiting_human_challenge',
  'retryable_error',
]);

function sleep(timeoutMs) {
  return new Promise((resolve) => setTimeout(resolve, timeoutMs));
}

async function waitForSession(profilesDirectory, sessionId, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let session = await readLoginSession(profilesDirectory, sessionId);
  while (Date.now() < deadline) {
    if (predicate(session)) return session;
    await sleep(500);
    session = await readLoginSession(profilesDirectory, sessionId);
  }
  return session;
}

function spawnBroker({ profilesDirectory, sessionId }) {
  const child = spawn(process.execPath, [brokerScript, '--profiles', profilesDirectory, '--session', sessionId], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  return child.pid;
}

function output(value, exitCode = 0) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  if (exitCode) process.exitCode = exitCode;
}

function profilesDirectoryFrom(options) {
  return path.resolve(option(options, 'profiles', path.join(process.cwd(), 'profiles')));
}

function numberOption(options, key, fallback) {
  const value = option(options, key);
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error(`--${key} must be a non-negative number.`);
  return number;
}

function isTerminal(session) {
  return TERMINAL_LOGIN_STATES.includes(session.state);
}

function submissionProcessed(initial, candidate, action) {
  return candidate.lastSubmissionAction === action
    && Boolean(candidate.lastSubmissionAt)
    && candidate.lastSubmissionAt !== initial.lastSubmissionAt;
}

const IN_FLIGHT_STATES = ['processing_password', 'processing_phone', 'processing_sms_code', 'checking_login'];

function submissionFinished(initial, candidate, action) {
  if (isTerminal(candidate)) return true;
  if (!submissionProcessed(initial, candidate, action)) return false;
  if (action === 'submit-phone') return !IN_FLIGHT_STATES.includes(candidate.state);
  if (action === 'submit-password') return !IN_FLIGHT_STATES.includes(candidate.state);
  if (action === 'submit-code') return !IN_FLIGHT_STATES.includes(candidate.state);
  return false;
}

async function startCommand(options, profilesDirectory) {
  const platformId = required(options, 'platform');
  const profileId = required(options, 'profile');
  await cleanupLoginSessions(profilesDirectory).catch(() => undefined);
  const session = await createLoginSession({
    profilesDirectory,
    platformId,
    profileId,
    browserExecutable: option(options, 'browser'),
  });
  const brokerPid = spawnBroker({ profilesDirectory, sessionId: session.sessionId });
  const current = await waitForSession(
    profilesDirectory,
    session.sessionId,
    (candidate) => WAITING_STATES.has(candidate.state) || isTerminal(candidate),
    Number(option(options, 'wait-ms', 30_000)),
  );
  const failed = isTerminal(current.state) && current.state !== 'completed';
  return output(projectLoginSession(current, { brokerPid }), failed ? 1 : 0);
}

async function statusCommand(options, profilesDirectory) {
  const current = await readLoginSession(profilesDirectory, required(options, 'session'));
  return output(projectLoginSession(current));
}

async function verifyCommand(options, profilesDirectory) {
  const sessionId = required(options, 'session');
  const initial = await requestLoginSessionAction(profilesDirectory, sessionId, 'verify');
  const current = await waitForSession(
    profilesDirectory,
    sessionId,
    (candidate) => isTerminal(candidate) || candidate.verificationAttempts > (initial.verificationAttempts ?? 0),
    Number(option(options, 'wait-ms', 90_000)),
  );
  const failed = !current.ok;
  const timedOut = !isTerminal(current.state) && current.verificationAttempts <= (initial.verificationAttempts ?? 0);
  return output(projectLoginSession(current, { timedOut }), failed || timedOut ? 1 : 0);
}

async function submitCommand(options, profilesDirectory, kind) {
  const sessionId = required(options, 'session');
  const initial = await readLoginSession(profilesDirectory, sessionId);
  const expectedStates = {
    'submit-password': ['awaiting_password', 'retryable_error'],
    // submit-phone doubles as "resend code" once a verification code was already requested.
    'submit-phone': ['awaiting_phone', 'awaiting_sms_code', 'awaiting_human_challenge', 'retryable_error'],
    'submit-code': ['awaiting_sms_code', 'awaiting_human_challenge', 'retryable_error'],
  }[kind];
  const actions = {
    'submit-password': 'submit-password',
    'submit-phone': 'submit-phone',
    'submit-code': 'submit-code',
  };
  if (!expectedStates.includes(initial.state)) {
    const error = new Error(`Action ${kind} is not valid while login session is ${initial.state}; expected ${expectedStates.join(' or ')}.`);
    error.code = 'login_action_not_allowed';
    throw error;
  }

  let payload;
  if (kind === 'submit-password') {
    payload = { account: required(options, 'account'), password: required(options, 'password') };
  } else if (kind === 'submit-phone') {
    payload = { phone: required(options, 'phone') };
  } else {
    payload = { code: required(options, 'code') };
  }
  const action = actions[kind];
  await requestLoginSessionAction(profilesDirectory, sessionId, action, payload);
  const current = await waitForSession(
    profilesDirectory,
    sessionId,
    (candidate) => submissionFinished(initial, candidate, action),
    Number(option(options, 'wait-ms', kind === 'submit-phone' ? 45_000 : 150_000)),
  );
  const timedOut = !submissionFinished(initial, current, action);
  const failed = isTerminal(current) && current.state !== 'completed';
  return output(projectLoginSession(current, { timedOut }), failed || timedOut ? 1 : 0);
}

async function cancelCommand(options, profilesDirectory) {
  const sessionId = required(options, 'session');
  const initial = await requestLoginSessionAction(profilesDirectory, sessionId, 'cancel');
  let current = await waitForSession(
    profilesDirectory,
    sessionId,
    (candidate) => isTerminal(candidate),
    Number(option(options, 'wait-ms', 15_000)),
  );
  if (!isTerminal(current) && Number.isInteger(current.brokerPid) && isProcessAlive(current.brokerPid)) {
    try { process.kill(current.brokerPid, 'SIGTERM'); } catch { /* The broker may have exited. */ }
    current = await waitForSession(
      profilesDirectory,
      sessionId,
      (candidate) => isTerminal(candidate),
      5_000,
    );
  }
  return output(projectLoginSession(current, { previousState: initial.state }));
}

async function sessionsCommand(options, profilesDirectory) {
  const sessions = await listLoginSessions(profilesDirectory);
  return output({ sessions: sessions.map((session) => projectLoginSession(session)) });
}

async function cleanupCommand(options, profilesDirectory) {
  const cleanup = await cleanupLoginSessions(profilesDirectory, {
    terminalRetentionMs: numberOption(options, 'terminal-retention-ms', LOGIN_SESSION_RETENTION_MS),
    orphanGraceMs: numberOption(options, 'orphan-grace-ms', LOGIN_ORPHAN_GRACE_MS),
    dryRun: option(options, 'dry-run', false) === true,
  });
  return output({
    command: 'cleanup',
    message: cleanup.dryRun ? '已检查可清理的登录会话。' : '登录会话清理完成。',
    cleanup,
  }, cleanup.errors.length > 0 ? 1 : 0);
}

async function main() {
  const { options, positional } = parseArgs();
  const command = positional[0] ?? (option(options, 'help') ? 'help' : null);
  const profilesDirectory = profilesDirectoryFrom(options);
  if (!command || command === 'help') {
    return output({
      usage: 'node scripts/login.mjs <start|status|submit-password|submit-phone|submit-code|verify|cancel|sessions|cleanup> [options]',
      commands: {
        start: '--platform <id> --profile <profile-id> [--profiles <dir>] [--browser <path>]',
        status: '--session <id> [--profiles <dir>]',
        'submit-password': '--session <id> --account <account> --password <password> [--profiles <dir>] [--wait-ms <ms>]',
        'submit-phone': '--session <id> --phone <phone> [--profiles <dir>] [--wait-ms <ms>]',
        'submit-code': '--session <id> --code <code> [--profiles <dir>] [--wait-ms <ms>]',
        verify: '--session <id> [--profiles <dir>] [--wait-ms <ms>]',
        cancel: '--session <id> [--profiles <dir>]',
        sessions: '[--profiles <dir>]',
        cleanup: '[--dry-run] [--terminal-retention-ms <ms>] [--orphan-grace-ms <ms>] [--profiles <dir>]',
      },
      note: 'Credentials are passed only to the local browser automation process and are not written into profile metadata.',
    });
  }
  if (command === 'start') return startCommand(options, profilesDirectory);
  if (command === 'status') return statusCommand(options, profilesDirectory);
  if (command === 'submit-password') return submitCommand(options, profilesDirectory, command);
  if (command === 'submit-phone') return submitCommand(options, profilesDirectory, command);
  if (command === 'submit-code') return submitCommand(options, profilesDirectory, command);
  if (command === 'verify') return verifyCommand(options, profilesDirectory);
  if (command === 'cancel') return cancelCommand(options, profilesDirectory);
  if (command === 'sessions') return sessionsCommand(options, profilesDirectory);
  if (command === 'cleanup') return cleanupCommand(options, profilesDirectory);
  throw new Error(`Unknown login command: ${command}.`);
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ error: { code: error.code ?? 'login_error', message: error.message } })}\n`);
  process.exitCode = 1;
});