import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { isProcessAlive } from "./profile-lock.mjs";

export const DEFAULT_COORDINATOR_STALE_MS = 120_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;

export function coordinatorLockPath(taskDirectory) {
  return path.join(taskDirectory, "runtime", "coordinator.lock");
}

export async function readCoordinatorLock(taskDirectory) {
  try {
    return JSON.parse(await readFile(coordinatorLockPath(taskDirectory), "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    return null;
  }
}

function lockIsStale(lock, staleMs) {
  if (!lock || lock.version !== 1) return true;
  if (lock.hostname === os.hostname() && !isProcessAlive(Number(lock.pid))) return true;
  const heartbeat = Date.parse(lock.heartbeatAt ?? lock.startedAt ?? "");
  return !Number.isFinite(heartbeat) || Date.now() - heartbeat > staleMs;
}

async function createLock(lockPath, lock) {
  const handle = await open(lockPath, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(lock, null, 2) + "\n", "utf8");
  } finally {
    await handle.close();
  }
}

function lostError(message, cause) {
  const error = new Error(message);
  error.code = "coordinator_lock_lost";
  if (cause) error.cause = cause;
  return error;
}

export async function acquireCoordinatorLock({
  taskDirectory,
  taskId,
  ownerId = crypto.randomUUID(),
  staleMs = DEFAULT_COORDINATOR_STALE_MS,
  heartbeatIntervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS,
  onLost = null,
} = {}) {
  if (!taskDirectory) throw new Error("Task directory is required for the coordinator lock.");
  if (!taskId) throw new Error("Task id is required for the coordinator lock.");

  const lockPath = coordinatorLockPath(taskDirectory);
  const normalizedOwnerId = String(ownerId);
  await mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });

  let previousLock = null;
  let recovered = false;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const now = new Date().toISOString();
    const lock = {
      version: 1,
      taskId,
      ownerId: normalizedOwnerId,
      pid: process.pid,
      hostname: os.hostname(),
      startedAt: now,
      heartbeatAt: now,
    };
    try {
      await createLock(lockPath, lock);
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      previousLock = await readCoordinatorLock(taskDirectory);
      if (!lockIsStale(previousLock, staleMs) || attempt > 0) {
        const conflict = new Error("Task " + taskId + " is already running under coordinator " + (previousLock?.ownerId ?? "unknown") + " (pid " + (previousLock?.pid ?? "unknown") + ").");
        conflict.code = "task_already_running";
        conflict.lock = previousLock;
        throw conflict;
      }
      recovered = true;
      await unlink(lockPath).catch((unlinkError) => {
        if (unlinkError?.code !== "ENOENT") throw unlinkError;
      });
    }
  }

  let released = false;
  let lost = null;
  let heartbeat = null;
  const markLost = async (error) => {
    if (lost || released) return;
    lost = error;
    if (heartbeat) clearInterval(heartbeat);
    if (typeof onLost === "function") {
      try {
        await onLost(error);
      } catch {
        // The owner callback must not mask the lock-loss state.
      }
    }
  };

  const refresh = async () => {
    if (released || lost) return false;
    let handle = null;
    try {
      handle = await open(lockPath, "r+");
      const current = JSON.parse(await handle.readFile("utf8"));
      if (current.ownerId !== normalizedOwnerId || current.pid !== process.pid) {
        throw lostError("Coordinator lock ownership changed.");
      }
      current.heartbeatAt = new Date().toISOString();
      const serialized = JSON.stringify(current, null, 2) + "\n";
      await handle.truncate(0);
      await handle.write(serialized, 0, "utf8");
      return true;
    } catch (error) {
      const normalized = error?.code === "coordinator_lock_lost"
        ? error
        : lostError("Coordinator lock is missing, unreadable, or no longer owned by this process.", error);
      await markLost(normalized);
      return false;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  };

  heartbeat = setInterval(() => {
    void refresh();
  }, Math.max(1_000, Number(heartbeatIntervalMs) || DEFAULT_HEARTBEAT_INTERVAL_MS));
  heartbeat.unref();

  const release = async () => {
    if (released) return;
    released = true;
    if (heartbeat) clearInterval(heartbeat);
    if (lost) return;
    const current = await readCoordinatorLock(taskDirectory);
    if (current?.ownerId === normalizedOwnerId && current?.pid === process.pid) {
      await unlink(lockPath).catch(() => undefined);
    }
  };

  return {
    lockPath,
    ownerId: normalizedOwnerId,
    recovered,
    previousLock,
    refresh,
    release,
    get lost() { return Boolean(lost); },
    get lostError() { return lost; },
  };
}
