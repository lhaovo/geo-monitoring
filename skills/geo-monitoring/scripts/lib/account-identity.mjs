import { getPlatformDefinition, listProfiles, normalizeAccountIdentity } from './profiles.mjs';

function projectExistingProfile(profile) {
  return {
    platformId: profile.platformId,
    profileId: profile.profileId,
    account: profile.account ?? null,
    health: profile.health,
    lastLoginAt: profile.lastLoginAt ?? null,
  };
}

export async function describeAccountBinding({
  profilesDirectory,
  platformId,
  profileId = null,
  account,
} = {}) {
  const platform = getPlatformDefinition(platformId).id;
  const identity = normalizeAccountIdentity(account);
  if (!identity) throw new Error('An account or phone number is required.');
  const profiles = await listProfiles({ profilesDirectory, platformId: platform });
  const matches = profiles.filter((profile) => (
    profile.account ? normalizeAccountIdentity(profile.account) === identity : false
  ));
  const selectedProfileId = profileId ? String(profileId) : null;
  const currentMatch = selectedProfileId
    ? matches.find((profile) => profile.profileId === selectedProfileId) ?? null
    : null;
  const matchingProfiles = matches.map(projectExistingProfile);
  const status = currentMatch
    ? 'bound_to_current'
    : matches.length > 0
      ? 'bound_elsewhere'
      : 'unbound';
  const preferredProfile = matchingProfiles[0] ?? null;
  const message = status === 'bound_elsewhere'
    ? `该账号已绑定到 ${platform}:${preferredProfile.profileId}。如需复用，请改用该 Profile；继续当前登录会创建另一个独立登录态。`
    : status === 'bound_to_current'
      ? `该账号已绑定到当前 Profile ${platform}:${currentMatch.profileId}。`
      : '该账号尚未绑定到当前平台的任何 Profile。';

  return {
    account: String(account ?? '').trim(),
    status,
    decisionRequired: status === 'bound_elsewhere',
    existingProfiles: matchingProfiles,
    preferredProfile,
    currentProfileId: currentMatch?.profileId ?? null,
    message,
  };
}

export function projectAccountBinding(binding) {
  if (!binding) return null;
  return {
    account: binding.account ?? null,
    status: binding.status ?? 'unknown',
    decisionRequired: Boolean(binding.decisionRequired),
    existingProfiles: Array.isArray(binding.existingProfiles) ? binding.existingProfiles : [],
    preferredProfile: binding.preferredProfile ?? null,
    currentProfileId: binding.currentProfileId ?? null,
    message: binding.message ?? null,
  };
}
