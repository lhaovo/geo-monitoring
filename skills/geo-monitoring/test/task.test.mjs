import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createTaskDefinition, createTaskDirectory, loadWorkQueue, normalizeTaskDefinition, persistWorkQueue, questionDirectory, readJson, taskFiles, writeJson } from '../scripts/lib/task.mjs';
import { claimNext } from '../scripts/lib/work-queue.mjs';

test('creates a v4 file-based task with a shared platform queue', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'geo-skill-'));
  try {
    const definition = createTaskDefinition({
      brandName: 'Example Brand',
      aliases: ['Example', 'example'],
      domains: ['https://www.example.com/path'],
      questions: ['Question one', 'Question one', 'Question two'],
      platforms: ['deepseek', 'kimi', 'KIMI'],
      outputDirectory: path.join(root, 'output'),
      profilesDirectory: path.join(root, 'profiles'),
    });
    const directory = await createTaskDirectory(definition);
    const files = taskFiles(directory);
    const task = await readJson(files.task);
    const manifest = await readJson(files.manifest);
    const queue = await readJson(files.queue);
    assert.equal(task.version, 4);
    assert.equal(task.questions.length, 2);
    assert.deepEqual(task.platforms.map(({ id }) => id), ['deepseek', 'kimi']);
    assert.ok(task.platforms.every((binding) => binding.questionIds === undefined));
    assert.deepEqual(task.brand.ownedDomains, ['www.example.com']);
    assert.deepEqual(queue.platforms.kimi.pending, ['q01', 'q02']);
    assert.deepEqual(queue.platforms.deepseek.pending, ['q01', 'q02']);
    assert.equal(manifest.version, 4);
    assert.equal(manifest.status, 'created');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('accepts more than ten questions (no question-count limit)', () => {
  const definition = createTaskDefinition({
    brandName: 'Brand',
    questions: Array.from({ length: 25 }, (_, index) => `Question ${index}`),
    platforms: ['kimi'],
    outputDirectory: 'output',
    profilesDirectory: 'profiles',
  });
  assert.equal(definition.questions.length, 25);
});

test('keeps multiple profiles of the same platform without pre-splitting questions', () => {
  const questions = Array.from({ length: 100 }, (_, index) => `Question ${index + 1}`);
  const definition = createTaskDefinition({
    brandName: 'Brand',
    questions,
    platforms: [
      { id: 'doubao', profileId: '13220602153', account: '13220602153' },
      { id: 'doubao', profileId: '13800001111', account: '13800001111' },
      { id: 'doubao', profileId: '13220602153', account: '13220602153' },
    ],
    outputDirectory: 'output',
    profilesDirectory: 'profiles',
    workerConcurrency: 2,
  });
  assert.deepEqual(definition.platforms.map(({ bindingId }) => bindingId), ['doubao:13220602153', 'doubao:13800001111']);
  assert.ok(definition.platforms.every((binding) => binding.questionIds === undefined));
  assert.equal(definition.version, 4);
  assert.equal(definition.settings.globalMaxWorkerConcurrency, 2);
  assert.equal(definition.settings.maxQuestionAttempts, 3);
});

test('normalizes legacy static assignments into a v4 shared queue model', () => {
  const task = normalizeTaskDefinition({
    version: 3,
    questions: Array.from({ length: 8 }, (_, index) => ({ id: `q${String(index + 1).padStart(2, '0')}`, text: `Question ${index + 1}` })),
    platforms: [
      { id: 'kimi', profileId: 'work', bindingId: 'kimi:work', questionIds: ['q01', 'q02', 'q03', 'q04'] },
      { id: 'kimi', profileId: 'personal', bindingId: 'kimi:personal', questionIds: ['q05', 'q06', 'q07', 'q08'] },
    ],
  });
  assert.equal(task.version, 4);
  assert.ok(task.platforms.every((binding) => binding.questionIds === undefined));
});

test('forces only Doubao monitoring tasks to headed mode', () => {
  const definition = createTaskDefinition({
    brandName: 'Brand',
    questions: ['Question'],
    platforms: [
      { id: 'doubao', profileId: 'work', mode: 'headless' },
      { id: 'qwen', profileId: 'work', mode: 'headed' },
      { id: 'kimi', profileId: 'work', mode: 'headed' },
      { id: 'deepseek', profileId: 'work', mode: 'headed' },
      { id: 'yuanbao', profileId: 'work', mode: 'headed' },
    ],
    outputDirectory: 'output',
    profilesDirectory: 'profiles',
  });
  assert.deepEqual(definition.platforms.map(({ mode }) => mode), ['headed', 'headless', 'headless', 'headless', 'headless']);
});
test("recovers the work queue from its backup and keeps both copies identical", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "geo-task-backup-"));
  try {
    const definition = createTaskDefinition({
      brandName: "Brand",
      questions: ["Question one"],
      platforms: ["kimi"],
      outputDirectory: path.join(root, "output"),
      profilesDirectory: path.join(root, "profiles"),
    });
    const directory = await createTaskDirectory(definition);
    const files = taskFiles(directory);
    const task = await readJson(files.task);
    const loaded = await loadWorkQueue({ taskDirectory: directory, task, files });
    const claim = claimNext(loaded.queue, {
      platformId: "kimi",
      bindingId: task.platforms[0].bindingId,
      leaseMs: 60_000,
    });
    assert.equal(claim.questionId, "q01");
    await persistWorkQueue({ taskDirectory: directory, queue: loaded.queue });
    assert.deepEqual(await readJson(files.queue), await readJson(files.queueBackup));
    await writeFile(files.queue, "{broken", "utf8");
    const recovered = await loadWorkQueue({ taskDirectory: directory, task, files });
    assert.equal(recovered.source, "backup");
    assert.equal(recovered.recovered, true);
    assert.equal(recovered.queue.platforms.kimi.claimed.q01.bindingId, "kimi:default");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rebuilds a corrupted queue and backup from completed answer artifacts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "geo-task-rebuild-"));
  try {
    const definition = createTaskDefinition({
      brandName: "Brand",
      questions: ["Question one"],
      platforms: ["kimi"],
      outputDirectory: path.join(root, "output"),
      profilesDirectory: path.join(root, "profiles"),
    });
    const directory = await createTaskDirectory(definition);
    const files = taskFiles(directory);
    const task = await readJson(files.task);
    const binding = task.platforms[0];
    await writeJson(path.join(questionDirectory(directory, binding, "q01"), "answer.json"), {
      status: "completed",
      attempt: 2,
      completedAt: "2026-01-01T00:00:00.000Z",
    });
    await writeFile(files.queue, "{broken", "utf8");
    await writeFile(files.queueBackup, "also broken", "utf8");
    const recovered = await loadWorkQueue({ taskDirectory: directory, task, files });
    assert.equal(recovered.source, "rebuilt");
    assert.equal(recovered.reconciled, 1);
    assert.equal(recovered.queue.platforms.kimi.completed.q01.bindingId, binding.bindingId);
    assert.equal(recovered.queue.platforms.kimi.attempts.q01, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
