import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  appendRunLog,
  createRunArtifacts,
  createRunId,
  writeRunRecord,
} from '../src/run-artifacts.js';

test('uses a filesystem-safe timestamp for a run id', () => {
  assert.equal(createRunId(new Date('2026-08-03T12:34:56.789Z')), '2026-08-03T12-34-56-789Z');
});

test('creates isolated profile and evidence paths for a platform', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'geo-monitoring-'));
  try {
    const artifacts = await createRunArtifacts(root, 'kimi', new Date('2026-08-03T12:34:56.000Z'));
    await writeRunRecord(artifacts.recordPath, { platform: 'kimi', status: 'page_opened' });
    await appendRunLog(artifacts.logPath, 'Opened page', new Date('2026-08-03T12:35:00.000Z'));

    assert.match(artifacts.profileDirectory, /profiles[\\/]kimi$/);
    assert.match(artifacts.runDirectory, /runs[\\/]kimi[\\/]2026-08-03T12-34-56-000Z$/);
    assert.deepEqual(JSON.parse(await readFile(artifacts.recordPath, 'utf8')), {
      platform: 'kimi',
      status: 'page_opened',
    });
    assert.match(await readFile(artifacts.logPath, 'utf8'), /Opened page/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('keeps the evidence record valid when concurrent updates finish together', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'geo-monitoring-'));
  try {
    const artifacts = await createRunArtifacts(root, 'doubao');
    await Promise.all(
      Array.from({ length: 12 }, (_, index) => writeRunRecord(artifacts.recordPath, { sequence: index })),
    );

    const record = JSON.parse(await readFile(artifacts.recordPath, 'utf8'));
    assert.equal(Number.isInteger(record.sequence), true);
    assert.ok(record.sequence >= 0 && record.sequence < 12);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
