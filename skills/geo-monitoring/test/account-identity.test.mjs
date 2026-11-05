import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { describeAccountBinding, projectAccountBinding } from '../scripts/lib/account-identity.mjs';
import { createProfile, normalizeAccountIdentity } from '../scripts/lib/profiles.mjs';

test('normalizes phone numbers and accounts into one identity', () => {
  assert.equal(normalizeAccountIdentity('13220602153'), '13220602153');
  assert.equal(normalizeAccountIdentity('+86 132-2060-2153'), '13220602153');
  assert.equal(normalizeAccountIdentity('User@Example.com'), 'user@example.com');
  assert.equal(normalizeAccountIdentity(''), '');
});

test('reports the profile that already holds an account', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'geo-account-binding-'));
  try {
    await createProfile({ profilesDirectory: root, platformId: 'kimi', account: '13220602153' });
    await createProfile({ profilesDirectory: root, platformId: 'kimi', profileId: 'backup', account: '13800001111' });

    const current = await describeAccountBinding({
      profilesDirectory: root,
      platformId: 'kimi',
      profileId: '13220602153',
      account: '+86 132-2060-2153',
    });
    assert.equal(current.status, 'bound_to_current');
    assert.equal(current.decisionRequired, false);
    assert.equal(projectAccountBinding(current).account, '+86 132-2060-2153');

    const foreign = await describeAccountBinding({
      profilesDirectory: root,
      platformId: 'kimi',
      profileId: 'backup',
      account: '13220602153',
    });
    assert.equal(foreign.status, 'bound_elsewhere');
    assert.equal(foreign.decisionRequired, true);
    assert.equal(foreign.preferredProfile.profileId, '13220602153');

    const unbound = await describeAccountBinding({
      profilesDirectory: root,
      platformId: 'kimi',
      account: '13900002222',
    });
    assert.equal(unbound.status, 'unbound');
    assert.equal(unbound.decisionRequired, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
