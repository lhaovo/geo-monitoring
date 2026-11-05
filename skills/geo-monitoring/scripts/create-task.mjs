import path from 'node:path';
import { option, parseArgs, required, usage, values } from './lib/cli.mjs';
import { defaultProfile, requireProfile, SUPPORTED_PLATFORMS } from './lib/profiles.mjs';
import { createTaskDefinition, createTaskDirectory } from './lib/task.mjs';

async function resolveBindings({ platforms, profileIds, profilesDirectory }) {
  const bindings = [];
  for (let index = 0; index < platforms.length; index += 1) {
    const rawPlatform = String(platforms[index]);
    const [platformId, embeddedProfileId] = rawPlatform.includes(':') ? rawPlatform.split(':', 2) : [rawPlatform, null];
    const requestedProfileId = profileIds[index] ?? embeddedProfileId;
    const profile = requestedProfileId
      ? await requireProfile({ profilesDirectory, platformId, profileId: requestedProfileId })
      : await defaultProfile({ profilesDirectory, platformId });
    if (!profile) {
      const error = new Error(`No saved login profile for ${platformId}. Create one with profile.mjs create, then start login before creating the task.`);
      error.code = 'login_required';
      throw error;
    }
    bindings.push({
      id: platformId,
      profileId: profile.profileId,
      account: profile.account ?? null,
    });
  }
  return bindings;
}

async function main() {
  const { options } = parseArgs();
  if (option(options, 'help')) {
    usage([
      'Usage: node scripts/create-task.mjs --brand <name> --question <text> --platform <id> --profile <profile-id> [--concurrency <n>] [options]',
      'Repeat --question, --platform, and --profile as needed; the nth --profile binds to the nth --platform.',
      'Questions for the same platform share one dynamic queue and are claimed by runnable profiles as they finish prior work.',
      'If --profile is omitted, the platform default login profile is used.',
      `Supported platforms: ${SUPPORTED_PLATFORMS.join(', ')}.`,
    ]);
    return null;
  }
  const profilesDirectory = path.resolve(option(options, 'profiles', path.resolve(process.cwd(), 'profiles')));
  const platformValues = values(options, 'platform');
  const profileValues = values(options, 'profile');
  const bindings = await resolveBindings({ platforms: platformValues, profileIds: profileValues, profilesDirectory });
  const definition = createTaskDefinition({
    brandName: required(options, 'brand'),
    aliases: values(options, 'alias'),
    domains: values(options, 'domain'),
    questions: values(options, 'question'),
    platforms: bindings,
    outputDirectory: option(options, 'output', path.resolve(process.cwd(), 'output')),
    profilesDirectory,
    browserExecutable: option(options, 'browser'),
    appendSearchPrompt: Boolean(option(options, 'append-search-prompt', false)),
    workerConcurrency: option(options, 'concurrency'),
  });
  return createTaskDirectory(definition);
}

main().then((directory) => {
  if (directory) console.log(directory);
}).catch((error) => {
  console.error(JSON.stringify({ error: { code: error.code ?? 'task_creation_failed', message: error.message } }));
  process.exitCode = 1;
});
