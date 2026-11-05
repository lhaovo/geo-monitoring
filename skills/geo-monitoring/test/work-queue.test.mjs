import assert from 'node:assert/strict';
import test from 'node:test';
import {
  claimNext,
  completeClaim,
  createWorkQueue,
  expireClaims,
  failClaim,
  hasImmediateWork,
  hasOutstandingWork,
  heartbeatClaim,
  markPendingFailed,
  nextAvailableAt,
  requeueClaimsForBinding,
  restoreWorkQueue,
  seedCompleted,
  summarizeQueue,
} from '../scripts/lib/work-queue.mjs';

function questions(count = 3) {
  return Array.from({ length: count }, (_, index) => ({
    id: `q${String(index + 1).padStart(2, '0')}`,
    text: `Question ${index + 1}`,
  }));
}

test('claims questions dynamically without assigning them to one binding up front', () => {
  const now = new Date('2026-01-01T00:00:00.000Z');
  const state = createWorkQueue({ taskId: 'task', questions: questions(3), platforms: ['doubao'], now });
  const first = claimNext(state, { platformId: 'doubao', bindingId: 'doubao:a', leaseMs: 1000, now });
  const second = claimNext(state, { platformId: 'doubao', bindingId: 'doubao:b', leaseMs: 1000, now });
  assert.equal(first.questionId, 'q01');
  assert.equal(second.questionId, 'q02');
  assert.equal(state.platforms.doubao.pending.length, 1);
  assert.equal(state.platforms.doubao.attempts.q01, 1);
});

test('heartbeat extends a lease while complete records the owning binding', () => {
  const now = new Date('2026-01-01T00:00:00.000Z');
  const state = createWorkQueue({ taskId: 'task', questions: questions(1), platforms: ['doubao'], now });
  const claim = claimNext(state, { platformId: 'doubao', bindingId: 'doubao:a', leaseMs: 1000, now });
  assert.equal(heartbeatClaim(state, { ...claim, leaseMs: 5000, now: new Date('2026-01-01T00:00:00.500Z') }), true);
  const completed = completeClaim(state, { ...claim, now: new Date('2026-01-01T00:00:01.000Z') });
  assert.equal(completed.bindingId, 'doubao:a');
  assert.equal(state.platforms.doubao.completed.q01.bindingId, 'doubao:a');
});

test('expires dead leases and makes their questions claimable by another binding', () => {
  const now = new Date('2026-01-01T00:00:00.000Z');
  const state = createWorkQueue({ taskId: 'task', questions: questions(1), platforms: ['kimi'], now });
  claimNext(state, { platformId: 'kimi', bindingId: 'kimi:a', leaseMs: 1000, now });
  const expired = expireClaims(state, { now: new Date('2026-01-01T00:00:02.000Z') });
  assert.equal(expired.length, 1);
  const next = claimNext(state, { platformId: 'kimi', bindingId: 'kimi:b', leaseMs: 1000, now: new Date('2026-01-01T00:00:02.000Z') });
  assert.equal(next.bindingId, 'kimi:b');
  assert.equal(next.attempt, 2);
});

test('retries platform errors up to max attempts and then marks them failed', () => {
  const now = new Date('2026-01-01T00:00:00.000Z');
  const state = createWorkQueue({ taskId: 'task', questions: questions(1), platforms: ['qwen'], now });
  const first = claimNext(state, { platformId: 'qwen', bindingId: 'qwen:a', leaseMs: 1000, now });
  const firstFail = failClaim(state, { ...first, category: 'platform_error', maxAttempts: 2, now });
  assert.equal(firstFail.retried, true);
  const second = claimNext(state, { platformId: 'qwen', bindingId: 'qwen:b', leaseMs: 1000, now });
  const secondFail = failClaim(state, { ...second, category: 'platform_error', maxAttempts: 2, now });
  assert.equal(secondFail.retried, false);
  assert.equal(state.platforms.qwen.failed.q01.attempt, 2);
});

test('force retry returns login and challenge failures to the shared queue immediately', () => {
  const now = new Date('2026-01-01T00:00:00.000Z');
  const state = createWorkQueue({ taskId: 'task', questions: questions(1), platforms: ['yuanbao'], now });
  const claim = claimNext(state, { platformId: 'yuanbao', bindingId: 'yuanbao:a', leaseMs: 1000, now });
  const result = failClaim(state, { ...claim, category: 'login_required', retryable: true, forceRetry: true, maxAttempts: 1, now });
  assert.equal(result.retried, true);
  assert.equal(hasImmediateWork(state, { platformId: 'yuanbao', now }), true);
});

test('requeues all live claims owned by a worker that exits', () => {
  const now = new Date('2026-01-01T00:00:00.000Z');
  const state = createWorkQueue({ taskId: 'task', questions: questions(2), platforms: ['deepseek'], now });
  claimNext(state, { platformId: 'deepseek', bindingId: 'deepseek:a', leaseMs: 1000, now });
  claimNext(state, { platformId: 'deepseek', bindingId: 'deepseek:a', leaseMs: 1000, now });
  const requeued = requeueClaimsForBinding(state, { bindingId: 'deepseek:a', now });
  assert.equal(requeued.length, 2);
  assert.equal(state.platforms.deepseek.pending.length, 2);
  assert.equal(hasOutstandingWork(state, { platformId: 'deepseek' }), true);
});

test('restores a partial queue and fills any missing questions', () => {
  const now = new Date('2026-01-01T00:00:00.000Z');
  const state = createWorkQueue({ taskId: 'task', questions: questions(3), platforms: ['doubao'], now });
  seedCompleted(state, { platformId: 'doubao', questionId: 'q01', bindingId: 'doubao:a', now });
  const restored = restoreWorkQueue(JSON.parse(JSON.stringify(state)), {
    taskId: 'task',
    questions: questions(4),
    platforms: ['doubao'],
    now: new Date('2026-01-01T00:00:01.000Z'),
  });
  assert.equal(restored.platforms.doubao.completed.q01.bindingId, 'doubao:a');
  assert.deepEqual(restored.platforms.doubao.pending.sort(), ['q02', 'q03', 'q04']);
});

test('reports queue progress and can fail unclaimed questions when no profile remains', () => {
  const now = new Date('2026-01-01T00:00:00.000Z');
  const state = createWorkQueue({ taskId: 'task', questions: questions(3), platforms: ['kimi'], now });
  const claim = claimNext(state, { platformId: 'kimi', bindingId: 'kimi:a', leaseMs: 1000, now });
  completeClaim(state, { ...claim, now });
  const summary = summarizeQueue(state, { platformIds: ['kimi'] })[0];
  assert.equal(summary.total, 3);
  assert.equal(summary.completed, 1);
  assert.equal(summary.pending, 2);
  assert.equal(summary.completedByBinding['kimi:a'], 1);
  assert.equal(markPendingFailed(state, { platformId: 'kimi', now }), 2);
  assert.equal(hasOutstandingWork(state, { platformId: 'kimi' }), false);
  assert.equal(nextAvailableAt(state, { platformIds: ['kimi'], now }), null);
});