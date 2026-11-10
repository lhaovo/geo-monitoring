import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { buildServer } from '../src/api/server.js';
import { openDatabase } from '../src/db/database.js';
import { buildSubmittedQuestion, SEARCH_PROMPT_SUFFIX } from '../src/infrastructure/platform-runner.js';

async function json(app, options) {
  const response = await app.inject(options);
  return { response, body: response.body ? response.json() : null };
}

// 等待任务里的检查进入期望状态：熔断与挂起都是异步发生的，测试不能假设瞬时完成。
async function waitForPlatformRun(app, runId, predicate, { timeoutMs = 8000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const detail = await json(app, { method: 'GET', url: `/api/runs/${runId}` });
    const platformRun = detail.body.platformRuns[0];
    if (platformRun && predicate(platformRun, detail.body)) return detail.body;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('等待检查状态超时。');
}

// 监控任务必须绑定到具体账号，没有可用账号时不会执行，这里为相关平台准备可用登录态。
async function createReadyProfiles(app, platformIds) {
  for (const platformId of platformIds) {
    const created = await json(app, {
      method: 'POST', url: '/api/profiles',
      payload: { platformId, account: `1322060215${platformIds.indexOf(platformId)}` },
    });
    await json(app, { method: 'PATCH', url: `/api/profiles/${created.body.id}`, payload: { health: 'ready' } });
  }
}

test('creates a project, queues a run, and persists an answer with citations', async () => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), 'geo-monitoring-api-'));
  const executedModes = [];
  const executedSearchHints = [];
  const app = await buildServer({
    dataDirectory,
    executePlatformRun: async ({ platformRun, mode, appendSearchPrompt }) => {
      executedModes.push([platformRun.platformId, mode]);
      executedSearchHints.push(appendSearchPrompt);
      return {
      content: `回答：${platformRun.prompt.text}`,
      responseUrl: `https://example.test/${platformRun.platformId}`,
      sourcePanelOpened: true,
      platformReportedCount: 1,
      citations: [{
        position: 1,
        title: '示例网页',
        url: 'https://source.example.com/article',
        domain: 'source.example.com',
        citationFragments: [],
        citationOccurrences: 2,
      }],
      artifacts: [{ kind: 'screenshot', relativePath: 'test/screenshot.png' }],
      };
    },
  });
  try {
    await createReadyProfiles(app, ['deepseek', 'kimi']);
    const project = await json(app, { method: 'POST', url: '/api/projects', payload: { name: '药品监测' } });
    assert.equal(project.response.statusCode, 201);
    const prompt = await json(app, {
      method: 'POST', url: `/api/projects/${project.body.id}/prompts`, payload: { text: '哪个牌子更稳？' },
    });
    assert.equal(prompt.response.statusCode, 201);
    const run = await json(app, {
      method: 'POST', url: '/api/runs',
      payload: {
        projectId: project.body.id,
        promptIds: [prompt.body.id],
        platforms: ['deepseek', 'kimi'],
        mode: 'headless',
        platformModes: { deepseek: 'headless', kimi: 'headed' },
        appendSearchPrompt: true,
      },
    });
    assert.equal(run.response.statusCode, 202);
    await app.geo.worker.whenIdle();

    const detail = await json(app, { method: 'GET', url: `/api/runs/${run.body.id}` });
    assert.equal(detail.body.status, 'completed');
    assert.equal(detail.body.concurrency, 3);
    assert.equal(detail.body.appendSearchPrompt, true);
    assert.equal(detail.body.platformRuns.length, 2);
    assert.deepEqual(detail.body.platformRuns.map((item) => [item.platformId, item.mode]), [
      ['deepseek', 'headless'],
      ['kimi', 'headed'],
    ]);
    assert.deepEqual(executedModes, [['deepseek', 'headless'], ['kimi', 'headed']]);
    assert.deepEqual(executedSearchHints, [true, true]);
    assert.equal(detail.body.platformRuns[0].answer.citations[0].citationOccurrences, 2);
    assert.equal(detail.body.platformRuns[1].answer.artifacts[0].relativePath, 'test/screenshot.png');
    const answer = await json(app, { method: 'GET', url: `/api/answers/${detail.body.platformRuns[0].answer.id}` });
    assert.equal(answer.body.platformId, 'deepseek');
    const citation = await json(app, { method: 'GET', url: `/api/citations/${answer.body.citations[0].id}` });
    assert.equal(citation.body.domain, 'source.example.com');
  } finally {
    await app.close();
    await rm(dataDirectory, { recursive: true, force: true });
  }
});

