import { chromium } from 'playwright';
import { resolveBrowserExecutable } from '../browser.js';
import { describeAuthentication } from './authentication.js';
import { getPlatformAdapter } from '../platforms/index.js';
import { profilePaths } from '../profiles/profile-paths.js';
import { normalizeAccountIdentity } from '../profiles/account-identity.js';
import { ValidationError } from '../shared/errors.js';
import { createId } from '../shared/ids.js';

// 登录窗口由后端进程直接拉起，操作员在可见浏览器里手动完成登录，
// 关闭浏览器后由这里把登录态标记为可用。
// 之所以不让浏览器自行判定登录结果，是因为平台登录页与首页的跳转规则
// 各不相同，用「关闭时是否仍停留在登录页」作为兜底判断更稳定。

const LOGIN_FLOW = 'login_flow_detected';

function now() {
  return new Date().toISOString();
}

async function defaultOpenContext({ userDataDir, entryUrl }) {
  const executablePath = resolveBrowserExecutable();
  const context = await chromium.launchPersistentContext(userDataDir, {
    executablePath,
    headless: false,
    viewport: { width: 1440, height: 960 },
  });
  const page = context.pages()[0] ?? await context.newPage();
  try {
    await page.goto(entryUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  } catch {
    // 入口页偶发超时不影响人工登录，保持窗口打开即可。
  }
  return { context, page };
}

export class LoginManager {
  constructor({ repository, paths, openContext = defaultOpenContext } = {}) {
    this.repository = repository;
    this.paths = paths;
    this.openContext = openContext;
    this.sessions = new Map();
  }

  // 找到或创建账号对应的登录态记录：优先按 Profile 标识，其次按账号。
  resolveProfile({ platformId, account = '', profileId = '', label = '' }) {
    if (profileId) {
      const existing = this.repository.getProfileByBinding(platformId, profileId);
      if (existing) return existing;
    }
    const normalizedAccount = normalizeAccountIdentity(account);
    if (!normalizedAccount) {
      throw new ValidationError('必须提供账号或手机号。');
    }
    const byAccount = this.repository.findProfileByAccount(platformId, normalizedAccount);
    if (byAccount) return byAccount;
    return this.repository.createProfile({ platformId, account: normalizedAccount, label });
  }

  findOpenSession(binding) {
    for (const session of this.sessions.values()) {
      if (session.binding === binding && (session.status === 'starting' || session.status === 'open')) return session;
    }
    return null;
  }

  // 打开登录窗口：同一个平台的同一个账号只允许存在一个登录窗口，
  // 否则 Chrome 会因为 Profile 锁而启动失败。
  async startSession({ platformId, account = '', profileId = '', label = '' }) {
    const platform = getPlatformAdapter(platformId);
    const profile = this.resolveProfile({ platformId, account, profileId, label });
    const binding = `${profile.platformId}:${profile.profileId}`;
    const running = this.findOpenSession(binding);
    if (running) {
      return { profile, session: this.publicSession(running), reused: true };
    }

    const session = {
      id: createId(),
      binding,
      platformId: profile.platformId,
      profileId: profile.profileId,
      account: profile.account,
      label: profile.label,
      status: 'starting',
      message: '正在启动浏览器…',
      startedAt: now(),
      closedAt: null,
      lastUrl: null,
      authentication: 'manual_review_required',
      context: null,
      page: null,
    };
    this.sessions.set(session.id, session);

    try {
      const { chromeDirectory } = profilePaths(this.paths, profile.platformId, profile.profileId);
      const { context, page } = await this.openContext({
        userDataDir: chromeDirectory,
        entryUrl: platform.entryUrl,
        platform,
      });
      session.context = context;
      session.page = page;
      session.status = 'open';
      session.message = `已在浏览器中打开 ${platform.label}，请完成登录后关闭窗口。`;
      this.trackNavigation(session, page);
      context.once('close', () => this.finishSession(session));
    } catch (error) {
      session.status = 'failed';
      session.message = `启动登录窗口失败：${error.message}`;
      session.closedAt = now();
    }
    return { profile, session: this.publicSession(session), reused: false };
  }

  trackNavigation(session, page) {
    const update = () => {
      try {
        session.lastUrl = page.url();
        session.authentication = describeAuthentication(session.lastUrl);
      } catch {
        // 页面已关闭时忽略。
      }
    };
    update();
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) update();
    });
  }

  // 浏览器窗口关闭后收尾：仍停留在登录页说明没有登录成功，标记为过期。
  finishSession(session) {
    if (session.status === 'closed') return;
    session.status = 'closed';
    session.closedAt = now();
    session.context = null;
    session.page = null;
    const loggedIn = session.authentication !== LOGIN_FLOW;
    session.message = loggedIn
      ? '登录窗口已关闭，登录态已标记为可用。'
      : '关闭时仍停留在登录页面，该登录态被标记为需要重新登录。';
    try {
      this.repository.updateProfileByBinding(session.platformId, session.profileId, {
        health: loggedIn ? 'ready' : 'expired',
        lastLoginAt: now(),
        lastError: loggedIn ? null : '关闭浏览器时仍停留在登录页面，请确认账号已登录。',
        restrictedUntil: null,
      });
    } catch {
      // 登录态记录可能被并发删除，忽略即可。
    }
  }

  async closeSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) throw new ValidationError('未找到该登录会话。');
    if (session.context) {
      try {
        await session.context.close();
      } catch {
        // 浏览器可能已被操作员关闭。
      }
    }
    this.finishSession(session);
    return this.publicSession(session);
  }

  publicSession(session) {
    if (!session) return null;
    const { context, page, binding, ...rest } = session;
    return { ...rest, binding };
  }

  listSessions() {
    return [...this.sessions.values()].map((session) => this.publicSession(session));
  }

  getSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) throw new ValidationError('未找到该登录会话。');
    return this.publicSession(session);
  }
}