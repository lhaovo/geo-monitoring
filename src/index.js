import { startServer } from './api/server.js';

// 长时间运行的服务不能因为一条孤立的 Promise 拒绝就整体退出，
// 这里统一兜底记录日志，避免正在执行的监控任务被意外打断。
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});

try {
  const app = await startServer({ logger: true });
  app.log.info('GEO Monitoring API is ready.');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