test('builds the optional search prompt suffix without changing the original question', () => {
  assert.equal(buildSubmittedQuestion('  原始问题  '), '原始问题');
  assert.equal(buildSubmittedQuestion('原始问题', true), `原始问题\n\n${SEARCH_PROMPT_SUFFIX}`);
});

test('runs a global concurrency pool while serializing each platform', async () => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), 'geo-monitoring-concurrency-'));
  let activeCount = 0;
  let maxActiveCount = 0;
  let samePlatformOverlap = false;
  let crossPromptOverlap = false;
  const activePlatforms = new Set();
  const activePromptCounts = new Map();
  const firstPromptId = { value: null };
  const app = await buildServer({
    dataDirectory,
    executePlatformRun: async ({ platformRun }) => {
      if (activePlatforms.has(platformRun.platformId)) samePlatformOverlap = true;
      if ([...activePromptCounts.keys()].some((promptId) => promptId !== platformRun.promptId)) crossPromptOverlap = true;
      activePlatforms.add(platformRun.platformId);
      activePromptCounts.set(platformRun.promptId, (activePromptCounts.get(platformRun.promptId) ?? 0) + 1);
      activeCount += 1;
      maxActiveCount = Math.max(maxActiveCount, activeCount);
      const delay = platformRun.promptId === firstPromptId.value && platformRun.platformId === 'deepseek' ? 80 : 20;
      await new Promise((resolve) => setTimeout(resolve, delay));
      activeCount -= 1;
      activePlatforms.delete(platformRun.platformId);
      const promptCount = (activePromptCounts.get(platformRun.promptId) ?? 1) - 1;
      if (promptCount > 0) activePromptCounts.set(platformRun.promptId, promptCount);
      else activePromptCounts.delete(platformRun.promptId);
      return {
        content: '并发测试回答',
        responseUrl: 'https://example.test/answer',
        sourcePanelOpened: false,
        platformReportedCount: null,
        citations: [],
        artifacts: [],
      };
    },
  });
  try {
    await createReadyProfiles(app, ['deepseek', 'kimi', 'doubao']);
    const project = await json(app, { method: 'POST', url: '/api/projects', payload: { name: '并发测试' } });
    const promptOne = await json(app, {
      method: 'POST', url: `/api/projects/${project.body.id}/prompts`, payload: { text: '问题一' },
    });
    const promptTwo = await json(app, {
      method: 'POST', url: `/api/projects/${project.body.id}/prompts`, payload: { text: '问题二' },
    });
    firstPromptId.value = promptOne.body.id;
    const run = await json(app, {
      method: 'POST', url: '/api/runs',
      payload: {
        projectId: project.body.id,
        promptIds: [promptOne.body.id, promptTwo.body.id],
        platforms: ['deepseek', 'kimi', 'doubao'],
        concurrency: 3,
      },
    });
    assert.equal(run.response.statusCode, 202);
    await app.geo.worker.whenIdle();
    assert.equal(maxActiveCount, 3);
    assert.equal(samePlatformOverlap, false);
    assert.equal(crossPromptOverlap, true);
    const detail = await json(app, { method: 'GET', url: `/api/runs/${run.body.id}` });
    assert.equal(detail.body.status, 'completed');
    assert.equal(detail.body.concurrency, 3);
  } finally {
    await app.close();
    await rm(dataDirectory, { recursive: true, force: true });
  }
});

