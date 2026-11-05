import { mkdir } from 'node:fs/promises';
import path, { relative } from 'node:path';
import { profilePaths } from '../profiles/profile-paths.js';

export async function createPlatformRunArtifacts(paths, runId, platformRunId, platformId, profileId = '') {
  const directory = path.join(paths.artifactsDirectory, runId, platformRunId);
  // 登录态目录按平台与 Profile 隔离；未指定 Profile 时退回到平台默认目录。
  const profileDirectory = profileId
    ? profilePaths(paths, platformId, profileId).chromeDirectory
    : path.join(paths.profilesDirectory, platformId);
  await Promise.all([
    mkdir(directory, { recursive: true }),
    mkdir(profileDirectory, { recursive: true }),
  ]);
  return { directory, profileDirectory };
}

export function relativeArtifactPath(paths, absolutePath) {
  return relative(paths.artifactsDirectory, absolutePath).split(path.sep).join('/');
}
