import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { chromium } from 'playwright';
import { resolveBrowserExecutable } from '../src/browser.js';
import { guardAgainstInterruption, probeLoginState } from '../src/platforms/base.js';
import { openDatabase } from '../src/db/database.js';
import { GeoRepository } from '../src/db/repository.js';
import { RunWorker } from '../src/worker/run-worker.js';
import { createWorkQueue } from '../src/worker/work-queue.js';
import { executePlatformRun } from '../src/infrastructure/platform-runner.js';

async function withRepository(callback) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'geo-challenge-'));
  const database = openDatabase(path.join(directory, 'geo.sqlite'));
  try {
    await callback(new GeoRepository(database));
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
}

// 造一个带指定页面内容的浏览器页面，用完即关。
async function withPage(html, callback) {
  const browser = await chromium.launch({ executablePath: resolveBrowserExecutable(), headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(html);
    await callback(page);
  } finally {
    await browser.close();
  }
}

// 千问被拦截时真实出现的形态：baxia 对话框里嵌一个 punish iframe。
const BAXIA_HTML = `<!doctype html><html><body>
  <div id=baxia-dialog-content class=baxia-dialog>
    <iframe id=baxia-punish src=https://chat2.qianwen.com/api/v2/chat/_____tmd_____/punish?x5secdata=abc style=width:420px;height:260px></iframe>
  </div>
</body></html>`;

const SLIDER_HTML = `<!doctype html><html><body>
  <div class=nc-container><div class=nc_wrapper>请按住滑块，拖动到最右边</div></div>
</body></html>`;

test('识别阿里云 Baxia 的 punish iframe 验证码', async () => {
  await withPage(BAXIA_HTML, async (page) => {
    const state = await probeLoginState(page, {});
    assert.equal(state.status, 'challenge');
    assert.equal(state.reason, 'human_challenge');
  });
});

test('识别阿里滑块文案', async () => {
  await withPage(SLIDER_HTML, async (page) => {
    const state = await probeLoginState(page, {});
    assert.equal(state.status, 'challenge');
  });
});

// DeepSeek 用的网易易盾空间点选验证码：提交问题之后才弹出。
const SHUMEI_HTML = `<!doctype html><html><body>
  <div class="ds-modal-overlay" style="z-index:1024"></div>
  <div class="ds-theme ds-modal-wrapper" style="z-index:1025;">
    <div class="ds-modal" aria-modal="true">
      <div class="ds-modal-content ds-elevated ds-shumei-captcha-modal" role="dialog">
        <div class="ds-modal-content__main ds-shumei-captcha-main">
          <div class="ds-shumei-captcha-content">
            <div class="shumei_captcha shumei_captcha_wrapper product-embed mode-spatial_select">
              <div class="shumei_captcha_slide_tips">点击图中最小的蓝色圆锥</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</body></html>`;

test('识别网易易盾空间点选验证码', async () => {
  await withPage(SHUMEI_HTML, async (page) => {
    const state = await probeLoginState(page, {});
    assert.equal(state.status, 'challenge');
  });
});

// Kimi 繁忙时弹的排队提示：非会员进不了优先队列，回答不会生成。
const KIMI_BUSY_HTML = `<!doctype html><html><body>
  <div class="modal-mask" style="z-index:30">
    <div class="modal-container" data-testid="confirm-dialog">
      <div class="header"><div class="title">提示</div></div>
      <div class="body">和Kimi聊天的人太多了，订阅会员可进入优先队列</div>
      <div class="bottom"><button>我知道了</button><button>去升级</button></div>
    </div>
  </div>
  <textarea></textarea>
</body></html>`;

test('识别 Kimi 繁忙排队提示', async () => {
  await withPage(KIMI_BUSY_HTML, async (page) => {
    const state = await probeLoginState(page, {});
    assert.equal(state.status, 'busy');
    assert.equal(state.reason, 'platform_busy');
    assert.ok(state.message.includes('优先队列'));
  });
});

test('繁忙按终态失败处理，不重试也不改动账号状态', async () => {
  await withRepository(async (repository) => {
    const { run, profile } = await seedRun(repository, { platformId: 'kimi' });
    const worker = new RunWorker({ repository, paths: {} });
    try {
      const queue = createWorkQueue({ repository });
      const platformRun = queue.claimNext(run.id, 'kimi', { leaseId: 'lease-1' });
      repository.assignPlatformRunProfile(platformRun.id, profile.profileId);

      const error = new Error('和Kimi聊天的人太多了，订阅会员可进入优先队列');
      error.code = 'platform_busy';
      worker.handlePlatformRunFailure(run.id, { ...platformRun, profileId: profile.profileId }, 'lease-1', error);

      const detail = repository.getRunDetail(run.id);
      assert.equal(detail.platformRuns[0].status, 'failed');
      assert.equal(repository.getProfile(profile.id).health, 'ready');

      const cooldown = repository.getPlatformCooldown('kimi');
      assert.equal(cooldown.kind, 'busy');
      assert.equal(cooldown.coolingDown, true);
    } finally {
      await worker.stop();
    }
  });
});

test('繁忙与验证码各自独立计数', async () => {
  await withRepository(async (repository) => {
    repository.recordPlatformChallenge('qwen', { threshold: 3, cooldownMs: 60_000, reason: '验证码' });
    repository.recordPlatformChallenge('qwen', { threshold: 3, cooldownMs: 60_000, reason: '验证码' });
    assert.equal(repository.getPlatformCooldown('qwen').strikeCount, 2);

    // 切到繁忙维度时重新计数，不与验证码累加；繁忙第一次就进入冷却。
    const busy = repository.recordPlatformBusy('qwen', { cooldownMs: 60_000, reason: '繁忙' });
    assert.equal(busy.kind, 'busy');
    assert.equal(busy.coolingDown, true);
    assert.equal(busy.strikeCount, 0);
    assert.equal(repository.getPlatformCooldown('qwen').kind, 'busy');
  });
});

test('没有验证码时不会误判', async () => {
  await withPage('<!doctype html><html><body><textarea></textarea></body></html>', async (page) => {
    const state = await probeLoginState(page, {});
    assert.equal(state.status, 'authenticated');
  });
});

test('无头模式遇到验证码立即失败，交给上层切换有头模式', async () => {
  await withPage(BAXIA_HTML, async (page) => {
    await assert.rejects(
      () => guardAgainstInterruption(page, {}, { mode: 'headless' }),
      (error) => error.code === 'human_challenge',
    );
  });
});

test('有头模式等待人工完成验证码后放行', async () => {
  await withPage(BAXIA_HTML, async (page) => {
    const events = [];
    // 模拟操作员在 1.5 秒后把验证码滑过：移除拦截框即视为通过。
    setTimeout(() => {
      void page.evaluate(() => document.getElementById('baxia-dialog-content')?.remove());
    }, 1_500);
    const result = await guardAgainstInterruption(page, {}, {
      mode: 'headed',
      challengeTimeoutMs: 20_000,
      onChallenge: (info) => events.push(info.status),
    });
    assert.deepEqual(result, { cleared: true });
    assert.deepEqual(events, ['challenge', 'cleared']);
  });
});

test('有头模式一直不过验证码则超时失败', async () => {
  await withPage(BAXIA_HTML, async (page) => {
    await assert.rejects(
      () => guardAgainstInterruption(page, {}, { mode: 'headed', challengeTimeoutMs: 1_200 }),
      (error) => error.code === 'human_challenge',
    );
  });
});

test('等待回答期间登录态失效会被立刻发现', async () => {
  const html = '<!doctype html><html><body><input type=password></body></html>';
  await withPage(html, async (page) => {
    await assert.rejects(
      () => guardAgainstInterruption(page, {}, { mode: 'headless' }),
      (error) => error.code === 'login_required',
    );
  });
});

test('验证码累计到阈值后平台进入冷却，可手动解除', async () => {
  await withRepository(async (repository) => {
    const first = repository.recordPlatformChallenge('qwen', { threshold: 3, cooldownMs: 60_000, reason: '第一次' });
    assert.equal(first.strikeCount, 1);
    assert.equal(first.coolingDown, false);

    const second = repository.recordPlatformChallenge('qwen', { threshold: 3, cooldownMs: 60_000, reason: '第二次' });
    assert.equal(second.strikeCount, 2);
    assert.equal(second.coolingDown, false);

    const third = repository.recordPlatformChallenge('qwen', { threshold: 3, cooldownMs: 60_000, reason: '第三次' });
    assert.equal(third.coolingDown, true);
    assert.ok(third.cooldownUntil);

    const cooldown = repository.getPlatformCooldown('qwen');
    assert.equal(cooldown.coolingDown, true);
    assert.equal(cooldown.reason, '第三次');

    // 冷却期间不再累计。
    const duringCooldown = repository.recordPlatformChallenge('qwen', { threshold: 3, cooldownMs: 60_000 });
    assert.equal(duringCooldown.coolingDown, true);

    repository.clearPlatformCooldown('qwen');
    assert.equal(repository.getPlatformCooldown('qwen'), null);
  });
});

async function seedRun(repository, { platformId = 'qwen', prompts = 1 } = {}) {
  const brand = repository.createBrand({ name: '验证码品牌' });
  const promptIds = [];
  for (let index = 0; index < prompts; index += 1) {
    promptIds.push(repository.createPrompt(brand.id, { text: `问题 ${index + 1}` }).id);
  }
  const run = repository.createRun({ projectId: brand.id, promptIds, platforms: [platformId] });
  const profile = repository.createProfile({ platformId, account: '13800000000' });
  repository.updateProfile(profile.id, { health: 'ready' });
  return { run, profile };
}

test('验证码失败按终态处理，且不改动账号状态', async () => {
  await withRepository(async (repository) => {
    const { run, profile } = await seedRun(repository);
    const worker = new RunWorker({ repository, paths: {} });
    try {
      const queue = createWorkQueue({ repository });
      const platformRun = queue.claimNext(run.id, 'qwen', { leaseId: 'lease-1' });
      repository.assignPlatformRunProfile(platformRun.id, profile.profileId);

      const error = new Error('平台要求人工完成验证码或安全校验，本次未继续执行。');
      error.code = 'human_challenge';
      worker.handlePlatformRunFailure(run.id, { ...platformRun, profileId: profile.profileId }, 'lease-1', error);

      const detail = repository.getRunDetail(run.id);
      assert.equal(detail.platformRuns[0].status, 'failed');

      // 验证码属于平台风控，不应该把账号标记为异常。
      const updated = repository.getProfile(profile.id);
      assert.equal(updated.health, 'ready');
      assert.ok(updated.lastError);

      const cooldown = repository.getPlatformCooldown('qwen');
      assert.equal(cooldown.strikeCount, 1);
      assert.equal(cooldown.coolingDown, false);
    } finally {
      await worker.stop();
    }
  });
});


// 无头撞到验证码时，要自动改用有头模式重跑同一条任务，
// 而且两次尝试的现场证据都要保留下来。
test('无头撞到验证码时自动改用有头模式重跑同一条任务', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'geo-challenge-retry-'));
  const paths = {
    artifactsDirectory: path.join(directory, 'artifacts'),
    profilesDirectory: path.join(directory, 'profiles'),
  };
  const pageFile = path.join(directory, 'platform.html');
  await writeFile(pageFile, '<!doctype html><html><body><div>测试平台</div></body></html>', 'utf8');

  let loginChecks = 0;
  const adapter = {
    id: 'fake',
    label: '测试平台',
    entryUrl: `file://${pageFile.replace(/\\/g, '/')}`,
    async inspectLoginState() {
      loginChecks += 1;
      // 第一次（无头）探测报告验证码，第二次（有头）恢复正常。
      return loginChecks === 1
        ? { status: 'challenge', reason: 'human_challenge' }
        : { status: 'authenticated', reason: 'chat_input_visible' };
    },
    async submitQuestion() {
      return 'typed';
    },
    async waitForAnswer() {
      return '回答内容';
    },
  };

  const messages = [];
  try {
    const result = await executePlatformRun({
      platformRun: { id: 'platform-run-1', runId: 'run-1', prompt: { text: '问题' }, platformId: 'fake', profileId: '13800000000' },
      adapter,
      paths,
      mode: 'headless',
      emit: (message) => messages.push(message),
    });
    assert.equal(result.content, '回答内容');
    assert.equal(loginChecks, 2);
    assert.ok(messages.some((message) => message.includes('改用有头模式')));
    const files = await readdir(path.join(paths.artifactsDirectory, 'run-1', 'platform-run-1'));
    // 第一次尝试的现场与重试的现场分开保存，互不覆盖。
    assert.ok(files.includes('error.html'));
    assert.ok(files.includes('03-answer-retry.html'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('平台冷却期间不再领取该平台的任务', async () => {
  await withRepository(async (repository) => {
    const { run } = await seedRun(repository, { prompts: 2 });
    repository.recordPlatformChallenge('qwen', { threshold: 1, cooldownMs: 60_000, reason: '连续验证码' });
    const worker = new RunWorker({ repository, paths: {} });
    try {
      const events = [];
      worker.on('event', (event) => events.push(event));
      await worker.consumePlatformQueue({
        runId: run.id,
        platformId: 'qwen',
        appendSearchPrompt: false,
        acquire: async () => {},
        release: () => {},
      });
      const summary = worker.workQueue.summarize(run.id);
      assert.equal(summary[0].running, 0);
      assert.equal(summary[0].queued, 2);
      assert.ok(events.some((event) => event.level === 'error' && event.message.includes('暂停该平台')));
    } finally {
      await worker.stop();
    }
  });
});
