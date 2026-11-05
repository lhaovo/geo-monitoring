import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { writeJsonFile } from "../scripts/lib/fs.mjs";
import { acquireCoordinatorLock, coordinatorLockPath, readCoordinatorLock } from "../scripts/lib/coordinator-lock.mjs";
import { createTaskDefinition, createTaskDirectory, readJson, taskFiles } from "../scripts/lib/task.mjs";

async function makeTask(root) {
  const definition = createTaskDefinition({
    brandName: "Brand",
    questions: ["Q1"],
    platforms: ["kimi"],
    outputDirectory: path.join(root, "output"),
    profilesDirectory: path.join(root, "profiles"),
  });
  const taskDirectory = await createTaskDirectory(definition);
  const task = await readJson(taskFiles(taskDirectory).task);
  return { taskDirectory, task };
}

test("allows only one coordinator for a task and releases the lock", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "geo-coordinator-lock-"));
  try {
    const { taskDirectory, task } = await makeTask(root);
    const first = await acquireCoordinatorLock({ taskDirectory, taskId: task.id, ownerId: "first" });
    assert.equal(first.recovered, false);
    assert.equal((await readCoordinatorLock(taskDirectory)).ownerId, "first");
    await assert.rejects(
      acquireCoordinatorLock({ taskDirectory, taskId: task.id, ownerId: "second" }),
      (error) => error.code === "task_already_running",
    );
    await first.release();
    assert.equal(await readCoordinatorLock(taskDirectory), null);
    const second = await acquireCoordinatorLock({ taskDirectory, taskId: task.id, ownerId: "second" });
    await second.release();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("takes over an abandoned coordinator lock", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "geo-coordinator-stale-"));
  try {
    const { taskDirectory, task } = await makeTask(root);
    const staleAt = new Date(Date.now() - 60_000).toISOString();
    await writeJsonFile(coordinatorLockPath(taskDirectory), {
      version: 1,
      taskId: task.id,
      ownerId: "dead-owner",
      pid: 999999,
      hostname: os.hostname(),
      startedAt: staleAt,
      heartbeatAt: staleAt,
    });
    const lock = await acquireCoordinatorLock({ taskDirectory, taskId: task.id, ownerId: "recovery", staleMs: 1_000 });
    assert.equal(lock.recovered, true);
    assert.equal(lock.previousLock.ownerId, "dead-owner");
    await lock.release();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reports lock loss when another coordinator replaces the file", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "geo-coordinator-lost-"));
  try {
    const { taskDirectory, task } = await makeTask(root);
    let lostCode = null;
    const first = await acquireCoordinatorLock({
      taskDirectory,
      taskId: task.id,
      ownerId: "first",
      onLost: (error) => { lostCode = error.code; },
    });
    await writeJsonFile(coordinatorLockPath(taskDirectory), {
      version: 1,
      taskId: task.id,
      ownerId: "second",
      pid: process.pid,
      hostname: os.hostname(),
      startedAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
    });
    assert.equal(await first.refresh(), false);
    assert.equal(lostCode, "coordinator_lock_lost");
    assert.equal(first.lost, true);
    await first.release();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