test('force-cancels active browser work and marks the run immediately', async () => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), 'geo-monitoring-cancel-'));
  let executionStarted = false;
  let abortObserved = false;
  const app = await buildServer({
    dataDirectory,
    executePlatformRun: async ({ signal }) => {
      executionStarted = true;
      await new Promise((resolve, reject) => {
        if (signal.aborted) {
          abortObserved = true;
          reject(new Error('browser closed'));
          return;
        }
        signal.addEventListener('abort', () => {
          abortObserved = true;
          reject(new Error('browser closed'));
        }, { once: true });
      });
    },
  });
  try {
    await createReadyProfiles(app, ['kimi']);
    const project = await json(app, { method: 'POST', url: '/api/projects', payload: { name: '取消测试' } });
    const prompt = await json(app, {
      method: 'POST', url: `/api/projects/${project.body.id}/prompts`, payload: { text: '会被取消的问题' },
    });
    const run = await json(app, {
      method: 'POST', url: '/api/runs',
      payload: { projectId: project.body.id, promptIds: [prompt.body.id], platforms: ['kimi'] },
    });
    for (let attempt = 0; attempt < 20 && !executionStarted; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(executionStarted, true);

    const cancelled = await json(app, { method: 'POST', url: `/api/runs/${run.body.id}/cancel` });
    assert.equal(cancelled.response.statusCode, 200);
    assert.equal(cancelled.body.status, 'cancelled');
    assert.equal(abortObserved, true);
    assert.equal(cancelled.body.cancelRequestedAt !== null, true);
    assert.equal(cancelled.body.completedChecks, 0);
    const detail = await json(app, { method: 'GET', url: `/api/runs/${run.body.id}` });
    assert.equal(detail.body.platformRuns[0].status, 'cancelled');
  } finally {
    await app.close();
    await rm(dataDirectory, { recursive: true, force: true });
  }
});

test('migrates an existing SQLite platform_runs table to platform-level modes', async () => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), 'geo-monitoring-api-'));
  const databasePath = path.join(dataDirectory, 'geo-monitoring.sqlite');
  const legacyDatabase = new Database(databasePath);
  legacyDatabase.exec(`CREATE TABLE runs (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    status TEXT NOT NULL,
    mode TEXT NOT NULL,
    target_platforms_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    started_at TEXT,
    completed_at TEXT,
    cancel_requested_at TEXT
  );
  CREATE TABLE platform_runs (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    prompt_id TEXT NOT NULL,
    platform_id TEXT NOT NULL,
    status TEXT NOT NULL,
    error_message TEXT,
    started_at TEXT,
    completed_at TEXT,
    created_at TEXT NOT NULL,
    UNIQUE(run_id, prompt_id, platform_id)
  )`);
  legacyDatabase.close();
  const migratedDatabase = openDatabase(databasePath);
  try {
    const mode = migratedDatabase.pragma('table_info(platform_runs)').find((column) => column.name === 'mode');
    assert.equal(mode.notnull, 1);
    assert.equal(mode.dflt_value, "'headless'");
    const concurrency = migratedDatabase.pragma('table_info(runs)').find((column) => column.name === 'concurrency');
    assert.equal(concurrency.notnull, 1);
    assert.equal(concurrency.dflt_value, '3');
    const appendSearchPrompt = migratedDatabase.pragma('table_info(runs)').find((column) => column.name === 'append_search_prompt');
    assert.equal(appendSearchPrompt.notnull, 1);
    assert.equal(appendSearchPrompt.dflt_value, '0');
  } finally {
    migratedDatabase.close();
    await rm(dataDirectory, { recursive: true, force: true });
  }
});

test('rejects a run containing an unsupported platform before it enters the queue', async () => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), 'geo-monitoring-api-'));
  const app = await buildServer({ dataDirectory, executePlatformRun: async () => ({}) });
  try {
    const project = await json(app, { method: 'POST', url: '/api/projects', payload: { name: '项目' } });
    const prompt = await json(app, {
      method: 'POST', url: `/api/projects/${project.body.id}/prompts`, payload: { text: '问题' },
    });
    const run = await json(app, {
      method: 'POST', url: '/api/runs',
      payload: { projectId: project.body.id, promptIds: [prompt.body.id], platforms: ['unknown'], mode: 'headless' },
    });
    assert.equal(run.response.statusCode, 400);
    assert.match(run.body.message, /不支持的平台/);
  } finally {
    await app.close();
    await rm(dataDirectory, { recursive: true, force: true });
  }
});

test('rejects a mode configured for a platform outside the task', async () => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), 'geo-monitoring-api-'));
  const app = await buildServer({ dataDirectory, executePlatformRun: async () => ({}) });
  try {
    const project = await json(app, { method: 'POST', url: '/api/projects', payload: { name: '项目' } });
    const prompt = await json(app, {
      method: 'POST', url: `/api/projects/${project.body.id}/prompts`, payload: { text: '问题' },
    });
    const run = await json(app, {
      method: 'POST', url: '/api/runs',
      payload: {
        projectId: project.body.id,
        promptIds: [prompt.body.id],
        platforms: ['deepseek'],
        platformModes: { doubao: 'headed' },
      },
    });
    assert.equal(run.response.statusCode, 400);
    assert.match(run.body.message, /未选择的平台/);
  } finally {
    await app.close();
    await rm(dataDirectory, { recursive: true, force: true });
  }
});

