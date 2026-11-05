import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { acquireProfileLock } from '../scripts/lib/profile-lock.mjs';
import { createProfile, defaultProfile, getPlatformDefinition, listProfiles, rebindProfile, setDefaultProfile, SUPPORTED_PLATFORMS } from '../scripts/lib/profiles.mjs';

test('registers one login profile per account and tracks the default', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'geo-profiles-'));
  try {
    const first = await createProfile({ profilesDirectory: root, platformId: 'doubao', account: '13220602153' });
    assert.equal(first.profileId, '13220602153');
    assert.equal(first.created, true);

    const repeated = await createProfile({ profilesDirectory: root, platformId: 'doubao', account: '+86 132-2060-2153' });
    assert.equal(repeated.profileId, '13220602153');
    assert.equal(repeated.created, false);

    await createProfile({ profilesDirectory: root, platformId: 'doubao', account: '13800001111' });
    await setDefaultProfile({ profilesDirectory: root, platformId: 'doubao', profileId: '13800001111' });

    const profiles = await listProfiles({ profilesDirectory: root, platformId: 'doubao' });
    assert.deepEqual(profiles.map(({ profileId }) => profileId), ['13220602153', '13800001111']);
    assert.equal((await defaultProfile({ profilesDirectory: root, platformId: 'doubao' })).profileId, '13800001111');
    assert.equal(profiles.find(({ profileId }) => profileId === '13220602153').account, '13220602153');
    assert.ok(profiles.every((profile) => profile.label === undefined));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rebinds a legacy profile id onto its account and moves the directory', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'geo-rebind-'));
  try {
    await createProfile({ profilesDirectory: root, platformId: 'kimi', profileId: 'work', account: '13220602153' });
    const rebound = await rebindProfile({ profilesDirectory: root, platformId: 'kimi', profileId: 'work', account: '13220602153' });
    assert.equal(rebound.profileId, '13220602153');
    assert.equal(rebound.account, '13220602153');
    assert.equal(rebound.version, 2);

    const profiles = await listProfiles({ profilesDirectory: root, platformId: 'kimi' });
    assert.deepEqual(profiles.map(({ profileId }) => profileId), ['13220602153']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('prevents two owners from using the same profile concurrently', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'geo-lock-'));
  try {
    await createProfile({ profilesDirectory: root, platformId: 'deepseek', profileId: 'main', account: '13220602153' });
    const first = await acquireProfileLock({
      profilesDirectory: root,
      platformId: 'deepseek',
      profileId: 'main',
      ownerType: 'login',
      ownerId: 'login-1',
    });
    await assert.rejects(
      acquireProfileLock({
        profilesDirectory: root,
        platformId: 'deepseek',
        profileId: 'main',
        ownerType: 'task',
        ownerId: 'task-1',
      }),
      (error) => error.code === 'profile_locked',
    );
    await first.release();
    const second = await acquireProfileLock({
      profilesDirectory: root,
      platformId: 'deepseek',
      profileId: 'main',
      ownerType: 'task',
      ownerId: 'task-1',
    });
    await second.release();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('registers Wenxiaoyan with SMS login and headless monitoring', () => {
  assert.ok(SUPPORTED_PLATFORMS.includes('wenxiaoyan'));
  assert.deepEqual(getPlatformDefinition('wenxiaoyan'), {
    id: 'wenxiaoyan',
    label: '\u6587\u5c0f\u8a00',
    loginMethod: 'sms_code',
    defaultMode: 'headless',
  });
});
