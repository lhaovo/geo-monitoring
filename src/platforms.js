import { listPlatformAdapters } from './platforms/index.js';

// Backward-compatible registry for the interactive CLI. The product runtime
// owns platform configuration in src/platforms/<platform>/adapter.js.
export const PLATFORMS = Object.freeze(Object.fromEntries(
  listPlatformAdapters().map(({ id, label, entryUrl }) => [id, Object.freeze({ id, label, entryUrl })]),
));

export function getPlatform(id) {
  const platform = PLATFORMS[id];
  if (!platform) {
    const supported = Object.keys(PLATFORMS).join(', ');
    throw new Error(`Unsupported platform "${id}". Supported platforms: ${supported}`);
  }
  return platform;
}