test('validates run concurrency between one and six', async () => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), 'geo-monitoring-concurrency-validation-'));
  const app = await buildServer({ dataDirectory, executePlatformRun: async () => ({}) });
  try {
    const project = await json(app, { method: 'POST', url: '/api/projects', payload: { name: '并发校验' } });
    const prompt = await json(app, {
      method: 'POST', url: `/api/projects/${project.body.id}/prompts`, payload: { text: '问题' },
    });
    for (const concurrency of [0, 2.5, 7]) {
      const run = await json(app, {
        method: 'POST', url: '/api/runs',
        payload: {
          projectId: project.body.id,
          promptIds: [prompt.body.id],
          platforms: ['deepseek'],
          concurrency,
        },
      });
      assert.equal(run.response.statusCode, 400);
      assert.match(run.body.message, /concurrency/);
    }
  } finally {
    await app.close();
    await rm(dataDirectory, { recursive: true, force: true });
  }
});

test('uses headed mode only for Doubao by default', async () => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), 'geo-monitoring-platform-defaults-'));
  const app = await buildServer({ dataDirectory, executePlatformRun: async () => ({}) });
  try {
    const status = await json(app, { method: 'GET', url: '/api/platforms/status' });
    const modes = Object.fromEntries(status.body.map((platform) => [platform.id, platform.defaultMode]));
    assert.equal(modes.doubao, 'headed');
    assert.equal(modes.qwen, 'headless');
    assert.equal(modes.yuanbao, 'headless');
    assert.equal(modes.wenxiaoyan, 'headless');
  } finally {
    await app.close();
    await rm(dataDirectory, { recursive: true, force: true });
  }
});

test('reports the profile summary for every platform', async () => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), 'geo-monitoring-platform-status-'));
  const app = await buildServer({ dataDirectory, executePlatformRun: async () => ({}) });
  try {
    const created = await json(app, {
      method: 'POST', url: '/api/profiles',
      payload: { platformId: 'wenxiaoyan', account: '132 2060 2153' },
    });
    assert.equal(created.response.statusCode, 201);
    assert.equal(created.body.profileId, '13220602153');
    assert.equal(created.body.health, 'new');

    const status = await json(app, { method: 'GET', url: '/api/platforms/status' });
    const wenxiaoyan = status.body.find((platform) => platform.id === 'wenxiaoyan');
    assert.equal(wenxiaoyan.profileSummary.total, 1);
    assert.equal(wenxiaoyan.profileSummary.new, 1);
    assert.equal(wenxiaoyan.profiles.length, 1);

    const profiles = await json(app, { method: 'GET', url: '/api/profiles?platformId=wenxiaoyan' });
    assert.equal(profiles.body.length, 1);

    const disabled = await json(app, { method: 'POST', url: `/api/profiles/${created.body.id}/disable` });
    assert.equal(disabled.response.statusCode, 200);
    assert.equal(disabled.body.health, 'disabled');
  } finally {
    await app.close();
    await rm(dataDirectory, { recursive: true, force: true });
  }
});

test('stores the share link collected for a platform run', async () => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), 'geo-monitoring-share-'));
  const app = await buildServer({
    dataDirectory,
    executePlatformRun: async () => ({
      content: '回答内容',
      citations: [],
      artifacts: [],
      shareStatus: 'captured',
      shareUrl: 'https://example.test/share/abc',
    }),
  });
  try {
    await createReadyProfiles(app, ['deepseek']);
    const project = await json(app, { method: 'POST', url: '/api/projects', payload: { name: '分享测试' } });
    const prompt = await json(app, {
      method: 'POST', url: `/api/projects/${project.body.id}/prompts`, payload: { text: '带分享的问题' },
    });
    const run = await json(app, {
      method: 'POST', url: '/api/runs',
      payload: { projectId: project.body.id, promptIds: [prompt.body.id], platforms: ['deepseek'] },
    });
    await app.geo.worker.whenIdle();
    const detail = await json(app, { method: 'GET', url: `/api/runs/${run.body.id}` });
    assert.equal(detail.body.status, 'completed');
    assert.equal(detail.body.platformRuns[0].shareStatus, 'captured');
    assert.equal(detail.body.platformRuns[0].shareUrl, 'https://example.test/share/abc');
  } finally {
    await app.close();
    await rm(dataDirectory, { recursive: true, force: true });
  }
});

