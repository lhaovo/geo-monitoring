import { mkdir, readdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { pathExists, readJsonFile, writeJsonFile } from './fs.mjs';

export const PLATFORM_DEFINITIONS = Object.freeze({
  deepseek: Object.freeze({ id: 'deepseek', label: 'DeepSeek', loginMethod: 'password', defaultMode: 'headless' }),
  doubao: Object.freeze({ id: 'doubao', label: '豆包', loginMethod: 'sms_code', defaultMode: 'headed' }),
  kimi: Object.freeze({ id: 'kimi', label: 'Kimi', loginMethod: 'sms_code', defaultMode: 'headless' }),
  qwen: Object.freeze({ id: 'qwen', label: '千问', loginMethod: 'sms_code', defaultMode: 'headless' }),
  wenxiaoyan: Object.freeze({ id: 'wenxiaoyan', label: '文小言', loginMethod: 'sms_code', defaultMode: 'headless' }),
  yuanbao: Object.freeze({ id: 'yuanbao', label: '腾讯元宝', loginMethod: 'sms_code', defaultMode: 'headless' }),
});

export const SUPPORTED_PLATFORMS = Object.freeze(Object.keys(PLATFORM_DEFINITIONS));

const PROFILE_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,47}$/u;
const RESERVED_PROFILE_IDS = new Set(['chrome', 'index', 'profile']);

export function getPlatformDefinition(platformId) {
  const normalized = String(platformId ?? '').trim().toLowerCase();
  const definition = PLATFORM_DEFINITIONS[normalized];
  if (!definition) {
    throw new Error(`Unsupported platform: ${platformId}. Supported: ${SUPPORTED_PLATFORMS.join(', ')}.`);
  }
  return definition;
}

export function normalizeProfileId(profileId) {
  const normalized = String(profileId ?? '').trim().toLowerCase();
  if (!PROFILE_ID_PATTERN.test(normalized) || RESERVED_PROFILE_IDS.has(normalized)) {
    throw new Error('Profile id must start with a letter or digit, contain only lowercase letters, digits, hyphens, or underscores, and be at most 48 characters.');
  }
  return normalized;
}

function normalizePhone(value) {
  let phone = String(value ?? '').trim().replace(/[\s()-]/gu, '');
  if (!/^\+?\d{7,20}$/u.test(phone)) return null;
  if (phone.startsWith('+')) phone = `+${phone.slice(1).replace(/\D/gu, '')}`;
  if (!phone.startsWith('+') && phone.length === 13 && phone.startsWith('86')) phone = phone.slice(2);
  if (phone.startsWith('+86') && phone.length === 14) phone = phone.slice(3);
  return phone;
}

export function normalizeAccountIdentity(account) {
  const text = String(account ?? '').trim();
  if (!text) return '';
  const phone = normalizePhone(text);
  if (phone) return phone;
  return text.normalize('NFKC').toLowerCase();
}

export function profileIdFromAccount(account) {
  const identity = normalizeAccountIdentity(account);
  if (!identity) throw new Error('An account or phone number is required.');
  const slug = identity
    .replace(/[^a-z0-9_-]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 48);
  if (!slug || !PROFILE_ID_PATTERN.test(slug) || RESERVED_PROFILE_IDS.has(slug)) {
    throw new Error(`Cannot derive a profile id from "${account}". Use a phone number or an account made of letters, digits, dots, hyphens or underscores.`);
  }
  return slug;
}

export function profilePaths(profilesDirectory, platformId, profileId) {
  const definition = getPlatformDefinition(platformId);
  const normalizedProfileId = normalizeProfileId(profileId);
  const root = path.resolve(profilesDirectory);
  const platformDirectory = path.join(root, definition.id);
  const profileDirectory = path.join(platformDirectory, normalizedProfileId);
  return {
    root,
    platformDirectory,
    platformIndex: path.join(platformDirectory, 'index.json'),
    profileDirectory,
    metadata: path.join(profileDirectory, 'profile.json'),
    chromeDirectory: path.join(profileDirectory, 'chrome'),
  };
}

