import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { writeJsonFile } from './fs.mjs';
import { getPlatformDefinition, normalizeProfileId, profileBindingId, SUPPORTED_PLATFORMS } from './profiles.mjs';
import {
  createWorkQueue,
  isWorkQueueSnapshot,
  restoreWorkQueue,
  seedCompleted,
  snapshotWorkQueue,
} from './work-queue.mjs';

export { SUPPORTED_PLATFORMS };
export const SEARCH_PROMPT_SUFFIX = '\u8bf7\u5148\u641c\u7d22\u76f8\u5173\u4fe1\u606f\uff0c\u53c2\u8003\u53ef\u9760\u7684\u516c\u5f00\u6765\u6e90\u540e\u518d\u56de\u7b54\u3002';

function positiveInteger(value, fallback, label) {
  if (value === undefined || value === null || value === '') return fallback;
  if (value === true) throw new Error(`${label} must be a positive integer.`);
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${label} must be a positive integer.`);
  return parsed;
}

function uniqueText(values) {
  const result = [];
  const seen = new Set();
  for (const rawValue of values ?? []) {
    const value = String(rawValue ?? '').trim();
    const key = value.toLocaleLowerCase();
    if (!value || seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

function taskId(now = new Date()) {
  const timestamp = now.toISOString().replace(/[-:]/gu, '').replace(/\.\d{3}Z$/u, '');
  return `geo-${timestamp}-${crypto.randomBytes(3).toString('hex')}`;
}

function normalizeBinding(value) {
  const input = typeof value === 'string' ? { id: value } : (value ?? {});
  const rawId = String(input.id ?? input.platformId ?? '').trim();
  const [platformPart, embeddedProfileId] = rawId.includes(':') ? rawId.split(':', 2) : [rawId, null];
  const definition = getPlatformDefinition(platformPart);
  const profileId = normalizeProfileId(input.profileId ?? embeddedProfileId ?? 'default');
  return {
    id: definition.id,
    profileId,
    account: String(input.account ?? '').trim() || null,
    bindingId: profileBindingId(definition.id, profileId),
    mode: definition.id === 'doubao' ? 'headed' : 'headless',
  };
}

export function normalizeTaskBindings(platforms = []) {
  const result = [];
  const seen = new Set();
  for (const platform of platforms) {
    const binding = normalizeBinding(platform);
    const key = `${binding.id}\u0000${binding.profileId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(binding);
  }
  return result;
}

export function normalizeTaskDefinition(task) {
  const settings = task?.settings ?? {};
  return {
    ...task,
    version: 4,
    platforms: normalizeTaskBindings(task?.platforms ?? []),
    settings: {
      appendSearchPrompt: Boolean(settings.appendSearchPrompt),
      answerTimeoutMs: positiveInteger(settings.answerTimeoutMs, 300_000, 'Answer timeout'),
      claimLeaseMs: positiveInteger(settings.claimLeaseMs, 360_000, 'Claim lease'),
      heartbeatIntervalMs: positiveInteger(settings.heartbeatIntervalMs, 30_000, 'Heartbeat interval'),
      maxQuestionAttempts: positiveInteger(settings.maxQuestionAttempts, 3, 'Maximum question attempts'),
      retryBaseDelayMs: Math.max(0, Number(settings.retryBaseDelayMs ?? 5_000) || 0),
      globalMaxWorkerConcurrency: positiveInteger(settings.globalMaxWorkerConcurrency, 3, 'Worker concurrency'),
      reserveMemoryMiB: positiveInteger(settings.reserveMemoryMiB, 2_048, 'Reserved memory'),
      memoryPerWorkerMiB: positiveInteger(settings.memoryPerWorkerMiB, 1_536, 'Memory per worker'),
    },
  };
}