test('serves evidence only from the dedicated artifacts directory', async () => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), 'geo-monitoring-api-'));
  await mkdir(path.join(dataDirectory, 'artifacts', 'run-1'), { recursive: true });
  await writeFile(path.join(dataDirectory, 'artifacts', 'run-1', 'evidence.txt'), 'evidence', 'utf8');
  const app = await buildServer({ dataDirectory, executePlatformRun: async () => ({}) });
  try {
    const response = await app.inject({ method: 'GET', url: '/artifacts/run-1/evidence.txt' });
    assert.equal(response.statusCode, 200);
    assert.equal(response.body, 'evidence');
    const protectedResponse = await app.inject({ method: 'GET', url: '/artifacts/../geo-monitoring.sqlite' });
    assert.equal(protectedResponse.statusCode, 404);
  } finally {
    await app.close();
    await rm(dataDirectory, { recursive: true, force: true });
  }
});

test('calculates brand mention rate and keeps source evidence for brand monitoring', async () => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), 'geo-monitoring-brand-'));
  const app = await buildServer({
    dataDirectory,
    executePlatformRun: async () => ({
      content: '这类需求可以考虑千威，回答同时保留原始来源。',
      responseUrl: 'https://example.test/answer',
      sourcePanelOpened: true,
      platformReportedCount: 1,
      citations: [{
        position: 1,
        title: '品牌使用说明',
        url: 'https://source.example.com/guide',
        domain: 'source.example.com',
        citationFragments: [],
        citationOccurrences: 1,
      }],
      artifacts: [],
    }),
  });
  try {
    await createReadyProfiles(app, ['deepseek']);
    const brand = await json(app, {
      method: 'POST',
      url: '/api/brands',
      payload: { name: '千威', aliases: ['千威牌'], products: ['西地那非'] },
    });
    const questions = await json(app, {
      method: 'POST',
      url: `/api/brands/${brand.body.id}/questions`,
      payload: { texts: ['第一次买哪个牌子更稳？'] },
    });
    const run = await json(app, {
      method: 'POST',
      url: '/api/monitoring-runs',
      payload: {
        brandId: brand.body.id,
        questionIds: [questions.body.questions[0].id],
        platforms: ['deepseek'],
        platformModes: { deepseek: 'headless' },
      },
    });
    await app.geo.worker.whenIdle();
    const overview = await json(app, { method: 'GET', url: `/api/brands/${brand.body.id}/overview?days=30` });
    assert.equal(overview.body.summary.completed, 1);
    assert.equal(overview.body.summary.mentioned, 1);
    assert.equal(overview.body.summary.mentionRate, 100);
    const detail = await json(app, { method: 'GET', url: `/api/runs/${run.body.id}` });
    assert.equal(detail.body.platformRuns[0].answer.brandMentioned, true);
    assert.deepEqual(detail.body.platformRuns[0].answer.matchedTerms, ['千威']);
    const sources = await json(app, { method: 'GET', url: `/api/brands/${brand.body.id}/sources?days=30` });
    assert.equal(sources.body.summary.uniqueUrls, 1);
    assert.deepEqual(sources.body.sources[0].platforms, ['deepseek']);
  } finally {
    await app.close();
    await rm(dataDirectory, { recursive: true, force: true });
  }
});

