import path from 'node:path';
import { parseArgs, required } from './lib/cli.mjs';
import { runLoginSession } from './lib/login-runner.mjs';

async function main() {
  const { options } = parseArgs();
  const session = await runLoginSession({
    profilesDirectory: path.resolve(required(options, 'profiles')),
    sessionId: required(options, 'session'),
  });
  if (['failed', 'cancelled', 'expired'].includes(session.state)) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
