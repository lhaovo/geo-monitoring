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
  logger = false,
} = {}) {
  const paths = createPaths({ dataDirectory });
  const ownedDatabase = database ?? openDatabase(paths.databasePath);
  const repo = repository ?? new GeoRepository(ownedDatabase);
  const runWorker = worker ?? new RunWorker({ repository: repo, paths, execute: executePlatformRun });
  const app = Fastify({ logger });

  app.decorate('geo', { paths, database: ownedDatabase, repository: repo, worker: runWorker });

  app.setErrorHandler((error, request, reply) => {
    const statusCode = error.statusCode ?? (error instanceof ValidationError ? 400 : 500);
    if (statusCode >= 500) request.log.error(error);
    reply.status(statusCode).send({ error: error.name ?? 'Error', message: error.message });
  });

  app.get('/api/health', async () => ({ status: 'ok' }));
  app.get('/api/platforms', async () => listPlatformAdapters().map((platform) => ({
    id: platform.id, label: platform.label, entryUrl: platform.entryUrl,
  })));
  app.get('/api/platforms/status', async () => listPlatformAdapters().map((platform) => ({
    id: platform.id,
    label: platform.label,
    entryUrl: platform.entryUrl,
    defaultMode: platform.id === 'doubao' ? 'headed' : 'headless',
    loginStatus: 'unknown',
    riskLevel: platform.id === 'doubao' ? 'elevated' : 'normal',
  })));

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
    days: request.query.days, platformId: request.query.platformId,
  }));

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
    const prompt = repo.createPrompt(request.params.projectId, { text: requireString(body.text, '监控问题'), category: body.category, enabled: body.enabled ?? true });
    return reply.status(201).send(prompt);
  });
  app.get('/api/brands/:brandId/questions', async (request) => repo.listPrompts(request.params.brandId));
  app.post('/api/brands/:brandId/questions', async (request, reply) => {
    const body = requireBody(request.body);
    const texts = Array.isArray(body.texts) ? body.texts : [body.text];
    const uniqueTexts = [...new Set(texts.map((text) => String(text ?? '').trim()).filter(Boolean))];
    if (!uniqueTexts.length) throw new ValidationError('至少提供一个监控问题。');
    const questions = uniqueTexts.map((text) => repo.createPrompt(request.params.brandId, { text, category: body.category, enabled: body.enabled ?? true }));
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
  app.post('/api/runs/:runId/cancel', async (request) => repo.requestCancellation(request.params.runId));
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
