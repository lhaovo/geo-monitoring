import path from 'node:path';
import { option, parseArgs, required } from './lib/cli.mjs';
import { verifyProfileLogin } from './lib/login-runner.mjs';
import { acquireProfileLock } from './lib/profile-lock.mjs';
import {
  createProfile,
  defaultProfile,
  listProfiles,
  loginMethodLabel,
  PLATFORM_DEFINITIONS,
  rebindProfile,
  requireProfile,
  setDefaultProfile,
  updateProfile,
} from './lib/profiles.mjs';
import { pathExists } from './lib/fs.mjs';

function output(value, exitCode = 0) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  if (exitCode) process.exitCode = exitCode;
}

function profilesDirectoryFrom(options) {
  return path.resolve(option(options, 'profiles', path.join(process.cwd(), 'profiles')));
}

function projectProfile(profile, defaultProfileId) {
  return {
    platform: profile.platformId,
    profile: profile.profileId,
    platformId: profile.platformId,
    profileId: profile.profileId,
    account: profile.account ?? null,
    loginMethod: profile.loginMethod,
    loginMethodLabel: loginMethodLabel(profile.loginMethod),
    health: profile.health,
    default: profile.profileId === defaultProfileId,
    lastLoginAt: profile.lastLoginAt,
    lastVerifiedAt: profile.lastVerifiedAt,
    lastUsedAt: profile.lastUsedAt,
    restrictedUntil: profile.restrictedUntil ?? null,
    lastError: profile.lastError,
  };
}

async function listCommand(options, profilesDirectory) {
  const platformId = option(options, 'platform');
  const profiles = await listProfiles({ profilesDirectory, platformId });
  const defaults = new Map();
  for (const platform of Object.keys(PLATFORM_DEFINITIONS)) {
    const selected = await defaultProfile({ profilesDirectory, platformId: platform });
    defaults.set(platform, selected?.profileId ?? null);
  }
  return output({
    profiles: profiles.map((profile) => projectProfile(profile, defaults.get(profile.platformId))),
    platforms: Object.values(PLATFORM_DEFINITIONS).map(({ id, label, loginMethod, defaultMode }) => ({
      platformId: id,
      label,
      loginMethod,
      loginMethodLabel: loginMethodLabel(loginMethod),
      defaultMode,
    })),
  });
}

async function createCommand(options, profilesDirectory) {
  const platformId = required(options, 'platform');
  const account = required(options, 'account');
  const profile = await createProfile({
    profilesDirectory,
    platformId,
    account,
    profileId: option(options, 'id') ?? option(options, 'profile'),
  });
  const selected = await defaultProfile({ profilesDirectory, platformId });
  return output({ ...projectProfile(profile, selected?.profileId), created: Boolean(profile.created) });
}

async function defaultCommand(options, profilesDirectory) {
  const platformId = required(options, 'platform');
  const profileId = required(options, 'profile');
  const profile = await setDefaultProfile({ profilesDirectory, platformId, profileId });
  return output(projectProfile(profile, profile.profileId));
}

async function rebindCommand(options, profilesDirectory) {
  const platformId = required(options, 'platform');
  const profile = await rebindProfile({
    profilesDirectory,
    platformId,
    profileId: required(options, 'profile'),
    account: required(options, 'account'),
  });
  const selected = await defaultProfile({ profilesDirectory, platformId });
  return output(projectProfile(profile, selected?.profileId));
}

async function setEnabled(options, profilesDirectory, enabled) {
  const platformId = required(options, 'platform');
  const profileId = required(options, 'profile');
  const current = await requireProfile({ profilesDirectory, platformId, profileId });
  const profile = await updateProfile({
    profilesDirectory,
    platformId,
    profileId,
    patch: {
      health: enabled ? (current.health === 'disabled' ? 'expired' : current.health) : 'disabled',
      lastError: enabled ? current.lastError : null,
    },
  });
  const selected = await defaultProfile({ profilesDirectory, platformId });
  return output(projectProfile(profile, selected?.profileId));
}

