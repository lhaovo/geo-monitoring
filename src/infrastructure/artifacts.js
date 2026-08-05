import { mkdir } from 'node:fs/promises';
import path, { relative } from 'node:path';

export async function createPlatformRunArtifacts(paths, runId, platformRunId, platformId) {
  const directory = path.join(paths.artifactsDirectory, runId, platformRunId);
  const profileDirectory = path.join(paths.profilesDirectory, platformId);
  await Promise.all([
    mkdir(directory, { recursive: true }),
    mkdir(profileDirectory, { recursive: true }),
  ]);
  return { directory, profileDirectory };
}

export function relativeArtifactPath(paths, absolutePath) {
  return relative(paths.artifactsDirectory, absolutePath).split(path.sep).join('/');
}
