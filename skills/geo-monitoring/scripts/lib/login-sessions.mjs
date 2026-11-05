import crypto from 'node:crypto';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { projectAccountBinding } from './account-identity.mjs';
import { pathExists, readJsonFile, removePathWithin, writeJsonFile } from './fs.mjs';
import { isProcessAlive } from './profile-lock.mjs';
import { requireProfile } from './profiles.mjs';

export const LOGIN_SESSION_TIMEOUT_MS = 20 * 60 * 1_000;
export const LOGIN_SESSION_RETENTION_MS = 24 * 60 * 60 * 1_000;
export const LOGIN_ORPHAN_GRACE_MS = 60 * 60 * 1_000;
export const LOGIN_SESSION_TERMINAL_STATES = Object.freeze(['completed', 'failed', 'cancelled', 'expired', 'account_restricted']);
const USER_ACTION_NEXT_ACTIONS = new Set([
  'submit_password',
  'retry_password',
  'submit_phone',
  'retry_phone',
  'submit_sms_code',
  'retry_sms_code',
  'complete_human_challenge_in_browser',
]);

export function loginSessionId(now = new Date()) {
  const timestamp = now.toISOString().replace(/[-:]/gu, '').replace(/\.\d{3}Z$/u, '');
  return `login_${timestamp}_${crypto.randomBytes(3).toString('hex')}`;
}

export function loginSessionPaths(profilesDirectory, sessionId) {
  const root = path.resolve(profilesDirectory);
  const sessionDirectory = path.join(root, '.sessions');
  const stagingRoot = path.join(root, '.staging', sessionId);
  return {
    root,
    sessionDirectory,
    sessionFile: path.join(sessionDirectory, `${sessionId}.json`),
    controlFile: path.join(sessionDirectory, `${sessionId}.control.json`),
    evidenceDirectory: path.join(sessionDirectory, `${sessionId}-evidence`),
    stagingRoot,
    stagingChrome: path.join(stagingRoot, 'chrome'),
  };
}

export async function createLoginSession({ profilesDirectory, platformId, profileId, browserExecutable = null } = {}) {
  const profile = await requireProfile({ profilesDirectory, platformId, profileId });
  const sessionId = loginSessionId();
  const paths = loginSessionPaths(profilesDirectory, sessionId);
  const stagingEnabled = !await pathExists(profile.paths.chromeDirectory);
  const chromeDirectory = stagingEnabled ? paths.stagingChrome : profile.paths.chromeDirectory;
  const now = Date.now();
  const session = {
    version: 1,
    sessionId,
    platformId: profile.platformId,
    profileId: profile.profileId,
    account: profile.account ?? null,
    loginMethod: profile.loginMethod,
    state: 'created',
    stage: 'start',
    nextAction: 'start',
    message: 'Login session created.',
    accountBinding: null,
    lastSubmissionAt: null,
    lastSubmissionAction: null,
    lastSubmissionStatus: null,
    actionAttempts: 0,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + LOGIN_SESSION_TIMEOUT_MS).toISOString(),
    startedAt: null,
    endedAt: null,
    lastCheckedAt: null,
    verificationAttempts: 0,
    brokerPid: null,
    staging: {
      enabled: stagingEnabled,
      chromeDirectory,
      targetDirectory: profile.paths.chromeDirectory,
    },
    lock: {
      ownerId: sessionId,
      acquired: false,
    },
    browserExecutable: browserExecutable ? path.resolve(browserExecutable) : null,
    error: null,
  };
  await mkdir(paths.sessionDirectory, { recursive: true, mode: 0o700 });
  await writeJsonFile(paths.sessionFile, session);
  await writeJsonFile(paths.controlFile, { version: 1, action: null, payload: null, requestedAt: null });
  return session;
}

export async function readLoginSession(profilesDirectory, sessionId) {
  const paths = loginSessionPaths(profilesDirectory, sessionId);
  try {
    return await readJsonFile(paths.sessionFile);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    const notFound = new Error(`Login session not found: ${sessionId}.`);
    notFound.code = 'login_session_not_found';
    throw notFound;
  }
}

export async function writeLoginSession(profilesDirectory, session) {
  const paths = loginSessionPaths(profilesDirectory, session.sessionId);
  await writeJsonFile(paths.sessionFile, session);
  return session;
}

export async function updateLoginSession(profilesDirectory, sessionId, updater) {
  const session = await readLoginSession(profilesDirectory, sessionId);
  const next = await updater(session);
  return writeLoginSession(profilesDirectory, next ?? session);
}

export async function requestLoginSessionAction(profilesDirectory, sessionId, action, payload = null) {
  const session = await readLoginSession(profilesDirectory, sessionId);
  if (LOGIN_SESSION_TERMINAL_STATES.includes(session.state)) return session;
  const paths = loginSessionPaths(profilesDirectory, sessionId);
  await writeJsonFile(paths.controlFile, {
    version: 1,
    action,
    payload: payload && typeof payload === 'object' ? payload : null,
    requestedAt: new Date().toISOString(),
  });
  return session;
}

