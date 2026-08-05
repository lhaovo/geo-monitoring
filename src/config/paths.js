import path from 'node:path';

export function createPaths({ dataDirectory = path.resolve('data') } = {}) {
  const resolvedDataDirectory = path.resolve(dataDirectory);
  return Object.freeze({
    dataDirectory: resolvedDataDirectory,
    databasePath: path.join(resolvedDataDirectory, 'brand-monitoring.sqlite'),
    artifactsDirectory: path.join(resolvedDataDirectory, 'artifacts'),
    profilesDirectory: path.join(resolvedDataDirectory, 'profiles'),
  });
}
