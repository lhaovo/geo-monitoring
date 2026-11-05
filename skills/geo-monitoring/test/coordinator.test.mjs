import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createProfile, updateProfile } from '../scripts/lib/profiles.mjs';
import { bindingDirectory, createTaskDefinition, createTaskDirectory, loadWorkQueue, persistWorkQueue, readJson, taskFiles, writeJson } from '../scripts/lib/task.mjs';
import { acquireCoordinatorLock } from '../scripts/lib/coordinator-lock.mjs';
import { claimNext } from '../scripts/lib/work-queue.mjs';
import { runTask } from '../scripts/run-task.mjs';

const mockWorker = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'mock-worker.mjs');

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function totalAttempts(platformState) {
  return Object.values(platformState.attempts).reduce((sum, value) => sum + (Number(value) || 0), 0);
}

test('recovers a hung worker lease and finishes with the remaining profile', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'geo-coordinator-hang-'));
  const profilesDirectory = path.join(root, 'profiles');
  const outputDirectory = path.join(root, 'output');
  const previousHangBinding = process.env.GEO_MOCK_HANG_BINDING;
  try {
    await createProfile({ profilesDirectory, platformId: 'kimi', profileId: 'work', account: '13220602153' });
    await createProfile({ profilesDirectory, platformId: 'kimi', profileId: 'backup', account: '13800001111' });
    await updateProfile({ profilesDirectory, platformId: 'kimi', profileId: 'work', patch: { health: 'ready' } });
    await updateProfile({ profilesDirectory, platformId: 'kimi', profileId: 'backup', patch: { health: 'ready' } });

    const definition = createTaskDefinition({
      brandName: 'Brand',
      questions: ['Q1', 'Q2', 'Q3', 'Q4'],
      platforms: [
        { id: 'kimi', profileId: 'work', account: '13220602153' },
        { id: 'kimi', profileId: 'backup', account: '13800001111' },
      ],
      outputDirectory,
      profilesDirectory,
      workerConcurrency: 1,
    });
    definition.settings.claimLeaseMs = 250;
    definition.settings.heartbeatIntervalMs = 50;
    definition.settings.retryBaseDelayMs = 0;
    const taskDirectory = await createTaskDirectory(definition);
    process.env.GEO_MOCK_HANG_BINDING = 'kimi:work';

    const manifest = await runTask({ taskDirectory, workerScript: mockWorker });
    const queue = await readJson(taskFiles(taskDirectory).queue);
    assert.equal(queue.platforms.kimi.pending.length, 0);
    assert.equal(Object.keys(queue.platforms.kimi.completed).length, 4);
    assert.equal(manifest.status, 'completed');
    assert.equal(manifest.bindingStates['kimi:backup'], 'completed');
    assert.ok(['failed', 'cancelled'].includes(manifest.bindingStates['kimi:work']), `work state: ${manifest.bindingStates['kimi:work']}`);
    assert.ok(totalAttempts(queue.platforms.kimi) >= 5);
  } finally {
    restoreEnv('GEO_MOCK_HANG_BINDING', previousHangBinding);
    await rm(root, { recursive: true, force: true });
  }
});

