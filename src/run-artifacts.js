import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const recordWriteQueues = new Map();

export function createRunId(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

export async function createRunArtifacts(dataDirectory, platformId, date = new Date()) {
  const runId = createRunId(date);
  const runDirectory = path.join(dataDirectory, 'runs', platformId, runId);
  const profileDirectory = path.join(dataDirectory, 'profiles', platformId);

  await Promise.all([
    mkdir(runDirectory, { recursive: true }),
    mkdir(profileDirectory, { recursive: true }),
  ]);

  return {
    profileDirectory,
    runDirectory,
    recordPath: path.join(runDirectory, 'run.json'),
    logPath: path.join(runDirectory, 'events.log'),
  };
}

export async function writeRunRecord(recordPath, record) {
  const content = `${JSON.stringify(record, null, 2)}\n`;
  const previousWrite = recordWriteQueues.get(recordPath) ?? Promise.resolve();
  const currentWrite = previousWrite
    .catch(() => undefined)
    .then(() => writeFile(recordPath, content, 'utf8'));

  recordWriteQueues.set(recordPath, currentWrite);

  try {
    await currentWrite;
  } finally {
    if (recordWriteQueues.get(recordPath) === currentWrite) {
      recordWriteQueues.delete(recordPath);
    }
  }
}

export async function appendRunLog(logPath, message, date = new Date()) {
  await appendFile(logPath, `[${date.toISOString()}] ${message}\n`, 'utf8');
}
