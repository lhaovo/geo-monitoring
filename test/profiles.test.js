import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openDatabase } from '../src/db/database.js';
import { GeoRepository } from '../src/db/repository.js';
import {
  normalizeAccountIdentity,
  normalizeProfileId,
  profileBindingId,
  profileIdFromAccount,
} from '../src/profiles/account-identity.js';
import { profileChromeDirectory, profilePaths } from '../src/profiles/profile-paths.js';

async function withRepository(callback) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'geo-profiles-'));
  const database = openDatabase(path.join(directory, 'geo.sqlite'));
  try {
    await callback(new GeoRepository(database));
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
}

test('归一化手机号与普通账号标识', () => {
  assert.equal(normalizeAccountIdentity(' 132 2060 2153 '), '13220602153');
  assert.equal(normalizeAccountIdentity('+86 13220602153'), '13220602153');
  assert.equal(normalizeAccountIdentity('User@Example.com'), 'user@example.com');
  assert.equal(normalizeAccountIdentity(''), '');
});

test('拒绝不合法的 Profile 标识', () => {
  assert.equal(normalizeProfileId(' Dou_Bao-01 '), 'dou_bao-01');
  assert.throws(() => normalizeProfileId('chrome'), /Profile 标识/);
  assert.throws(() => normalizeProfileId('非法标识'), /Profile 标识/);
});

test('从账号推导 Profile 标识并生成绑定标识', () => {
  assert.equal(profileIdFromAccount('13220602153'), '13220602153');
  assert.equal(profileIdFromAccount('User@Example.com'), 'user-example-com');
  assert.equal(profileBindingId('doubao', '13220602153'), 'doubao:13220602153');
});

test('登录态目录按平台与 Profile 隔离', () => {
  const paths = { profilesDirectory: path.join('C:', 'geo', 'profiles') };
  const first = profilePaths(paths, 'doubao', '13220602153');
  const second = profilePaths(paths, 'doubao', '13800001111');
  assert.notEqual(first.chromeDirectory, second.chromeDirectory);
  assert.equal(profileChromeDirectory(paths, 'doubao', '13220602153'), first.chromeDirectory);
  assert.ok(first.chromeDirectory.endsWith(path.join('doubao', '13220602153', 'chrome')));
});

test('创建登录态时按账号派生标识并拒绝重复账号', async () => {
  await withRepository(async (repository) => {
    const profile = repository.createProfile({ platformId: 'doubao', account: '132 2060 2153' });
    assert.equal(profile.profileId, '13220602153');
    assert.equal(profile.account, '13220602153');
    assert.equal(profile.health, 'new');
    assert.equal(repository.getProfileByBinding('doubao', '13220602153').id, profile.id);
    assert.throws(() => repository.createProfile({ platformId: 'doubao', account: '13220602153' }), /已存在/);
  });
});

test('只有 ready 的登录态会被自动选中', async () => {
  await withRepository(async (repository) => {
    const ready = repository.createProfile({ platformId: 'kimi', account: 'ready@example.com' });
    const fresh = repository.createProfile({ platformId: 'kimi', account: 'fresh@example.com' });
    const restricted = repository.createProfile({ platformId: 'kimi', account: 'limited@example.com' });
    repository.updateProfile(ready.id, { health: 'ready' });
    repository.updateProfile(restricted.id, { health: 'restricted', restrictedUntil: '2030-01-01T00:00:00.000Z' });

    assert.equal(repository.pickAvailableProfile('kimi').id, ready.id);
    repository.updateProfile(ready.id, { health: 'disabled' });
    assert.equal(repository.pickAvailableProfile('kimi'), null);
    repository.updateProfile(fresh.id, { health: 'ready' });
    assert.equal(repository.pickAvailableProfile('kimi').id, fresh.id);
  });
});

test('停用登录态后不再被选中', async () => {
  await withRepository(async (repository) => {
    const profile = repository.createProfile({ platformId: 'qwen', account: '13800002222' });
    repository.updateProfile(profile.id, { health: 'ready' });
    repository.disableProfile(profile.id, '手动停用');
    const updated = repository.getProfile(profile.id);
    assert.equal(updated.health, 'disabled');
    assert.equal(updated.lastError, '手动停用');
    assert.equal(repository.pickAvailableProfile('qwen'), null);
  });
});

test('多个可用登录态会轮转使用', async () => {
  await withRepository(async (repository) => {
    const first = repository.createProfile({ platformId: 'doubao', account: '13800000001' });
    const second = repository.createProfile({ platformId: 'doubao', account: '13800000002' });
    repository.updateProfile(first.id, { health: 'ready' });
    repository.updateProfile(second.id, { health: 'ready' });

    const picked = repository.pickAvailableProfile('doubao');
    assert.equal(picked.id, first.id);
    repository.touchProfileUsage('doubao', picked.profileId);
    assert.equal(repository.pickAvailableProfile('doubao').id, second.id);
    repository.touchProfileUsage('doubao', second.profileId);
    assert.equal(repository.pickAvailableProfile('doubao').id, first.id);
  });
});

test('轮转会跳过受限与停用的登录态', async () => {
  await withRepository(async (repository) => {
    const healthy = repository.createProfile({ platformId: 'kimi', account: '13800000003' });
    const blocked = repository.createProfile({ platformId: 'kimi', account: '13800000004' });
    repository.updateProfile(healthy.id, { health: 'ready' });
    repository.updateProfile(blocked.id, { health: 'restricted', restrictedUntil: '2030-01-01T00:00:00.000Z' });

    const picked = repository.pickAvailableProfile('kimi');
    assert.equal(picked.id, healthy.id);
    repository.touchProfileUsage('kimi', picked.profileId);
    assert.equal(repository.pickAvailableProfile('kimi').id, healthy.id);
  });
});