export function profileBindingId(platformId, profileId) {
  return `${getPlatformDefinition(platformId).id}:${normalizeProfileId(profileId)}`;
}

async function readPlatformIndex(paths) {
  return readJsonFile(paths.platformIndex, {
    fallback: { version: 1, platformId: path.basename(paths.platformDirectory), defaultProfileId: null, profileIds: [] },
  });
}

async function writePlatformIndex(paths, index) {
  const profileIds = [...new Set(index.profileIds ?? [])].sort();
  const defaultProfileId = profileIds.includes(index.defaultProfileId) ? index.defaultProfileId : profileIds[0] ?? null;
  await writeJsonFile(paths.platformIndex, {
    version: 1,
    platformId: index.platformId,
    defaultProfileId,
    profileIds,
  });
}

async function discoverProfileIds(paths) {
  if (!await pathExists(paths.platformDirectory)) return [];
  const entries = await readdir(paths.platformDirectory, { withFileTypes: true });
  const results = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    try {
      const profileId = normalizeProfileId(entry.name);
      if (await pathExists(path.join(paths.platformDirectory, profileId, 'profile.json'))) results.push(profileId);
    } catch {
      // Ignore directories that are not valid profile ids.
    }
  }
  return results;
}

export async function readProfile({ profilesDirectory, platformId, profileId }) {
  const paths = profilePaths(profilesDirectory, platformId, profileId);
  try {
    return { ...await readJsonFile(paths.metadata), paths };
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

export async function requireProfile({ profilesDirectory, platformId, profileId }) {
  const profile = await readProfile({ profilesDirectory, platformId, profileId });
  if (!profile) {
    const error = new Error(`Profile not found: ${platformId}/${profileId}. Create it with profile.mjs create first.`);
    error.code = 'profile_not_found';
    throw error;
  }
  return profile;
}

export async function listProfiles({ profilesDirectory, platformId } = {}) {
  const platforms = platformId ? [getPlatformDefinition(platformId).id] : SUPPORTED_PLATFORMS;
  const profiles = [];
  for (const id of platforms) {
    const paths = profilePaths(profilesDirectory, id, 'default');
    const index = await readPlatformIndex(paths);
    const diskProfileIds = await discoverProfileIds(paths);
    const profileIds = [...new Set([...(index.profileIds ?? []), ...diskProfileIds])].sort();
    for (const profileId of profileIds) {
      const profile = await readProfile({ profilesDirectory, platformId: id, profileId });
      if (profile) profiles.push(profile);
    }
  }
  return profiles;
}

export function profileAccount(profile, account) {
  return String(account ?? profile?.account ?? '').trim();
}

export async function createProfile({ profilesDirectory, platformId, account, profileId } = {}) {
  const definition = getPlatformDefinition(platformId);
  const identity = normalizeAccountIdentity(account);
  if (!identity) throw new Error('An account or phone number is required to create a profile.');
  const selectedId = profileId ? normalizeProfileId(profileId) : profileIdFromAccount(identity);
  const paths = profilePaths(profilesDirectory, definition.id, selectedId);

  const existing = await readProfile({ profilesDirectory, platformId: definition.id, profileId: selectedId });
  if (existing) {
    const refreshed = existing.account === identity
      ? existing
      : await updateProfile({
          profilesDirectory,
          platformId: definition.id,
          profileId: selectedId,
          patch: { account: identity },
        });
    const index = await readPlatformIndex(paths);
    if (!(index.profileIds ?? []).includes(selectedId)) {
      await writePlatformIndex(paths, {
        ...index,
        platformId: definition.id,
        profileIds: [...(index.profileIds ?? []), selectedId],
      });
    }
    return { ...refreshed, created: false };
  }

  const now = new Date().toISOString();
  const profile = {
    version: 2,
    profileId: selectedId,
    account: identity,
    platformId: definition.id,
    loginMethod: definition.loginMethod,
    health: 'new',
    createdAt: now,
    updatedAt: now,
    lastLoginAt: null,
    lastVerifiedAt: null,
    lastUsedAt: null,
    restrictedUntil: null,
    lastError: null,
  };
  await mkdir(paths.profileDirectory, { recursive: true, mode: 0o700 });
  await writeJsonFile(paths.metadata, profile);

  const index = await readPlatformIndex(paths);
  const profileIds = [...new Set([...(index.profileIds ?? []), selectedId])];
  await writePlatformIndex(paths, {
    ...index,
    platformId: definition.id,
    defaultProfileId: index.defaultProfileId ?? selectedId,
    profileIds,
  });
  return { ...profile, created: true, paths };
}

export async function updateProfile({ profilesDirectory, platformId, profileId, patch }) {
  const profile = await requireProfile({ profilesDirectory, platformId, profileId });
  const next = {
    ...profile,
    ...patch,
    profileId: profile.profileId,
    platformId: profile.platformId,
    version: patch?.version ?? profile.version,
    updatedAt: new Date().toISOString(),
  };
  delete next.paths;
  await writeJsonFile(profile.paths.metadata, next);
  return { ...next, paths: profile.paths };
}

export async function rebindProfile({ profilesDirectory, platformId, profileId, account }) {
  const normalizedAccount = String(account ?? '').trim();
  if (!normalizedAccount) throw new Error('An account or phone number is required.');
  const definition = getPlatformDefinition(platformId);
  const profile = await requireProfile({ profilesDirectory, platformId: definition.id, profileId });
  const targetId = profileIdFromAccount(normalizedAccount);
  if (targetId === profile.profileId) {
    return updateProfile({
      profilesDirectory,
      platformId: definition.id,
      profileId,
      patch: { account: normalizeAccountIdentity(normalizedAccount), version: 2 },
    });
  }

  const target = profilePaths(profilesDirectory, definition.id, targetId);
  if (await pathExists(target.metadata)) {
    const error = new Error(`Profile ${definition.id}/${targetId} already exists for this account.`);
    error.code = 'profile_exists';
    throw error;
  }

  await rename(profile.paths.profileDirectory, target.profileDirectory);
  const index = await readPlatformIndex(target);
  const profileIds = [...new Set([...(index.profileIds ?? []).filter((id) => id !== profile.profileId), targetId])];
  await writePlatformIndex(target, {
    ...index,
    platformId: definition.id,
    defaultProfileId: index.defaultProfileId === profile.profileId ? targetId : index.defaultProfileId,
    profileIds,
  });

  const next = {
    ...profile,
    version: 2,
    profileId: targetId,
    account: normalizeAccountIdentity(normalizedAccount),
    updatedAt: new Date().toISOString(),
  };
  delete next.paths;
  delete next.label;
  delete next.accountHint;
  delete next.accountFingerprint;
  await writeJsonFile(target.metadata, next);
  return { ...next, paths: target };
}

export async function setDefaultProfile({ profilesDirectory, platformId, profileId }) {
  const profile = await requireProfile({ profilesDirectory, platformId, profileId });
  const index = await readPlatformIndex(profile.paths);
  await writePlatformIndex(profile.paths, { ...index, defaultProfileId: profile.profileId });
  return profile;
}

export async function defaultProfile({ profilesDirectory, platformId }) {
  const definition = getPlatformDefinition(platformId);
  const paths = profilePaths(profilesDirectory, definition.id, 'default');
  const index = await readPlatformIndex(paths);
  if (!index.defaultProfileId) return null;
  return readProfile({ profilesDirectory, platformId: definition.id, profileId: index.defaultProfileId });
}

export function loginMethodLabel(loginMethod) {
  return loginMethod === 'password' ? '密码登录' : '短信验证码登录';
}