async function checkCommand(options, profilesDirectory) {
  const platformId = required(options, 'platform');
  const profileId = required(options, 'profile');
  const profile = await requireProfile({ profilesDirectory, platformId, profileId });
  if (!await pathExists(profile.paths.chromeDirectory)) {
    const updated = await updateProfile({
      profilesDirectory,
      platformId,
      profileId,
      patch: { health: 'new', lastError: { at: new Date().toISOString(), category: 'login_required', message: 'No saved login profile exists yet.' } },
    });
    const selected = await defaultProfile({ profilesDirectory, platformId });
    return output({
      ...projectProfile(updated, selected?.profileId),
      state: 'login_required',
      nextAction: 'start_login',
      message: 'Login is required.',
    }, 1);
  }

  const lock = await acquireProfileLock({
    profilesDirectory,
    platformId,
    profileId,
    ownerType: 'check',
    ownerId: `check-${process.pid}`,
  });
  try {
    await verifyProfileLogin({
      adapter: (await import('./lib/platforms/index.mjs')).getPlatformAdapter(platformId),
      chromeDirectory: profile.paths.chromeDirectory,
      browserExecutable: option(options, 'browser'),
    });
    const checkedAt = new Date().toISOString();
    const updated = await updateProfile({
      profilesDirectory,
      platformId,
      profileId,
      patch: { health: 'ready', lastVerifiedAt: checkedAt, lastError: null },
    });
    const selected = await defaultProfile({ profilesDirectory, platformId });
    return output({
      ...projectProfile(updated, selected?.profileId),
      state: 'authenticated',
      nextAction: 'none',
      message: 'Login state is verified.',
      checkedAt,
    });
  } catch (error) {
    const checkedAt = new Date().toISOString();
    const restrictedUntil = error?.loginState?.restrictedUntil ?? error?.restrictedUntil ?? null;
    const state = error?.code === 'account_restricted'
      ? 'restricted'
      : /login|chat input|\u9a8c\u8bc1\u7801|challenge/iu.test(error.message) ? 'expired' : 'error';
    const updated = await updateProfile({
      profilesDirectory,
      platformId,
      profileId,
      patch: {
        health: state,
        ...(restrictedUntil ? { restrictedUntil } : {}),
        lastError: { at: checkedAt, category: error.code ?? 'check_failed', message: error.message, ...(restrictedUntil ? { restrictedUntil } : {}) },
      },
    });
    const selected = await defaultProfile({ profilesDirectory, platformId });
    return output({
      ...projectProfile(updated, selected?.profileId),
      state,
      nextAction: state === 'restricted' ? 'wait_until_restriction_lifts' : state === 'expired' ? 'start_login' : 'inspect_login_error',
      restrictedUntil,
      message: error.message,
      checkedAt,
    }, 1);
  } finally {
    await lock.release();
  }
}

async function main() {
  const { options, positional } = parseArgs();
  const command = positional[0] ?? (option(options, 'help') ? 'help' : null);
  const profilesDirectory = profilesDirectoryFrom(options);
  if (!command || command === 'help') {
    return output({
      usage: 'node scripts/profile.mjs <list|create|rebind|default|check|enable|disable> [options]',
      commands: {
        list: '[--platform <id>] [--profiles <dir>]',
        create: '--platform <id> --account <account-or-phone> [--id <profile-id>] [--profiles <dir>]',
        rebind: '--platform <id> --profile <profile-id> --account <account-or-phone> [--profiles <dir>]',
        default: '--platform <id> --profile <profile-id> [--profiles <dir>]',
        check: '--platform <id> --profile <profile-id> [--browser <path>] [--profiles <dir>]',
        enable: '--platform <id> --profile <profile-id> [--profiles <dir>]',
        disable: '--platform <id> --profile <profile-id> [--profiles <dir>]',
      },
    });
  }
  if (command === 'list') return listCommand(options, profilesDirectory);
  if (command === 'create') return createCommand(options, profilesDirectory);
  if (command === 'rebind') return rebindCommand(options, profilesDirectory);
  if (command === 'default') return defaultCommand(options, profilesDirectory);
  if (command === 'check') return checkCommand(options, profilesDirectory);
  if (command === 'enable') return setEnabled(options, profilesDirectory, true);
  if (command === 'disable') return setEnabled(options, profilesDirectory, false);
  throw new Error(`Unknown profile command: ${command}.`);
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ error: { code: error.code ?? 'profile_error', message: error.message } })}\n`);
  process.exitCode = 1;
});
