import { startServer } from './api/server.js';

try {
  const app = await startServer({ logger: true });
  app.log.info('GEO Monitoring API is ready.');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
