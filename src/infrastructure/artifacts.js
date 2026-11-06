import { mkdir } from 'node:fs/promises';
import path, { relative } from 'node:path';
import { profilePaths } from '../profiles/profile-paths.js';

export async function createPlatformRunArtifacts(paths, runId, platformRunId, platformId, profileId = '') {
  // 浏览器用户目录必须绑定到具体账号的 Profile：
  // 没有账号就没有可复用的登录态，宁可失败也不要退回平台默认目录产出空回答。
  if (!profileId) throw new Error('缺少登录账号，无法确定浏览器用户目录。');
  const directory = path.join(paths.artifactsDirectory, runId, platformRunId);
  const { chromeDirectory } = profilePaths(paths, platformId, profileId);
  await Promise.all([
    mkdir(directory, { recursive: true }),
    mkdir(chromeDirectory, { recursive: true }),
  ]);
  return { directory, profileDirectory: chromeDirectory };
}

export function relativeArtifactPath(paths, absolutePath) {
  return relative(paths.artifactsDirectory, absolutePath).split(path.sep).join('/');
}