test('熔断：没有可用登录账号时挂起剩余检查，而不是批量判失败', async () => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), 'geo-monitoring-login-required-'));
  let executed = false;
  const app = await buildServer({
    dataDirectory,
    executePlatformRun: async () => {
      executed = true;
      return { content: '回答', citations: [], artifacts: [] };
    },
  });
  try {
    await json(app, {
      method: 'POST', url: '/api/profiles',
      payload: { platformId: 'kimi', account: '13220602153' },
    });
    const project = await json(app, { method: 'POST', url: '/api/projects', payload: { name: '登录态测试' } });
    const prompt = await json(app, {
      method: 'POST', url: `/api/projects/${project.body.id}/prompts`, payload: { text: '需要登录的问题' },
    });
    const run = await json(app, {
      method: 'POST', url: '/api/runs',
      payload: { projectId: project.body.id, promptIds: [prompt.body.id], platforms: ['kimi'] },
    });

    // 没有可用账号时检查不会执行，而是挂起等人工决定。
    const detail = await waitForPlatformRun(app, run.body.id, (platformRun) => platformRun.status === 'parked');
    assert.equal(executed, false);
    assert.match(detail.platformRuns[0].errorMessage, /没有可用的登录账号/);
    // 熔断原因要带到任务详情，界面据此给出续跑 / 中止入口。
    const kimi = detail.platformStates.find((item) => item.platformId === 'kimi');
    assert.equal(kimi.cooldown.kind, 'no_account');
    assert.equal(kimi.parked, 1);

    // 中止：挂起的检查标记为已跳过，任务才能正常收尾。
    await json(app, { method: 'POST', url: `/api/runs/${run.body.id}/platforms/kimi/abort`, payload: {} });
    await app.geo.worker.whenIdle();
    const aborted = await json(app, { method: 'GET', url: `/api/runs/${run.body.id}` });
    assert.equal(aborted.body.platformRuns[0].status, 'skipped');
    assert.equal(aborted.body.status, 'partial_failed');
  } finally {
    await app.close();
    await rm(dataDirectory, { recursive: true, force: true });
  }
});

test('熔断：人工续跑后剩余检查重新回到队列', async () => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), 'geo-monitoring-resume-'));
  const executed = [];
  const app = await buildServer({
    dataDirectory,
    executePlatformRun: async ({ platformRun }) => {
      executed.push(platformRun.id);
      return { content: '回答', citations: [], artifacts: [] };
    },
  });
  try {
    const project = await json(app, { method: 'POST', url: '/api/projects', payload: { name: '续跑测试' } });
    const prompt = await json(app, {
      method: 'POST', url: `/api/projects/${project.body.id}/prompts`, payload: { text: '需要登录的问题' },
    });
    const run = await json(app, {
      method: 'POST', url: '/api/runs',
      payload: { projectId: project.body.id, promptIds: [prompt.body.id], platforms: ['kimi'] },
    });

    await waitForPlatformRun(app, run.body.id, (platformRun) => platformRun.status === 'parked');
    assert.equal(executed.length, 0);

    // 补一个可用账号后再续跑：挂起的检查应重新排队并真正执行。
    await createReadyProfiles(app, ['kimi']);
    const resumed = await json(app, { method: 'POST', url: `/api/runs/${run.body.id}/platforms/kimi/resume`, payload: {} });
    assert.equal(resumed.body.resumed, 1);
    await app.geo.worker.whenIdle();

    const detail = await json(app, { method: 'GET', url: `/api/runs/${run.body.id}` });
    assert.equal(executed.length, 1);
    assert.equal(detail.body.platformRuns[0].status, 'completed');
    assert.equal(detail.body.status, 'completed');
  } finally {
    await app.close();
    await rm(dataDirectory, { recursive: true, force: true });
  }
});

test('binds a ready login profile to the platform run', async () => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), 'geo-monitoring-profile-binding-'));
  let boundProfileId = '';
  const app = await buildServer({
    dataDirectory,
    executePlatformRun: async ({ platformRun }) => {
      boundProfileId = platformRun.profileId;
      return { content: '回答', citations: [], artifacts: [] };
    },
  });
  try {
    const created = await json(app, {
      method: 'POST', url: '/api/profiles',
      payload: { platformId: 'kimi', account: '13220602153' },
    });
    await json(app, { method: 'PATCH', url: `/api/profiles/${created.body.id}`, payload: { health: 'ready' } });

    const project = await json(app, { method: 'POST', url: '/api/projects', payload: { name: '绑定测试' } });
    const prompt = await json(app, {
      method: 'POST', url: `/api/projects/${project.body.id}/prompts`, payload: { text: '带登录态的问题' },
    });
    const run = await json(app, {
      method: 'POST', url: '/api/runs',
      payload: { projectId: project.body.id, promptIds: [prompt.body.id], platforms: ['kimi'] },
    });
    await app.geo.worker.whenIdle();

    assert.equal(boundProfileId, '13220602153');
    const detail = await json(app, { method: 'GET', url: `/api/runs/${run.body.id}` });
    assert.equal(detail.body.status, 'completed');
    assert.equal(detail.body.platformRuns[0].profileId, '13220602153');

    const profiles = await json(app, { method: 'GET', url: '/api/profiles?platformId=kimi' });
    assert.equal(profiles.body[0].health, 'ready');
    assert.ok(profiles.body[0].lastUsedAt);
  } finally {
    await app.close();
    await rm(dataDirectory, { recursive: true, force: true });
  }
});