test('requeues a failed binding claim and lets the remaining profile finish the queue', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'geo-coordinator-'));
  const profilesDirectory = path.join(root, 'profiles');
  const outputDirectory = path.join(root, 'output');
  const previousFailBinding = process.env.GEO_MOCK_FAIL_BINDING;
  try {
    await createProfile({ profilesDirectory, platformId: 'kimi', profileId: 'work', account: '13220602153' });
    await createProfile({ profilesDirectory, platformId: 'kimi', profileId: 'backup', account: '13800001111' });
    await updateProfile({ profilesDirectory, platformId: 'kimi', profileId: 'work', patch: { health: 'ready' } });
    await updateProfile({ profilesDirectory, platformId: 'kimi', profileId: 'backup', patch: { health: 'ready' } });

    const definition = createTaskDefinition({
      brandName: 'Brand',
      questions: ['Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6'],
      platforms: [
        { id: 'kimi', profileId: 'work', account: '13220602153' },
        { id: 'kimi', profileId: 'backup', account: '13800001111' },
      ],
      outputDirectory,
      profilesDirectory,
      workerConcurrency: 2,
    });
    const taskDirectory = await createTaskDirectory(definition);
    process.env.GEO_MOCK_FAIL_BINDING = 'kimi:work';
    const manifest = await runTask({ taskDirectory, workerScript: mockWorker });
    const queue = await readJson(taskFiles(taskDirectory).queue);
    assert.equal(queue.platforms.kimi.pending.length, 0);
    assert.equal(Object.keys(queue.platforms.kimi.completed).length, 6);
    assert.equal(manifest.queueSummary.length, 1);
    assert.equal(manifest.queueSummary[0].completed, 6);
    assert.equal(manifest.status, 'completed');
    assert.equal(manifest.bindingStates['kimi:work'], 'failed');
    assert.equal(manifest.bindingStates['kimi:backup'], 'completed');
  } finally {
    restoreEnv('GEO_MOCK_FAIL_BINDING', previousFailBinding);
    await rm(root, { recursive: true, force: true });
  }
});
test("refuses to run a task already owned by another coordinator", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "geo-coordinator-conflict-"));
  const profilesDirectory = path.join(root, "profiles");
  const outputDirectory = path.join(root, "output");
  try {
    await createProfile({ profilesDirectory, platformId: "kimi", profileId: "work", account: "13220602153" });
    await updateProfile({ profilesDirectory, platformId: "kimi", profileId: "work", patch: { health: "ready" } });
    const definition = createTaskDefinition({
      brandName: "Brand",
      questions: ["Q1"],
      platforms: [{ id: "kimi", profileId: "work", account: "13220602153" }],
      outputDirectory,
      profilesDirectory,
    });
    const taskDirectory = await createTaskDirectory(definition);
    const files = taskFiles(taskDirectory);
    const task = await readJson(files.task);
    const lock = await acquireCoordinatorLock({ taskDirectory, taskId: task.id, ownerId: "existing" });
    await assert.rejects(
      runTask({ taskDirectory, workerScript: mockWorker }),
      (error) => error.code === "task_already_running",
    );
    assert.equal((await readJson(files.manifest)).status, "created");
    await lock.release();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("takes over a stale coordinator and requeues its abandoned claim", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "geo-coordinator-recover-"));
  const profilesDirectory = path.join(root, "profiles");
  const outputDirectory = path.join(root, "output");
  try {
    await createProfile({ profilesDirectory, platformId: "kimi", profileId: "work", account: "13220602153" });
    await updateProfile({ profilesDirectory, platformId: "kimi", profileId: "work", patch: { health: "ready" } });
    const definition = createTaskDefinition({
      brandName: "Brand",
      questions: ["Q1"],
      platforms: [{ id: "kimi", profileId: "work", account: "13220602153" }],
      outputDirectory,
      profilesDirectory,
    });
    const taskDirectory = await createTaskDirectory(definition);
    const files = taskFiles(taskDirectory);
    const task = await readJson(files.task);
    const loaded = await loadWorkQueue({ taskDirectory, task, files });
    const claim = claimNext(loaded.queue, {
      platformId: "kimi",
      bindingId: "kimi:work",
      leaseMs: 60_000,
    });
    assert.equal(claim.questionId, "q01");
    await persistWorkQueue({ taskDirectory, queue: loaded.queue });
    const staleAt = new Date(Date.now() - 60_000).toISOString();
    await writeJson(files.coordinatorLock, {
      version: 1,
      taskId: task.id,
      ownerId: "dead-owner",
      pid: 999999,
      hostname: os.hostname(),
      startedAt: staleAt,
      heartbeatAt: staleAt,
    });

    const manifest = await runTask({ taskDirectory, workerScript: mockWorker });
    const queue = await readJson(files.queue);
    assert.equal(manifest.status, "completed");
    assert.equal(Object.keys(queue.platforms.kimi.completed).length, 1);
    assert.equal(queue.platforms.kimi.pending.length, 0);
    assert.match(await readFile(files.events, "utf8"), /Recovered stale coordinator/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("stops writing task state after losing the coordinator lock", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "geo-coordinator-lost-write-"));
  const profilesDirectory = path.join(root, "profiles");
  const outputDirectory = path.join(root, "output");
  const previousHangBinding = process.env.GEO_MOCK_HANG_BINDING;
  try {
    await createProfile({ profilesDirectory, platformId: "kimi", profileId: "work", account: "13220602153" });
    await updateProfile({ profilesDirectory, platformId: "kimi", profileId: "work", patch: { health: "ready" } });
    const definition = createTaskDefinition({
      brandName: "Brand",
      questions: ["Q1"],
      platforms: [{ id: "kimi", profileId: "work", account: "13220602153" }],
      outputDirectory,
      profilesDirectory,
    });
    const taskDirectory = await createTaskDirectory(definition);
    const files = taskFiles(taskDirectory);
    const task = await readJson(files.task);
    process.env.GEO_MOCK_HANG_BINDING = "kimi:work";
    const running = runTask({ taskDirectory, workerScript: mockWorker, coordinatorHeartbeatIntervalMs: 20 });
    let rejectedEarly = false;
    running.catch(() => { rejectedEarly = true; });

    const statusPath = path.join(bindingDirectory(taskDirectory, task.platforms[0]), "status.json");
    const deadline = Date.now() + 5_000;
    let claimed = false;
    while (!claimed && !rejectedEarly && Date.now() < deadline) {
      try {
        const status = await readJson(statusPath);
        claimed = status?.claimedQuestionIds?.includes("q01") ?? false;
      } catch {
        // The worker has not created its status file yet.
      }
      if (!claimed) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(claimed, true);

    const currentLock = await readJson(files.coordinatorLock);
    await writeJson(files.coordinatorLock, {
      ...currentLock,
      ownerId: "replacement-coordinator",
      startedAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
    });
    await assert.rejects(running, (error) => error.code === "coordinator_lock_lost");
    const manifest = await readJson(files.manifest);
    assert.equal(manifest.status, "running");
    assert.equal(manifest.error, undefined);
  } finally {
    restoreEnv("GEO_MOCK_HANG_BINDING", previousHangBinding);
    await rm(root, { recursive: true, force: true });
  }
});
