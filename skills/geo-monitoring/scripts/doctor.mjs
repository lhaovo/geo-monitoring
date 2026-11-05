import { access, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs, option } from './lib/cli.mjs';
import { resolveBrowserExecutable } from './lib/browser.mjs';
import { listProfiles, PLATFORM_DEFINITIONS } from './lib/profiles.mjs';
import { availableMemoryMiB, calculateWorkerLimit } from './lib/scheduler.mjs';

async function main() {
  const { options } = parseArgs();
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 20) throw new Error(`Node.js 20 or later is required; found ${process.version}.`);
  const profilesDirectory = path.resolve(option(options, 'profiles', path.join(process.cwd(), 'profiles')));
  await mkdir(profilesDirectory, { recursive: true });
  await access(profilesDirectory);
  const availableMiB = availableMemoryMiB();
  const profiles = await listProfiles({ profilesDirectory });
  const report = {
    node: process.version,
    browserExecutable: resolveBrowserExecutable(option(options, 'browser')),
    profilesDirectory,
    profileCount: profiles.length,
    readyProfileCount: profiles.filter(({ health }) => health === 'ready').length,
    availableMemoryMiB: availableMiB,
    automaticPlatformWorkerLimit: calculateWorkerLimit({ availableMiB }),
    supportedPlatforms: Object.values(PLATFORM_DEFINITIONS).map(({ id, label, loginMethod, defaultMode }) => ({
      platformId: id,
      label,
      loginMethod,
      defaultMode,
    })),
  };
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