test('cancels a run that no worker is executing so it stops showing as cancelling', async () => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), 'geo-monitoring-zombie-cancel-'));
  const app = await buildServer({
    dataDirectory,
    executePlatformRun: async () => ({ content: '回答', citations: [], artifacts: [] }),
  });
  try {
    await createReadyProfiles(app, ['kimi']);
    const project = await json(app, { method: 'POST', url: '/api/projects', payload: { name: '僵尸任务取消' } });
    const prompt = await json(app, {
      method: 'POST', url: `/api/projects/${project.body.id}/prompts`, payload: { text: '会被中断的问题' },
    });
    const run = await json(app, {
      method: 'POST', url: '/api/runs',
      payload: { projectId: project.body.id, promptIds: [prompt.body.id], platforms: ['kimi'] },
    });
    await app.geo.worker.whenIdle();

    // 模拟服务重启：任务卡在 running 且已经请求过取消，内存里没有 Worker 再接管它。
    const timestamp = new Date().toISOString();
    app.geo.database.prepare(`UPDATE runs SET status = 'running', completed_at = NULL, cancel_requested_at = ? WHERE id = ?`).run(timestamp, run.body.id);
    app.geo.database.prepare(`UPDATE platform_runs SET status = 'running', completed_at = NULL WHERE run_id = ?`).run(run.body.id);

    const cancelled = await json(app, { method: 'POST', url: `/api/runs/${run.body.id}/cancel` });
    assert.equal(cancelled.response.statusCode, 200);
    assert.equal(cancelled.body.status, 'cancelled');
    assert.notEqual(cancelled.body.status, 'running');
    const detail = await json(app, { method: 'GET', url: `/api/runs/${run.body.id}` });
    assert.equal(detail.body.platformRuns[0].status, 'cancelled');
  } finally {
    await app.close();
    await rm(dataDirectory, { recursive: true, force: true });
  }
});

test('recovers runs left running by a previous process when the server starts', async () => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), 'geo-monitoring-zombie-boot-'));
  const first = await buildServer({
    dataDirectory,
    executePlatformRun: async () => ({ content: '回答', citations: [], artifacts: [] }),
  });
  let runId = '';
  try {
    await createReadyProfiles(first, ['kimi']);
    const project = await json(first, { method: 'POST', url: '/api/projects', payload: { name: '重启回收' } });
    const prompt = await json(first, {
      method: 'POST', url: `/api/projects/${project.body.id}/prompts`, payload: { text: '重启前的问题' },
    });
    const run = await json(first, {
      method: 'POST', url: '/api/runs',
      payload: { projectId: project.body.id, promptIds: [prompt.body.id], platforms: ['kimi'] },
    });
    await first.geo.worker.whenIdle();
    runId = run.body.id;
  } finally {
    await first.close();
  }

  // 上一个进程被强杀，数据库里留下了仍是 running 的任务。
  const database = openDatabase(path.join(dataDirectory, 'brand-monitoring.sqlite'));
  database.prepare(`UPDATE runs SET status = 'running', completed_at = NULL WHERE id = ?`).run(runId);
  database.prepare(`UPDATE platform_runs SET status = 'running', completed_at = NULL WHERE run_id = ?`).run(runId);
  database.close();

  const second = await buildServer({ dataDirectory, executePlatformRun: async () => ({ content: '回答', citations: [], artifacts: [] }) });
  try {
    const detail = await json(second, { method: 'GET', url: `/api/runs/${runId}` });
    assert.notEqual(detail.body.status, 'running');
    assert.equal(detail.body.status, 'cancelled');
    assert.equal(detail.body.platformRuns[0].status, 'cancelled');
  } finally {
    await second.close();
    await rm(dataDirectory, { recursive: true, force: true });
  }
});
