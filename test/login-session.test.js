import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openDatabase } from '../src/db/database.js';
import { GeoRepository } from '../src/db/repository.js';
import { LoginManager } from '../src/login/login-manager.js';
import { createPaths } from '../src/config/paths.js';

// 用一个假的浏览器上下文替代 Playwright，测试登录会话的状态流转。
function fakeContext({ url = 'https://example.com/chat' } = {}) {
  const listeners = new Map();
  const page = {
    url: () => url,
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

async function withManager(callback) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'geo-login-'));
  const database = openDatabase(path.join(directory, 'geo.sqlite'));
  const repository = new GeoRepository(database);
  const paths = createPaths({ dataDirectory: directory });
  const browsers = [];
  const manager = new LoginManager({
    repository,
    paths,
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