export function createTaskDefinition({
  brandName,
  aliases = [],
  domains = [],
  questions = [],
  platforms = [],
  outputDirectory,
  profilesDirectory,
  browserExecutable = null,
  appendSearchPrompt = false,
  workerConcurrency = 3,
  now = new Date(),
} = {}) {
  const name = String(brandName ?? '').trim();
  if (!name) throw new Error('Brand name is required.');

  const normalizedQuestions = uniqueText(questions);
  if (!normalizedQuestions.length) throw new Error('At least one monitoring question is required.');
  const questionDefinitions = normalizedQuestions.map((text, index) => ({
    id: `q${String(index + 1).padStart(2, '0')}`,
    text,
  }));

  const bindings = normalizeTaskBindings(platforms);
  if (!bindings.length) throw new Error('At least one platform profile binding is required.');

  const id = taskId(now);
  return {
    version: 4,
    id,
    createdAt: now.toISOString(),
    brand: {
      name,
      aliases: uniqueText(aliases),
      ownedDomains: uniqueText(domains).map((domain) => domain.replace(/^https?:\/\//iu, '').replace(/\/.*$/u, '').toLowerCase()),
    },
    questions: questionDefinitions,
    platforms: bindings,
    settings: {
      appendSearchPrompt: Boolean(appendSearchPrompt),
      answerTimeoutMs: 300_000,
      claimLeaseMs: 360_000,
      heartbeatIntervalMs: 30_000,
      maxQuestionAttempts: 3,
      retryBaseDelayMs: 5_000,
      globalMaxWorkerConcurrency: positiveInteger(workerConcurrency, 3, 'Worker concurrency'),
      reserveMemoryMiB: 2_048,
      memoryPerWorkerMiB: 1_536,
    },
    storage: {
      outputDirectory: path.resolve(outputDirectory),
      profilesDirectory: path.resolve(profilesDirectory),
    },
    runtime: {
      browserExecutable: browserExecutable ? path.resolve(browserExecutable) : null,
    },
  };
}

export async function writeJson(filePath, value) {
  await writeJsonFile(filePath, value);
}

export async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

async function readJsonCandidate(filePath) {
  try {
    return { ok: true, value: JSON.parse(await readFile(filePath, 'utf8')) };
  } catch {
    return { ok: false, value: null };
  }
}

export async function readJsonWithBackup(filePath, backupPath, { validate = () => true } = {}) {
  for (const source of ['primary', 'backup']) {
    const candidate = await readJsonCandidate(source === 'primary' ? filePath : backupPath);
    if (!candidate.ok || !validate(candidate.value)) continue;
    return { value: candidate.value, source };
  }
  return null;
}

export async function writeJsonWithBackup(filePath, backupPath, value) {
  await writeJson(filePath, value);
  await writeJson(backupPath, value).catch(() => undefined);
}

function defaultManifest(task) {
  return {
    version: 4,
    taskId: task.id,
    status: 'created',
    createdAt: task.createdAt,
    startedAt: null,
    endedAt: null,
    bindingStates: Object.fromEntries(task.platforms.map(({ bindingId }) => [bindingId, 'pending'])),
    queue: { version: 1, path: 'runtime/queue.json' },
    queueSummary: [],
    scheduler: { decisions: [] },
  };
}

export async function readManifest(taskDirectory) {
  const files = taskFiles(taskDirectory);
  const task = await readJson(files.task);
  const stored = await readJsonWithBackup(files.manifest, files.manifestBackup, {
    validate: (manifest) => manifest?.version === 4 && manifest?.taskId === task.id,
  });
  return stored?.value ?? defaultManifest(task);
}

function artifactDate(value) {
  const timestamp = Date.parse(value ?? '');
  return Number.isFinite(timestamp) ? new Date(timestamp) : new Date();
}

async function reconcileQueueArtifacts(queue, { task, taskDirectory }) {
  let reconciled = 0;
  for (const binding of task.platforms) {
    const platformState = queue.platforms[binding.id];
    if (!platformState) continue;
    for (const question of task.questions) {
      const record = await readJsonCandidate(path.join(questionDirectory(taskDirectory, binding, question.id), 'answer.json'));
      if (!record.ok || !record.value) continue;
      const attempt = Number(record.value.attempt) || 0;
      platformState.attempts[question.id] = Math.max(Number(platformState.attempts[question.id]) || 0, attempt);
      if (record.value.status !== 'completed' || platformState.completed[question.id]) continue;
      seedCompleted(queue, {
        platformId: binding.id,
        questionId: question.id,
        bindingId: binding.bindingId,
        attempt,
        now: artifactDate(record.value.completedAt ?? record.value.endedAt ?? record.value.startedAt),
      });
      reconciled += 1;
    }
  }
  if (reconciled) queue.updatedAt = new Date().toISOString();
  return reconciled;
}

export async function loadWorkQueue({ taskDirectory, task, files = taskFiles(taskDirectory) } = {}) {
  const snapshot = await readJsonWithBackup(files.queue, files.queueBackup, {
    validate: (value) => isWorkQueueSnapshot(value, {
      taskId: task.id,
      questions: task.questions,
      platforms: task.platforms,
    }),
  });
  const queue = snapshot
    ? restoreWorkQueue(snapshot.value, {
      taskId: task.id,
      questions: task.questions,
      platforms: task.platforms,
      now: new Date(),
    })
    : createWorkQueue({
      taskId: task.id,
      questions: task.questions,
      platforms: task.platforms,
      now: new Date(),
    });
  const reconciled = await reconcileQueueArtifacts(queue, { task, taskDirectory });
  return {
    queue,
    source: snapshot?.source ?? 'rebuilt',
    recovered: !snapshot || snapshot.source === 'backup' || reconciled > 0,
    reconciled,
  };
}

export async function persistWorkQueue({ taskDirectory, queue }) {
  const files = taskFiles(taskDirectory);
  const snapshot = snapshotWorkQueue(queue);
  await writeJsonWithBackup(files.queue, files.queueBackup, snapshot);
  return snapshot;
}


export function taskFiles(taskDirectory) {
  const runtime = path.join(taskDirectory, 'runtime');
  return {
    task: path.join(taskDirectory, 'task.json'),
    manifest: path.join(taskDirectory, 'manifest.json'),
    manifestBackup: path.join(taskDirectory, 'manifest.backup.json'),
    events: path.join(taskDirectory, 'events.jsonl'),
    summary: path.join(taskDirectory, 'summary.json'),
    markdownSummary: path.join(taskDirectory, 'summary.md'),
    platforms: path.join(taskDirectory, 'platforms'),
    runtime,
    queue: path.join(runtime, 'queue.json'),
    queueBackup: path.join(runtime, 'queue.backup.json'),
    coordinatorLock: path.join(runtime, 'coordinator.lock'),
  };
}

export async function createTaskDirectory(definition) {
  const normalized = normalizeTaskDefinition(definition);
  const directory = path.join(normalized.storage.outputDirectory, normalized.id);
  const files = taskFiles(directory);
  await mkdir(files.platforms, { recursive: true });
  await mkdir(files.runtime, { recursive: true });
  await writeJson(files.task, normalized);
  const queue = createWorkQueue({
    taskId: normalized.id,
    questions: normalized.questions,
    platforms: normalized.platforms,
    now: new Date(normalized.createdAt),
  });
  await writeJsonWithBackup(files.queue, files.queueBackup, snapshotWorkQueue(queue));
  await writeJsonWithBackup(files.manifest, files.manifestBackup, {
    version: 4,
    taskId: normalized.id,
    status: 'created',
    createdAt: normalized.createdAt,
    startedAt: null,
    endedAt: null,
    bindingStates: Object.fromEntries(normalized.platforms.map(({ bindingId }) => [bindingId, 'pending'])),
    queue: { version: 1, path: 'runtime/queue.json' },
    queueSummary: [],
    scheduler: { decisions: [] },
  });
  await appendEvent(directory, { level: 'info', message: 'Task created with a shared per-platform work queue.' });
  return directory;
}

export async function appendEvent(taskDirectory, event) {
  const files = taskFiles(taskDirectory);
  const record = { at: new Date().toISOString(), ...event };
  await appendFile(files.events, `${JSON.stringify(record)}\n`, 'utf8');
}

export async function loadTask(taskDirectory) {
  const files = taskFiles(taskDirectory);
  const task = normalizeTaskDefinition(await readJson(files.task));
  return { directory: path.resolve(taskDirectory), files, task };
}

export async function updateManifest(taskDirectory, updater) {
  const files = taskFiles(taskDirectory);
  const manifest = await readManifest(taskDirectory);
  const next = await updater(manifest);
  await writeJsonWithBackup(files.manifest, files.manifestBackup, next ?? manifest);
  return next ?? manifest;
}

export function bindingDirectory(taskDirectory, binding) {
  const platformId = typeof binding === 'string' ? binding.split(':')[0] : binding.id;
  const profileId = typeof binding === 'string' ? (binding.split(':')[1] ?? 'default') : (binding.profileId ?? 'default');
  return path.join(taskDirectory, 'platforms', platformId, 'profiles', profileId);
}

export function platformDirectory(taskDirectory, binding) {
  return bindingDirectory(taskDirectory, binding);
}

export function questionDirectory(taskDirectory, binding, questionId) {
  return path.join(bindingDirectory(taskDirectory, binding), 'questions', questionId);
}

export function submittedQuestion(question, appendSearchPrompt) {
  return appendSearchPrompt ? `${question}\n\n${SEARCH_PROMPT_SUFFIX}` : question;
}