export async function consumeLoginSessionCommand(profilesDirectory, sessionId) {
  const paths = loginSessionPaths(profilesDirectory, sessionId);
  let control;
  try {
    control = await readJsonFile(paths.controlFile);
  } catch {
    return null;
  }
  if (!control.action) return null;
  await writeJsonFile(paths.controlFile, { version: 1, action: null, payload: null, requestedAt: null });
  return {
    action: String(control.action),
    payload: control.payload && typeof control.payload === 'object' ? control.payload : null,
    requestedAt: control.requestedAt ?? null,
  };
}

export async function consumeLoginSessionAction(profilesDirectory, sessionId) {
  const command = await consumeLoginSessionCommand(profilesDirectory, sessionId);
  return command?.action ?? null;
}

export async function clearLoginSessionControl(profilesDirectory, sessionId) {
  const paths = loginSessionPaths(profilesDirectory, sessionId);
  await writeJsonFile(paths.controlFile, { version: 1, action: null, payload: null, requestedAt: null });
}

export async function listLoginSessions(profilesDirectory) {
  const paths = loginSessionPaths(profilesDirectory, 'placeholder');
  if (!await pathExists(paths.sessionDirectory)) return [];
  const entries = await readdir(paths.sessionDirectory, { withFileTypes: true });
  const sessions = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json') || entry.name.endsWith('.control.json')) continue;
    try {
      sessions.push(await readJsonFile(path.join(paths.sessionDirectory, entry.name)));
    } catch {
      // Ignore incomplete or corrupt session records.
    }
  }
  return sessions.sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
}

export function projectLoginSession(session, extra = {}) {
  const state = session.state;
  const nextAction = session.nextAction ?? null;
  return {
    ...(extra && typeof extra === 'object' ? extra : {}),
    version: 1,
    sessionId: session.sessionId,
    platform: session.platformId,
    profile: session.profileId,
    platformId: session.platformId,
    profileId: session.profileId,
    account: session.account ?? null,
    loginMethod: session.loginMethod,
    loginMethodLabel: session.loginMethod === 'password' ? '密码登录' : '短信验证码登录',
    state,
    status: state,
    stage: session.stage ?? null,
    nextAction,
    message: session.message ?? null,
    ok: state === 'completed',
    terminal: LOGIN_SESSION_TERMINAL_STATES.includes(state),
    requiresUserAction: USER_ACTION_NEXT_ACTIONS.has(nextAction),
    accountBinding: projectAccountBinding(session.accountBinding),
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
    startedAt: session.startedAt ?? null,
    endedAt: session.endedAt ?? null,
    restrictedUntil: session.restrictedUntil ?? null,
    restriction: session.restriction ?? null,
    lastCheckedAt: session.lastCheckedAt ?? null,
    lastSubmissionAt: session.lastSubmissionAt ?? null,
    lastSubmissionAction: session.lastSubmissionAction ?? null,
    lastSubmissionStatus: session.lastSubmissionStatus ?? null,
    actionAttempts: session.actionAttempts ?? 0,
    verificationAttempts: session.verificationAttempts ?? 0,
    error: session.error ?? null,
  };
}

function timestamp(value) {
  const parsed = Date.parse(value ?? '');
  return Number.isFinite(parsed) ? parsed : null;
}

export function loginSessionCleanupReason(session, {
  now = Date.now(),
  terminalRetentionMs = LOGIN_SESSION_RETENTION_MS,
  processAlive = isProcessAlive,
} = {}) {
  if (!session || typeof session !== 'object') return 'invalid_session';
  if (processAlive(Number(session.brokerPid))) return null;

  if (LOGIN_SESSION_TERMINAL_STATES.includes(session.state)) {
    const endedAt = timestamp(session.endedAt ?? session.createdAt);
    if (endedAt !== null && now - endedAt >= terminalRetentionMs) return 'terminal_retention';
    return null;
  }

  const expiresAt = timestamp(session.expiresAt);
  if (expiresAt !== null && expiresAt <= now) return 'expired_inactive';
  return null;
}

async function pathOlderThan(targetPath, now, minimumAgeMs) {
  try {
    const info = await stat(targetPath);
    return now - info.mtimeMs >= minimumAgeMs;
  } catch {
    return false;
  }
}

async function removeIfExists(root, targetPath, dryRun) {
  if (!await pathExists(targetPath)) return false;
  if (!dryRun) await removePathWithin(root, targetPath);
  return true;
}

