import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openDatabase } from '../src/db/database.js';
import { GeoRepository } from '../src/db/repository.js';
import { LoginManager, evaluateLoginOutcome } from '../src/login/login-manager.js';
import { createPaths } from '../src/config/paths.js';

// 用一个假的浏览器上下文替代 Playwright，测试登录会话的状态流转。
function fakeContext({ url = 'https://example.com/chat' } = {}) {
  const listeners = new Map();
  const page = {
    url: () => url,
    isClosed: () => false,
    mainFrame: () => page,
    on(event, handler) { listeners.set(event, handler); },
    emit(event, payload) { listeners.get(event)?.(payload); },
  };
  const context = {
    page,
    closed: false,
    once(event, handler) { listeners.set(event, handler); },
    async close() {
      if (this.closed) return;
      this.closed = true;
      listeners.get('close')?.();
    },
  };
  return { context, page };
}

async function withManager(callback, options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'geo-login-'));
  const database = openDatabase(path.join(directory, 'geo.sqlite'));
  const repository = new GeoRepository(database);
  const paths = createPaths({ dataDirectory: directory });
  const browsers = [];
  const manager = new LoginManager({
    repository,
    paths,
    inspectLoginState: options.inspectLoginState ?? null,
    openContext: async () => {
      const browser = fakeContext();
      browsers.push(browser);
      return browser;
    },
  });
  try {
    await callback({ manager, repository, browsers });
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
}

test('新增账号时创建登录态并打开登录窗口', async () => {
  await withManager(async ({ manager, repository, browsers }) => {
    const result = await manager.startSession({ platformId: 'wenxiaoyan', account: '13800001111' });
    assert.equal(result.reused, false);
    assert.equal(result.profile.profileId, '13800001111');
    assert.equal(result.profile.health, 'new');
    assert.equal(result.session.status, 'open');
    assert.match(result.session.message, /浏览器/);
    assert.equal(browsers.length, 1);
    assert.equal(repository.getProfileByBinding('wenxiaoyan', '13800001111').id, result.profile.id);
  });
});

test('同一个账号重复发起登录会复用已打开的窗口', async () => {
  await withManager(async ({ manager, browsers }) => {
    const first = await manager.startSession({ platformId: 'qwen', account: 'a@example.com' });
    const second = await manager.startSession({ platformId: 'qwen', account: 'a@example.com' });
    assert.equal(second.reused, true);
    assert.equal(second.session.id, first.session.id);
    assert.equal(browsers.length, 1);
  });
});

test('关闭登录窗口后登录态标记为可用', async () => {
  await withManager(async ({ manager, repository }) => {
    const result = await manager.startSession({ platformId: 'doubao', account: '13800002222' });
    await manager.closeSession(result.session.id);
    const profile = repository.getProfile(result.profile.id);
    assert.equal(profile.health, 'ready');
    assert.ok(profile.lastLoginAt);
    assert.equal(manager.getSession(result.session.id).status, 'closed');
  });
});

test('关闭时仍停留在登录页则登录态标记为需要重新登录', async () => {
  await withManager(async ({ manager, repository, browsers }) => {
    const result = await manager.startSession({ platformId: 'kimi', account: '13800003333' });
    browsers[0].page.url = () => 'https://example.com/login';
    browsers[0].page.emit('framenavigated', browsers[0].page);
    await manager.closeSession(result.session.id);
    const profile = repository.getProfile(result.profile.id);
    assert.equal(profile.health, 'expired');
    assert.match(profile.lastError, /登录页面/);
  });
});

test('列出登录会话并支持按 Profile 标识重新登录', async () => {
  await withManager(async ({ manager }) => {
    const created = await manager.startSession({ platformId: 'deepseek', account: '13800004444' });
    const sessions = manager.listSessions();
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].platformId, 'deepseek');
    assert.equal(sessions[0].profileId, created.profile.profileId);

    const again = await manager.startSession({ platformId: 'deepseek', profileId: created.profile.profileId });
    assert.equal(again.reused, true);
    assert.equal(again.profile.id, created.profile.id);
  });
});

