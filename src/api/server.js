import path from 'node:path';
import { existsSync } from 'node:fs';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { openDatabase } from '../db/database.js';
import { GeoRepository } from '../db/repository.js';
import { createPaths } from '../config/paths.js';
import { getPlatformAdapter, listPlatformAdapters } from '../platforms/index.js';
import { ValidationError } from '../shared/errors.js';
import { RunWorker } from '../worker/run-worker.js';
import { LoginManager } from '../login/login-manager.js';

function requireString(value, fieldName) {
  if (typeof value !== 'string' || !value.trim()) throw new ValidationError(`${fieldName}不能为空。`);
  return value.trim();
}

function requireBody(body) {
  if (!body || typeof body !== 'object') throw new ValidationError('请求体必须为 JSON 对象。');
  return body;
}

export function buildServer({
  dataDirectory,
  database,
  repository,
  worker,
  executePlatformRun,
  loginManager: providedLoginManager,
  logger = false,
} = {}) {
  const paths = createPaths({ dataDirectory });
  const ownedDatabase = database ?? openDatabase(paths.databasePath);
  const repo = repository ?? new GeoRepository(ownedDatabase);
  const runWorker = worker ?? new RunWorker({ repository: repo, paths, execute: executePlatformRun });
  // 服务重启后回收上一次遗留的僵尸任务，避免它们永远挂在「执行中 / 取消中」。
  runWorker.recoverInterruptedRuns?.();
  const app = Fastify({ logger });
  const loginManager = providedLoginManager ?? new LoginManager({ repository: repo, paths });

  app.decorate('geo', { paths, database: ownedDatabase, repository: repo, worker: runWorker, loginManager });

  // 允许「没有请求体」的 POST：例如关闭登录窗口、停用登录态这类操作。
  // Fastify 默认会对带 content-type: application/json 的空体直接报错，这里统一按空对象处理。
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, done) => {
    const raw = typeof body === 'string' ? body.trim() : '';
    if (!raw) return done(null, {});
    try {
      done(null, JSON.parse(raw));
    } catch {
      const error = new Error('请求体必须是合法的 JSON。');
      error.statusCode = 400;
      done(error);
    }
  });

  app.setErrorHandler((error, request, reply) => {
    const statusCode = error.statusCode ?? (error instanceof ValidationError ? 400 : 500);
    if (statusCode >= 500) request.log.error(error);
    reply.status(statusCode).send({ error: error.name ?? 'Error', message: error.message });
  });

  app.get('/api/health', async () => ({ status: 'ok' }));
  app.get('/api/platforms', async () => listPlatformAdapters().map((platform) => ({
    id: platform.id, label: platform.label, entryUrl: platform.entryUrl,
  })));
  // 平台状态会带上该平台下所有登录态 Profile 的健康状况，
  // 前端据此提示哪些账号已被平台限制或需要重新登录。
  app.get('/api/platforms/status', async () => listPlatformAdapters().map((platform) => {
    const profiles = repo.listProfiles({ platformId: platform.id });
    const cooldown = repo.getPlatformCooldown(platform.id);
    const manualWindow = repo.getPlatformManualWindow(platform.id);
    const healthy = profiles.filter((profile) => profile.health === 'ready').length;
    const restricted = profiles.filter((profile) => profile.health === 'restricted').length;
    return {
      id: platform.id,
      label: platform.label,
      entryUrl: platform.entryUrl,
      defaultMode: platform.defaultMode ?? (platform.id === 'doubao' ? 'headed' : 'headless'),
      loginStatus: profiles.length === 0 ? 'none' : healthy > 0 ? 'ready' : restricted > 0 ? 'restricted' : 'unknown',
      cooldown: cooldown?.coolingDown
        ? { until: cooldown.cooldownUntil, reason: cooldown.reason, kind: cooldown.kind }
        : null,
      manualWindow: manualWindow?.active
        ? { until: manualWindow.until, reason: manualWindow.reason }
        : null,
      riskLevel: platform.id === 'doubao' ? 'elevated' : 'normal',
      profiles,
      profileSummary: {
        total: profiles.length,
        ready: healthy,
        restricted,
        new: profiles.filter((profile) => profile.health === 'new').length,
        expired: profiles.filter((profile) => profile.health === 'expired').length,
        error: profiles.filter((profile) => profile.health === 'error').length,
        disabled: profiles.filter((profile) => profile.health === 'disabled').length,
      },
    };
  }));

  // ---- 登录态 Profile ----
  // 平台处于人工窗口时（刚撞过验证码）会一直用有头模式跑，
  // 操作员可以在任务详情里提前解除，恢复无头模式。
  app.post('/api/platforms/:platformId/manual-window/clear', async (request) => {
    getPlatformAdapter(requireString(request.params.platformId, 'platformId'));
    repo.clearPlatformManualWindow(request.params.platformId);
    return { platformId: request.params.platformId, cleared: true };
  });

  app.get('/api/profiles', async (request) => repo.listProfiles({ platformId: request.query.platformId }));
  app.post('/api/profiles', async (request, reply) => {
    const body = requireBody(request.body);
    getPlatformAdapter(requireString(body.platformId, 'platformId'));
    const profile = repo.createProfile({
      platformId: body.platformId,
      profileKey: body.profileId,
      account: body.account,
      label: body.label ?? '',
    });
    return reply.status(201).send(profile);
  });
  app.get('/api/profiles/:profileId', async (request) => repo.getProfile(request.params.profileId));
  app.patch('/api/profiles/:profileId', async (request) => repo.updateProfile(request.params.profileId, requireBody(request.body)));
  app.post('/api/profiles/:profileId/disable', async (request) => repo.disableProfile(request.params.profileId, request.body?.reason ?? ''));

  // ---- 登录窗口会话 ----
  // 前端「平台与登录状态」页面通过这里拉起可见浏览器，操作员手动完成登录，
  // 关闭浏览器后登录态会自动更新为可用。
  app.post('/api/login-sessions', async (request, reply) => {
    const body = requireBody(request.body);
    const platformId = requireString(body.platformId, 'platformId');
    getPlatformAdapter(platformId);
    const result = await loginManager.startSession({
      platformId,
      account: body.account ?? '',
      profileId: body.profileId ?? '',
      label: body.label ?? '',
    });
    return reply.status(result.reused ? 200 : 201).send(result);
  });
  app.get('/api/login-sessions', async () => loginManager.listSessions());
  app.get('/api/login-sessions/:sessionId', async (request) => loginManager.getSession(request.params.sessionId));
  app.post('/api/login-sessions/:sessionId/close', async (request) => loginManager.closeSession(request.params.sessionId));

  // Brand-first API. The project routes below remain as compatibility aliases
  // for the existing CLI/tests while the UI speaks in brand terminology.
  app.get('/api/brands', async () => repo.listBrands());
  app.post('/api/brands', async (request, reply) => {
    const body = requireBody(request.body);
    const brand = repo.createBrand({
      name: requireString(body.name, '品牌名称'), description: body.description ?? '', aliases: body.aliases,
      products: body.products, website: body.website, ownedDomains: body.ownedDomains,
    });
    return reply.status(201).send(brand);
  });
  app.get('/api/brands/:brandId', async (request) => repo.getBrand(request.params.brandId));
  app.patch('/api/brands/:brandId', async (request) => repo.updateBrand(request.params.brandId, requireBody(request.body)));
  app.get('/api/brands/:brandId/overview', async (request) => repo.getBrandOverview(request.params.brandId, { days: request.query.days }));
    app.get('/api/brands/:brandId/sources', async (request) => repo.getBrandSources(request.params.brandId, {
    days: request.query.days, platformId: request.query.platformId, domain: request.query.domain,
    promptId: request.query.promptId, mention: request.query.mention, owned: request.query.owned,
    search: request.query.search, sort: request.query.sort,
  }));

  // ---- 自有内容链接：监测自己发布的文章有没有被 AI 引用 ----
  app.get('/api/brands/:brandId/owned-links', async (request) => repo.getBrandOwnedLinks(request.params.brandId, {
    days: request.query.days, platformId: request.query.platformId, search: request.query.search,
  }));
  app.post('/api/brands/:brandId/owned-links', async (request, reply) => {
    const body = requireBody(request.body);
    // 传 urls 就是批量导入，一行一个链接；否则按单条创建。
    if (Array.isArray(body.urls) || typeof body.urls === 'string') {
      const result = repo.importBrandLinks(request.params.brandId, body.urls, {
        title: body.title ?? '', label: body.label ?? '',
      });
      return reply.status(201).send(result);
    }
    const link = repo.createBrandLink(request.params.brandId, {
      url: requireString(body.url, '链接'), title: body.title ?? '', label: body.label ?? '',
    });
    return reply.status(201).send(link);
  });
  app.patch('/api/brands/owned-links/:linkId', async (request) => repo.updateBrandLink(request.params.linkId, requireBody(request.body)));
  app.delete('/api/brands/owned-links/:linkId', async (request) => repo.deleteBrandLink(request.params.linkId));
  // 新增链接后回算历史引用，把之前采集到的来源一并标记出来。
  app.post('/api/brands/:brandId/owned-links/recompute', async (request) => repo.recomputeBrandLinkCitations(request.params.brandId));
  // 品牌名、别名或产品词调整后，可以手动回算历史回答的提及口径。
  app.post('/api/brands/:brandId/recompute-analysis', async (request) => repo.recomputeBrandAnalysis(request.params.brandId));

  app.get('/api/projects', async () => repo.listProjects());
  app.post('/api/projects', async (request, reply) => {
    const body = requireBody(request.body);
    const project = repo.createProject({ name: requireString(body.name, '项目名称'), description: body.description ?? '', aliases: body.aliases,
      products: body.products, website: body.website, ownedDomains: body.ownedDomains });
    return reply.status(201).send(project);
  });
  app.get('/api/projects/:projectId', async (request) => repo.getProject(request.params.projectId));
  app.patch('/api/projects/:projectId', async (request) => repo.updateProject(request.params.projectId, requireBody(request.body)));

  app.get('/api/projects/:projectId/prompts', async (request) => repo.listPrompts(request.params.projectId));
  app.post('/api/projects/:projectId/prompts', async (request, reply) => {
    const body = requireBody(request.body);
    const prompt = repo.createPrompt(request.params.projectId, { text: requireString(body.text, '监控问题'), enabled: body.enabled ?? true });
    return reply.status(201).send(prompt);
  });
  app.get('/api/brands/:brandId/questions', async (request) => repo.listPrompts(request.params.brandId));
  app.post('/api/brands/:brandId/questions', async (request, reply) => {
    const body = requireBody(request.body);
    const texts = Array.isArray(body.texts) ? body.texts : [body.text];
    const uniqueTexts = [...new Set(texts.map((text) => String(text ?? '').trim()).filter(Boolean))];
    if (!uniqueTexts.length) throw new ValidationError('至少提供一个监控问题。');
    const questions = uniqueTexts.map((text) => repo.createPrompt(request.params.brandId, { text, enabled: body.enabled ?? true }));
    return reply.status(201).send({ questions, imported: uniqueTexts.length, duplicates: texts.length - uniqueTexts.length });
  });
  app.patch('/api/brands/questions/:questionId', async (request) => repo.updatePrompt(request.params.questionId, requireBody(request.body)));
  app.delete('/api/brands/questions/:questionId', async (request, reply) => { repo.deletePrompt(request.params.questionId); return reply.status(204).send(); });
  app.patch('/api/prompts/:promptId', async (request) => repo.updatePrompt(request.params.promptId, requireBody(request.body)));
  app.delete('/api/prompts/:promptId', async (request, reply) => {
    repo.deletePrompt(request.params.promptId);
    return reply.status(204).send();
  });

  app.post('/api/runs', async (request, reply) => {
    const body = requireBody(request.body);
    if (!Array.isArray(body.platforms)) throw new ValidationError('platforms 必须为数组。');
    body.platforms.forEach((platformId) => getPlatformAdapter(platformId));
    const run = repo.createRun({
      projectId: requireString(body.projectId, 'projectId'),
      promptIds: body.promptIds,
      platforms: body.platforms,
      mode: body.mode ?? 'headless',
      platformModes: body.platformModes ?? {},
      concurrency: body.concurrency ?? 3,
      appendSearchPrompt: body.appendSearchPrompt ?? false,
    });
    runWorker.enqueue(run.id);
    return reply.status(202).send(run);
  });
  app.post('/api/monitoring-runs', async (request, reply) => {
    const body = requireBody(request.body);
    if (!Array.isArray(body.platforms)) throw new ValidationError('platforms 必须为数组。');
    body.platforms.forEach((platformId) => getPlatformAdapter(platformId));
    const run = repo.createRun({ projectId: requireString(body.brandId ?? body.projectId, 'brandId'), promptIds: body.questionIds ?? body.promptIds,
      platforms: body.platforms, mode: body.mode ?? 'headless', platformModes: body.platformModes ?? {},
      concurrency: body.concurrency ?? 3, appendSearchPrompt: body.appendSearchPrompt ?? false });
    runWorker.enqueue(run.id);
    return reply.status(202).send(run);
  });
  app.get('/api/runs', async (request) => {
    const { projectId, limit } = request.query;
    return repo.listRuns({ projectId, limit: Math.min(Number(limit) || 50, 200) });
  });
  app.get('/api/runs/:runId', async (request) => repo.getRunDetail(request.params.runId));
  app.get('/api/runs/:runId/answers', async (request) => repo.getRunDetail(request.params.runId).platformRuns);
  app.post('/api/runs/:runId/cancel', async (request) => {
    const run = repo.requestCancellation(request.params.runId);
    await runWorker.cancelRun(request.params.runId);
    return repo.getRun(run.id);
  });
  // 熔断的平台在任务详情里手动决定续跑还是中止：
  // 续跑会解除熔断并把挂起的检查放回队列，中止则放弃这些检查。
  // 平台级没有「解除冷却」入口，避免出现「冷却解了但任务不会自己恢复」的半截状态。
  app.post('/api/runs/:runId/platforms/:platformId/resume', async (request) => {
    const runId = requireString(request.params.runId, 'runId');
    const platformId = requireString(request.params.platformId, 'platformId');
    getPlatformAdapter(platformId);
    const result = runWorker.resumePlatform(runId, platformId);
    return { runId, platformId, ...result };
  });

  app.post('/api/runs/:runId/platforms/:platformId/abort', async (request) => {
    const runId = requireString(request.params.runId, 'runId');
    const platformId = requireString(request.params.platformId, 'platformId');
    getPlatformAdapter(platformId);
    const result = runWorker.abortPlatform(runId, platformId);
    return { runId, platformId, ...result };
  });

  app.get('/api/runs/:runId/events', async (request) => repo.listEvents(request.params.runId));
  app.get('/api/answers/:answerId', async (request) => repo.getAnswer(request.params.answerId));
  app.get('/api/answers/:answerId/citations', async (request) => repo.getAnswer(request.params.answerId).citations);
  app.get('/api/citations/:citationId', async (request) => repo.getCitation(request.params.citationId));

  app.get('/api/events', async (request, reply) => {
    const runId = request.query.runId;
    reply.raw.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    reply.raw.setHeader('Cache-Control', 'no-cache, no-transform');
    reply.raw.setHeader('Connection', 'keep-alive');
    reply.hijack();
    const listener = (event) => {
      if (!runId || event.runId === runId) reply.raw.write(`event: task\ndata: ${JSON.stringify(event)}\n\n`);
    };
    runWorker.on('event', listener);
    const heartbeat = setInterval(() => reply.raw.write(': keepalive\n\n'), 25_000);
    request.raw.on('close', () => {
      clearInterval(heartbeat);
      runWorker.off('event', listener);
    });
  });

  app.register(fastifyStatic, {
    root: paths.artifactsDirectory,
    prefix: '/artifacts/',
    wildcard: true,
    decorateReply: false,
  });

  const webDist = path.resolve('web/dist');
  if (existsSync(webDist)) {
    app.register(fastifyStatic, { root: webDist, prefix: '/', wildcard: true, index: false });
    app.get('/', async (_, reply) => reply.sendFile('index.html'));
  }

  app.addHook('onClose', async () => {
    await Promise.all(loginManager.listSessions().map((session) => loginManager.closeSession(session.id).catch(() => undefined)));
    if (!database && !repository) ownedDatabase.close();
  });
  return app;
}

export async function startServer(options = {}) {
  const app = buildServer(options);
  const port = Number(process.env.PORT ?? 3030);
  await app.listen({ host: process.env.HOST ?? '127.0.0.1', port });
  return app;
}