async function readDirectorySafe(directory) {
  try {
    return await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

export async function cleanupLoginSessions(profilesDirectory, {
  now = Date.now(),
  terminalRetentionMs = LOGIN_SESSION_RETENTION_MS,
  orphanGraceMs = LOGIN_ORPHAN_GRACE_MS,
  processAlive = isProcessAlive,
  dryRun = false,
} = {}) {
  const root = path.resolve(profilesDirectory);
  const paths = loginSessionPaths(root, 'placeholder');
  const summary = {
    dryRun: Boolean(dryRun),
    checkedSessions: 0,
    removedSessions: 0,
    removedControls: 0,
    removedEvidenceDirectories: 0,
    removedStagingDirectories: 0,
    removedCorruptSessions: 0,
    skippedActive: 0,
    errors: [],
  };

  const entries = await readDirectorySafe(paths.sessionDirectory);
  const sessions = new Map();

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json') || entry.name.endsWith('.control.json')) continue;
    const sessionPath = path.join(paths.sessionDirectory, entry.name);
    try {
      const session = await readJsonFile(sessionPath);
      const sessionId = String(session.sessionId || entry.name.slice(0, -'.json'.length));
      sessions.set(sessionId, session);
    } catch (error) {
      if (await pathOlderThan(sessionPath, now, orphanGraceMs)) {
        try {
          if (await removeIfExists(root, sessionPath, dryRun)) summary.removedCorruptSessions += 1;
        } catch (removeError) {
          summary.errors.push({ path: sessionPath, message: String(removeError?.message ?? removeError) });
        }
      }
    }
  }

  for (const [sessionId, session] of sessions) {
    summary.checkedSessions += 1;
    const reason = loginSessionCleanupReason(session, { now, terminalRetentionMs, processAlive });
    if (!reason) {
      summary.skippedActive += 1;
      continue;
    }

    const sessionPaths = loginSessionPaths(root, sessionId);
    try {
      if (await removeIfExists(root, sessionPaths.sessionFile, dryRun)) summary.removedSessions += 1;
      if (await removeIfExists(root, sessionPaths.controlFile, dryRun)) summary.removedControls += 1;
      if (await removeIfExists(root, sessionPaths.evidenceDirectory, dryRun)) summary.removedEvidenceDirectories += 1;
      if (await removeIfExists(root, sessionPaths.stagingRoot, dryRun)) summary.removedStagingDirectories += 1;
    } catch (error) {
      summary.errors.push({ sessionId, message: String(error?.message ?? error) });
      summary.skippedActive += 1;
    }
  }

  const activeSessionIds = new Set();
  for (const [sessionId, session] of sessions) {
    if (!loginSessionCleanupReason(session, { now, terminalRetentionMs, processAlive })) activeSessionIds.add(sessionId);
  }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.control.json')) continue;
    const sessionId = entry.name.slice(0, -'.control.json'.length);
    if (activeSessionIds.has(sessionId)) continue;
    const targetPath = path.join(paths.sessionDirectory, entry.name);
    if (!await pathOlderThan(targetPath, now, orphanGraceMs)) continue;
    try {
      if (await removeIfExists(root, targetPath, dryRun)) summary.removedControls += 1;
    } catch (error) {
      summary.errors.push({ path: targetPath, message: String(error?.message ?? error) });
    }
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.endsWith('-evidence')) continue;
    const sessionId = entry.name.slice(0, -'-evidence'.length);
    if (activeSessionIds.has(sessionId)) continue;
    const targetPath = path.join(paths.sessionDirectory, entry.name);
    if (!await pathOlderThan(targetPath, now, orphanGraceMs)) continue;
    try {
      if (await removeIfExists(root, targetPath, dryRun)) summary.removedEvidenceDirectories += 1;
    } catch (error) {
      summary.errors.push({ path: targetPath, message: String(error?.message ?? error) });
    }
  }

  const stagingEntries = await readDirectorySafe(path.join(root, '.staging'));
  for (const entry of stagingEntries) {
    if (!entry.isDirectory() || activeSessionIds.has(entry.name)) continue;
    const targetPath = path.join(root, '.staging', entry.name);
    if (!await pathOlderThan(targetPath, now, orphanGraceMs)) continue;
    try {
      if (await removeIfExists(root, targetPath, dryRun)) summary.removedStagingDirectories += 1;
    } catch (error) {
      summary.errors.push({ path: targetPath, message: String(error?.message ?? error) });
    }
  }

  return summary;
}

export async function cleanupLoginStaging(profilesDirectory, session) {
  if (!session.staging?.enabled) return;
  const paths = loginSessionPaths(profilesDirectory, session.sessionId);
  await removePathWithin(paths.root, paths.stagingRoot).catch(() => undefined);
}

export async function moveLoginStaging(profilesDirectory, session) {
  if (!session.staging?.enabled) return session.staging.targetDirectory;
  const paths = loginSessionPaths(profilesDirectory, session.sessionId);
  if (!await pathExists(paths.stagingChrome)) throw new Error('Staged browser profile was not created.');
  await mkdir(path.dirname(session.staging.targetDirectory), { recursive: true, mode: 0o700 });
  await rename(paths.stagingChrome, session.staging.targetDirectory);
  await rm(paths.stagingRoot, { recursive: true, force: true }).catch(() => undefined);
  return session.staging.targetDirectory;
}