test('登录窗口关闭时按页面内容判定：账号被平台限制时标记为受限', async () => {
  await withManager(async ({ manager, repository }) => {
    const result = await manager.startSession({ platformId: 'deepseek', account: '13800005555' });
    await manager.closeSession(result.session.id);
    const profile = repository.getProfile(result.profile.id);
    assert.equal(profile.health, 'restricted');
    assert.equal(profile.restrictedUntil, '2026-11-18T11:56:00+08:00');
    assert.match(profile.lastError, /违反用户使用规范/);
  }, {
    inspectLoginState: async () => ({
      status: 'restricted',
      reason: 'account_restricted',
      restrictionType: 'muted',
      message: '由于违反用户使用规范，你的账号已被禁言至 2026 年 11 月 18 日 11:56。',
      restrictedUntil: '2026-11-18T11:56:00+08:00',
    }),
  });
});

test('登录窗口关闭时页面仍是登录页则标记为需要重新登录', async () => {
  await withManager(async ({ manager, repository }) => {
    const result = await manager.startSession({ platformId: 'kimi', account: '13800006666' });
    await manager.closeSession(result.session.id);
    const profile = repository.getProfile(result.profile.id);
    assert.equal(profile.health, 'expired');
  }, {
    inspectLoginState: async () => ({ status: 'unauthenticated', reason: 'login_prompt_visible' }),
  });
});

test('登录窗口关闭时停在验证码界面则标记为异常', async () => {
  await withManager(async ({ manager, repository }) => {
    const result = await manager.startSession({ platformId: 'qwen', account: '13800007777' });
    await manager.closeSession(result.session.id);
    const profile = repository.getProfile(result.profile.id);
    assert.equal(profile.health, 'error');
    assert.match(profile.lastError, /验证码/);
  }, {
    inspectLoginState: async () => ({ status: 'challenge', reason: 'human_challenge' }),
  });
});

test('登录窗口关闭时页面显示已登录则标记为可用', async () => {
  await withManager(async ({ manager, repository }) => {
    const result = await manager.startSession({ platformId: 'doubao', account: '13800008888' });
    await manager.closeSession(result.session.id);
    const profile = repository.getProfile(result.profile.id);
    assert.equal(profile.health, 'ready');
    assert.equal(profile.lastError, null);
  }, {
    inspectLoginState: async () => ({ status: 'authenticated', reason: 'chat_input_visible' }),
  });
});

test('探测不出结论时退回 URL 兜底判断', async () => {
  await withManager(async ({ manager, repository, browsers }) => {
    const result = await manager.startSession({ platformId: 'wenxiaoyan', account: '13800009999' });
    browsers[0].page.url = () => 'https://example.com/login';
    browsers[0].page.emit('framenavigated', browsers[0].page);
    await manager.closeSession(result.session.id);
    const profile = repository.getProfile(result.profile.id);
    assert.equal(profile.health, 'expired');
  }, {
    inspectLoginState: async () => ({ status: 'unknown', reason: 'chat_input_not_found' }),
  });
});

test('登录会话会暴露最近一次探测到的页面状态', async () => {
  await withManager(async ({ manager }) => {
    const result = await manager.startSession({ platformId: 'deepseek', account: '13800010000' });
    await manager.closeSession(result.session.id);
    const session = manager.getSession(result.session.id);
    assert.equal(session.loginState.status, 'restricted');
    assert.match(session.message, /被平台限制/);
  }, {
    inspectLoginState: async () => ({
      status: 'restricted',
      message: '由于违反用户使用规范，你的账号已被禁言至 2026 年 11 月 18 日 11:56。',
      restrictedUntil: '2026-11-18T11:56:00+08:00',
    }),
  });
});

test('判定函数把受限账号与未登录账号区分开', async () => {
  const restricted = evaluateLoginOutcome({ status: 'restricted', message: '受限', restrictedUntil: '2026-11-18T11:56:00+08:00' }, 'manual_review_required');
  assert.equal(restricted.health, 'restricted');
  assert.equal(restricted.restrictedUntil, '2026-11-18T11:56:00+08:00');
  const expired = evaluateLoginOutcome({ status: 'unauthenticated' }, 'login_flow_detected');
  assert.equal(expired.health, 'expired');
  const ready = evaluateLoginOutcome({ status: 'authenticated' }, 'login_flow_detected');
  assert.equal(ready.health, 'ready');
});
