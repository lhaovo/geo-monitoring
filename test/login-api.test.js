import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildServer } from '../src/api/server.js';
import { openDatabase } from '../src/db/database.js';
import { GeoRepository } from '../src/db/repository.js';
import { LoginManager } from '../src/login/login-manager.js';
import { createPaths } from '../src/config/paths.js';

async function json(app, options) {
  const response = await app.inject(options);
  return { response, body: response.body ? response.json() : null };
}

function fakeContext() {
  const listeners = new Map();
  const page = {
    url: () => 'https://example.test/chat',
    mainFrame: () => page,
    on(event, handler) { listeners.set(event, handler); },
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

test('通过接口新增账号并打开登录窗口', async () => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), 'geo-login-api-'));
  const database = openDatabase(path.join(dataDirectory, 'geo.sqlite'));
  const repository = new GeoRepository(database);
  const manager = new LoginManager({
    repository,
    paths: createPaths({ dataDirectory }),
    openContext: async () => fakeContext(),
  });
  const app = await buildServer({ dataDirectory, database, repository, loginManager: manager });
  try {
    const created = await json(app, {
      method: 'POST', url: '/api/login-sessions',
      payload: { platformId: 'wenxiaoyan', account: '13800005555' },
    });
    assert.equal(created.response.statusCode, 201);
    assert.equal(created.body.profile.profileId, '13800005555');
    assert.equal(created.body.session.status, 'open');

    const sessions = await json(app, { method: 'GET', url: '/api/login-sessions' });
    assert.equal(sessions.body.length, 1);
    assert.equal(sessions.body[0].platformId, 'wenxiaoyan');

    const profiles = await json(app, { method: 'GET', url: '/api/profiles?platformId=wenxiaoyan' });
    assert.equal(profiles.body.length, 1);
    assert.equal(profiles.body[0].account, '13800005555');

    const closed = await json(app, { method: 'POST', url: `/api/login-sessions/${created.body.session.id}/close` });
    assert.equal(closed.body.status, 'closed');

    const ready = await json(app, { method: 'GET', url: '/api/profiles?platformId=wenxiaoyan' });
    assert.equal(ready.body[0].health, 'ready');

    const status = await json(app, { method: 'GET', url: '/api/platforms/status' });
    const wenxiaoyan = status.body.find((item) => item.id === 'wenxiaoyan');
    assert.equal(wenxiaoyan.profileSummary.total, 1);
    assert.equal(wenxiaoyan.profileSummary.ready, 1);
    assert.equal(wenxiaoyan.loginStatus, 'ready');
  } finally {
    await app.close();
    database.close();
    await rm(dataDirectory, { recursive: true, force: true });
  }
});

test('登录接口拒绝未知平台', async () => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), 'geo-login-api-'));
  const app = await buildServer({ dataDirectory });
  try {
    const result = await json(app, {
      method: 'POST', url: '/api/login-sessions',
      payload: { platformId: 'unknown', account: '13800006666' },
    });
    assert.equal(result.response.statusCode, 400);
    assert.match(result.body.message, /不支持的平台/);
  } finally {
    await app.close();
    await rm(dataDirectory, { recursive: true, force: true });
  }
});

test('带 content-type 的空请求体也能关闭登录窗口', async () => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), 'geo-login-api-'));
  const database = openDatabase(path.join(dataDirectory, 'geo.sqlite'));
  const repository = new GeoRepository(database);
  const manager = new LoginManager({
    repository,
    paths: createPaths({ dataDirectory }),
    openContext: async () => fakeContext(),
  });
  const app = await buildServer({ dataDirectory, database, repository, loginManager: manager });
  try {
    const created = await json(app, {
      method: 'POST', url: '/api/login-sessions',
      payload: { platformId: 'wenxiaoyan', account: '13800007777' },
    });
    assert.equal(created.response.statusCode, 201);

    // 前端关闭窗口时没有请求体，但会带上 content-type: application/json。
    const closed = await json(app, {
      method: 'POST', url: `/api/login-sessions/${created.body.session.id}/close`,
      headers: { 'content-type': 'application/json' },
      payload: '',
    });
    assert.equal(closed.response.statusCode, 200);
    assert.equal(closed.body.status, 'closed');
  } finally {
    await app.close();
    database.close();
    await rm(dataDirectory, { recursive: true, force: true });
  }
});
