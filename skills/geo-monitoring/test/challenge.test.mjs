import assert from 'node:assert/strict';
import test from 'node:test';
import { watchForHumanChallenge } from '../scripts/lib/challenge.mjs';

function fakePage(probes) {
  let index = 0;
  return {
    waitForTimeout: async () => {},
    probes,
    next() { return this.probes[Math.min(index++, this.probes.length - 1)]; },
  };
}

test('reports the challenge as soon as a platform asks for interactive verification', async () => {
  const page = fakePage([]);
  let calls = 0;
  const adapter = {
    inspectLoginState: async () => {
      calls += 1;
      return calls >= 2 ? { status: 'challenge', reason: 'human_challenge' } : { status: 'unauthenticated' };
    },
  };
  const probe = await watchForHumanChallenge({ adapter, page });
  assert.equal(probe.status, 'challenge');
});

test('stops watching once the caller signals completion', async () => {
  const page = fakePage([]);
  let done = false;
  const adapter = { inspectLoginState: async () => ({ status: 'unauthenticated' }) };
  const pending = watchForHumanChallenge({ adapter, page, isDone: () => done });
  done = true;
  assert.equal(await pending, null);
});

test('reports an account restriction while an answer is pending', async () => {
  const page = fakePage([]);
  let calls = 0;
  const adapter = {
    inspectLoginState: async () => {
      calls += 1;
      return calls >= 2 ? { status: 'restricted', reason: 'account_restricted' } : { status: 'authenticated' };
    },
  };
  const probe = await watchForHumanChallenge({ adapter, page });
  assert.equal(probe.status, 'restricted');
});
