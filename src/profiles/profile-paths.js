import path from 'node:path';
import { normalizeProfileId } from './account-identity.js';

// 每个平台的登录态都放在独立目录：<profiles>/<platform>/<profileId>/chrome。
// Profile 目录互不共享，避免多账号并行时互相覆盖 Cookie 与 LocalStorage。
export function profilePaths(paths, platformId, profileId) {
  const normalizedProfileId = normalizeProfileId(profileId);
  const root = path.resolve(paths.profilesDirectory);
  const platformDirectory = path.join(root, platformId);
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

export function profileChromeDirectory(paths, platformId, profileId) {
  return profilePaths(paths, platformId, profileId).chromeDirectory;
}
