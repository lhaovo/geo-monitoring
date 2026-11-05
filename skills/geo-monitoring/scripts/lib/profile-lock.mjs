import { mkdir, open, readFile, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { profilePaths } from './profiles.mjs';

const DEFAULT_STALE_MS = 120_000;

export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

export function lockPathFor({ profilesDirectory, platformId, profileId }) {
  const { root } = profilePaths(profilesDirectory, platformId, profileId);
  return path.join(root, '.locks', `${platformId}-${profileId}.lock`);
}

export async function readProfileLock({ profilesDirectory, platformId, profileId }) {
  const lockPath = lockPathFor({ profilesDirectory, platformId, profileId });
  try {
    return JSON.parse(await readFile(lockPath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function tryCreateLock(lockPath, lock) {
  const handle = await open(lockPath, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(lock, null, 2)}\n`, 'utf8');
  } finally {
    await handle.close();
  }
}

function stale(lock, staleMs) {
  if (!lock) return true;
  if (lock.hostname === os.hostname() && !isProcessAlive(Number(lock.pid))) return true;
  const heartbeat = Date.parse(lock.heartbeatAt ?? lock.startedAt ?? '');
  return !Number.isFinite(heartbeat) || Date.now() - heartbeat > staleMs;
}

export async function acquireProfileLock({
  profilesDirectory,
  platformId,
  profileId,
  ownerType,
  ownerId,
  staleMs = DEFAULT_STALE_MS,
} = {}) {
  const lockPath = lockPathFor({ profilesDirectory, platformId, profileId });
  await mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });

  const create = async () => {
    const now = new Date().toISOString();
    await tryCreateLock(lockPath, {
      version: 1,
      platformId,
      profileId,
      ownerType,
      ownerId: String(ownerId),
      pid: process.pid,
      hostname: os.hostname(),
      startedAt: now,
      heartbeatAt: now,
    });
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await create();
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      let current = null;
      try {
        current = JSON.parse(await readFile(lockPath, 'utf8'));
      } catch {
        // Corrupt lock files are stale.
      }
      if (!stale(current, staleMs) || attempt > 0) {
        const lockError = new Error(`Profile is locked by ${current?.ownerType ?? 'unknown'} ${current?.ownerId ?? ''} (pid ${current?.pid ?? 'unknown'}).`);
        lockError.code = 'profile_locked';
        lockError.lock = current;
        throw lockError;
      }
      await unlink(lockPath).catch((unlinkError) => {
        if (unlinkError?.code !== 'ENOENT') throw unlinkError;
      });
    }
  }

  let released = false;
  const refresh = async () => {
    if (released) return;
    let current;
    try {
      current = JSON.parse(await readFile(lockPath, 'utf8'));
    } catch {
      return;
    }
    if (current.ownerId !== String(ownerId) || current.pid !== process.pid) return;
    current.heartbeatAt = new Date().toISOString();
    await writeFile(lockPath, `${JSON.stringify(current, null, 2)}\n`, 'utf8').catch(() => undefined);
  };
  const heartbeat = setInterval(() => { void refresh(); }, 15_000);
  heartbeat.unref();

  const release = async () => {
    if (released) return;
    released = true;
    clearInterval(heartbeat);
    let current = null;
    try {
      current = JSON.parse(await readFile(lockPath, 'utf8'));
    } catch {
      return;
    }
    if (current.ownerId === String(ownerId) && current.pid === process.pid) await unlink(lockPath).catch(() => undefined);
  };

  return { lockPath, refresh, release };
}
