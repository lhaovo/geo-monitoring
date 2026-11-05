import { parseArgs, required } from './lib/cli.mjs';
import { buildReport } from './lib/report.mjs';

const { options } = parseArgs();
buildReport(required(options, 'task')).then((summary) => {
  console.log(JSON.stringify({ taskId: summary.taskId, status: summary.status, summary: 'summary.md' }));
}).catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
