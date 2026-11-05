import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathExists } from '../scripts/lib/fs.mjs';
import {
  cleanupLoginSessions,
  consumeLoginSessionAction,
  consumeLoginSessionCommand,
  createLoginSession,
  loginSessionPaths,
  projectLoginSession,
  readLoginSession,
  requestLoginSessionAction,
  updateLoginSession,
} from '../scripts/lib/login-sessions.mjs';
import { createProfile } from '../scripts/lib/profiles.mjs';

test('creates a login session that stores profile metadata but no credentials', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'geo-login-session-'));
  try {
    await createProfile({ profilesDirectory: root, platformId: 'qwen', profileId: 'work', account: '13220602153' });
    const session = await createLoginSession({ profilesDirectory: root, platformId: 'qwen', profileId: 'work' });
    assert.equal(session.state, 'created');
    assert.equal(session.staging.enabled, true);
    assert.equal(session.loginMethod, 'sms_code');
    assert.equal(JSON.stringify(session).includes('password'), false);
    await requestLoginSessionAction(root, session.sessionId, 'verify');
    assert.equal(await consumeLoginSessionAction(root, session.sessionId), 'verify');
    assert.equal((await readLoginSession(root, session.sessionId)).sessionId, session.sessionId);

    const projected = projectLoginSession(session);
    assert.equal(projected.sessionId, session.sessionId);
    assert.equal(projected.platform, 'qwen');
    assert.equal(projected.profile, 'work');
    assert.equal(projected.state, 'created');
    assert.equal(projected.nextAction, 'start');
    assert.equal(projected.requiresUserAction, false);
    assert.ok(projected.message);
    assert.equal(
      projectLoginSession({ ...session, state: 'awaiting_password', nextAction: 'submit_password' }).requiresUserAction,
      true,
    );
    assert.equal(
      projectLoginSession({ ...session, state: 'starting_browser', nextAction: 'wait_for_browser' }).requiresUserAction,
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('consumes credential payload once and keeps it out of session metadata', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'geo-login-command-'));
  try {
    await createProfile({ profilesDirectory: root, platformId: 'deepseek', profileId: 'work', account: '13220602153' });
    const session = await createLoginSession({ profilesDirectory: root, platformId: 'deepseek', profileId: 'work' });
    await requestLoginSessionAction(root, session.sessionId, 'submit-password', {
      account: 'user@example.com',
      password: 'local-test-secret',
    });
    const command = await consumeLoginSessionCommand(root, session.sessionId);
    assert.equal(command.action, 'submit-password');
    assert.deepEqual(command.payload, {
      account: 'user@example.com',
      password: 'local-test-secret',
    });
    assert.equal(await consumeLoginSessionCommand(root, session.sessionId), null);
    const stored = await readLoginSession(root, session.sessionId);
    assert.equal(JSON.stringify(stored).includes('local-test-secret'), false);
    assert.equal(JSON.stringify(stored).includes('user@example.com'), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('keeps active login sessions and their staging directories during cleanup', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'geo-login-cleanup-active-'));
  try {
    await createProfile({ profilesDirectory: root, platformId: 'kimi', profileId: 'work', account: '13220602153' });
    const session = await createLoginSession({ profilesDirectory: root, platformId: 'kimi', profileId: 'work' });
    const paths = loginSessionPaths(root, session.sessionId);
    await mkdir(paths.stagingChrome, { recursive: true });
    await writeFile(path.join(paths.stagingChrome, 'active.txt'), 'active', 'utf8');

    const summary = await cleanupLoginSessions(root, {
      terminalRetentionMs: 0,
      orphanGraceMs: 0,
    });
    assert.equal(summary.removedSessions, 0);
    assert.equal(summary.skippedActive, 1);
    assert.equal(await pathExists(paths.sessionFile), true);
    assert.equal(await pathExists(paths.stagingChrome), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('removes expired inactive login sessions, controls, evidence, and staging', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'geo-login-cleanup-expired-'));
  try {
    await createProfile({ profilesDirectory: root, platformId: 'kimi', profileId: 'work', account: '13220602153' });
    const created = await createLoginSession({ profilesDirectory: root, platformId: 'kimi', profileId: 'work' });
    const session = await updateLoginSession(root, created.sessionId, (current) => ({
      ...current,
      state: 'awaiting_phone',
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
    }));
    const paths = loginSessionPaths(root, session.sessionId);
    await mkdir(paths.stagingChrome, { recursive: true });
    await mkdir(paths.evidenceDirectory, { recursive: true });
    await writeFile(path.join(paths.stagingChrome, 'expired.txt'), 'expired', 'utf8');

    const summary = await cleanupLoginSessions(root, { orphanGraceMs: 0 });
    assert.equal(summary.removedSessions, 1);
    assert.equal(summary.removedControls, 1);
    assert.equal(summary.removedEvidenceDirectories, 1);
    assert.equal(summary.removedStagingDirectories, 1);
    assert.equal(await pathExists(paths.sessionFile), false);
    assert.equal(await pathExists(paths.controlFile), false);
    assert.equal(await pathExists(paths.evidenceDirectory), false);
    assert.equal(await pathExists(paths.stagingRoot), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('projects an account restriction as a terminal login state', () => {
  const projected = projectLoginSession({
    sessionId: 'login_restricted',
    platformId: 'deepseek',
    profileId: 'main',
    loginMethod: 'password',
    state: 'account_restricted',
    stage: 'restricted',
    nextAction: 'wait_until_restriction_lifts',
    message: '???????????',
    restrictedUntil: '2026-09-24T11:37:00+08:00',
    restriction: { type: 'muted' },
    createdAt: '2026-09-22T03:00:00.000Z',
    expiresAt: '2026-09-22T03:20:00.000Z',
  });
  assert.equal(projected.terminal, true);
  assert.equal(projected.requiresUserAction, false);
  assert.equal(projected.restrictedUntil, '2026-09-24T11:37:00+08:00');
  assert.equal(projected.restriction.type, 'muted');
});
