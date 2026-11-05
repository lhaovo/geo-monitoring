import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openDatabase } from '../src/db/database.js';
import { GeoRepository } from '../src/db/repository.js';
import { createWorkQueue } from '../src/worker/work-queue.js';

async function withRepository(callback) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'geo-queue-'));
  const database = openDatabase(path.join(directory, 'geo.sqlite'));
  try {
    await callback(new GeoRepository(database));
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
}

async function seedRun(repository, { platforms = ['kimi'], prompts = 2 } = {}) {
  const brand = repository.createBrand({ name: '队列品牌' });
  const questionIds = [];
  for (let index = 0; index < prompts; index += 1) {
    questionIds.push(repository.createPrompt(brand.id, { text: `问题 ${index + 1}` }).id);
  }
  return repository.createRun({ projectId: brand.id, promptIds: questionIds, platforms });
}

test('按平台串行领取任务，不会重复领取同一问题', async () => {
  await withRepository(async (repository) => {
    const run = await seedRun(repository, { platforms: ['kimi', 'deepseek'], prompts: 2 });
    const queue = createWorkQueue({ repository });

    const first = queue.claimNext(run.id, 'kimi', { leaseId: 'lease-1' });
    assert.ok(first);
    assert.equal(first.platformId, 'kimi');
    assert.equal(first.status, 'running');
    assert.equal(first.attempts, 1);
    assert.ok(first.prompt?.text);

    const second = queue.claimNext(run.id, 'kimi', { leaseId: 'lease-2' });
    assert.ok(second);
    assert.notEqual(second.id, first.id);

    const third = queue.claimNext(run.id, 'kimi', { leaseId: 'lease-3' });
    assert.equal(third, null);

    const other = queue.claimNext(run.id, 'deepseek', { leaseId: 'lease-4' });
    assert.equal(other.platformId, 'deepseek');
  });
});

test('心跳延长租约，过期租约的任务重新入队', async () => {
  await withRepository(async (repository) => {
    const run = await seedRun(repository, { platforms: ['kimi'], prompts: 1 });
    const queue = createWorkQueue({ repository });

    const claimed = queue.claimNext(run.id, 'kimi', { leaseId: 'lease-1', leaseMs: 1 });
    assert.ok(claimed);

    assert.equal(queue.heartbeat(claimed.id, 'lease-1', { leaseMs: 60_000 }), true);
    assert.equal(queue.heartbeat(claimed.id, 'wrong-lease'), false);

    // 心跳延长后的租约不会因为原来的到期时间被回收。
    repository.expirePlatformRunClaims(new Date(Date.now() + 10_000).toISOString());
    assert.equal(queue.claimNext(run.id, 'kimi', { leaseId: 'lease-x' }), null);

    repository.expirePlatformRunClaims(new Date(Date.now() + 120_000).toISOString());
    const reclaimed = queue.claimNext(run.id, 'kimi', { leaseId: 'lease-2' });
    assert.ok(reclaimed);
    assert.equal(reclaimed.id, claimed.id);
    assert.equal(reclaimed.attempts, 2);
  });
});

test('失败后重新入队，超过最大尝试次数则最终失败', async () => {
  await withRepository(async (repository) => {
    const run = await seedRun(repository, { platforms: ['kimi'], prompts: 1 });
    const queue = createWorkQueue({ repository });

    const first = queue.claimNext(run.id, 'kimi', { leaseId: 'lease-1' });
    const requeued = queue.fail(first.id, 'lease-1', '页面超时', { maxAttempts: 2 });
    assert.equal(requeued.requeued, true);
    assert.equal(requeued.status, 'queued');

    const second = queue.claimNext(run.id, 'kimi', { leaseId: 'lease-2' });
    assert.equal(second.id, first.id);
    const failed = queue.fail(second.id, 'lease-2', '页面超时', { maxAttempts: 2 });
    assert.equal(failed.requeued, false);
    assert.equal(failed.status, 'failed');
    assert.equal(queue.claimNext(run.id, 'kimi', { leaseId: 'lease-3' }), null);
  });
});

test('账号受限时把该 Profile 的未完成任务放回队列', async () => {
  await withRepository(async (repository) => {
    const run = await seedRun(repository, { platforms: ['kimi'], prompts: 2 });
    const queue = createWorkQueue({ repository });

    const claimed = queue.claimNext(run.id, 'kimi', { leaseId: 'lease-1' });
    repository.assignPlatformRunProfile(claimed.id, '13220602153');
    const pending = repository.getPendingPlatformRuns(run.id);
    assert.equal(pending.length, 1);

    const released = queue.requeueForProfile('kimi', '13220602153', '账号受限');
    assert.equal(released, 1);
    assert.equal(repository.getPendingPlatformRuns(run.id).length, 2);
  });
});

test('队列汇总按平台与状态统计', async () => {
  await withRepository(async (repository) => {
    const run = await seedRun(repository, { platforms: ['kimi', 'deepseek'], prompts: 1 });
    const queue = createWorkQueue({ repository });
    queue.claimNext(run.id, 'kimi', { leaseId: 'lease-1' });

    const summary = queue.summarize(run.id);
    const kimi = summary.find((item) => item.platformId === 'kimi');
    const deepseek = summary.find((item) => item.platformId === 'deepseek');
    assert.equal(kimi.running, 1);
    assert.equal(kimi.queued, 0);
    assert.equal(deepseek.queued, 1);
  });
});
