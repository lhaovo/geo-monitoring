import { chromium } from 'playwright';
import { browserLaunchOptions } from '../browser.js';
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

// 登录窗口存活期间持续探测页面状态的间隔。
// 浏览器窗口一旦关闭页面就没了，事后无法再判断登录结果，
// 因此只能在窗口打开期间把状态记录下来。
const PROBE_INTERVAL_MS = 1_500;

function now() {
  return new Date().toISOString();
}

async function defaultOpenContext({ userDataDir, entryUrl }) {
  const context = await chromium.launchPersistentContext(userDataDir, browserLaunchOptions({ headless: false }));
  const page = context.pages()[0] ?? await context.newPage();
  try {
    await page.goto(entryUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  } catch {
    // 入口页偶发超时不影响人工登录，保持窗口打开即可。
  }
  return { context, page };
}

// 登录窗口关闭时判定登录态该落到哪个状态。
//
// 这里以「探测到的页面内容」为准，URL 只作为探测不出结论时的兜底：
// 只看 URL 会把「已登录但账号已被平台禁言」误判成登录成功，
// 让被限制的账号重新回到可调度队列里继续消耗配额。
export function evaluateLoginOutcome(loginState, authentication) {
  const urlLoginFlow = authentication === LOGIN_FLOW;
  const status = loginState?.status ?? 'unknown';

  if (status === 'restricted') {
    const message = loginState.message ?? '账号已被平台限制。';
    return {
      health: 'restricted',
      restrictedUntil: loginState.restrictedUntil ?? null,
      lastError: message,
      message: `登录窗口已关闭，检测到账号被平台限制：${message}`,
    };
  }

  if (status === 'unauthenticated') {
    return {
      health: 'expired',
      restrictedUntil: null,
      lastError: '关闭浏览器时仍未完成登录，请确认账号已登录。',
      message: '关闭时仍未完成登录，该登录态被标记为需要重新登录。',
    };
  }

  if (status === 'challenge') {
    return {
      health: 'error',
      restrictedUntil: null,
      lastError: '登录窗口关闭时页面停留在验证码/人机校验界面，请重新登录。',
      message: '关闭时页面停留在验证码界面，该登录态被标记为异常。',
    };
  }

  if (status === 'authenticated') {
    return {
      health: 'ready',
      restrictedUntil: null,
      lastError: null,
      message: '登录窗口已关闭，登录态已标记为可用。',
    };
  }

  // 探测不到明确结论（例如平台页面结构特殊），退回 URL 兜底。
  if (urlLoginFlow) {
    return {
      health: 'expired',
      restrictedUntil: null,
      lastError: '关闭浏览器时仍停留在登录页面，请确认账号已登录。',
      message: '关闭时仍停留在登录页面，该登录态被标记为需要重新登录。',
    };
  }
  return {
    health: 'ready',
    restrictedUntil: null,
    lastError: null,
    message: '登录窗口已关闭，登录态已标记为可用。',
  };
}

// 登录窗口存活期间持续探测页面状态。
// 浏览器窗口一旦关闭页面就没了，事后无法再判断登录结果，
// 只能在窗口存活期间把最后一次探测结果记录下来。
function createLoginStateTracker(page, probe, onState) {
  let latest = { status: 'unknown', reason: 'not_checked' };
  let timer = null;
  let probing = false;

  const runProbe = async () => {
    if (probing) return;
    if (typeof page.isClosed === 'function' && page.isClosed()) return;
    probing = true;
    try {
      const state = await probe(page);
      if (state?.status) {
        latest = state;
        onState?.(state);
      }
    } catch {
      // 页面跳转过程中可能取不到内容，忽略本轮即可。
    } finally {
      probing = false;
    }
  };

  return {
    start() {
      void runProbe();
      timer = setInterval(() => { void runProbe(); }, PROBE_INTERVAL_MS);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    async probeNow() {
      await runProbe();
      return latest;
    },
    get latest() {
      return latest;
    },
  };
}

export class LoginManager {
  constructor({ repository, paths, openContext = defaultOpenContext, inspectLoginState = null } = {}) {
    this.repository = repository;
    this.paths = paths;
    this.openContext = openContext;
    // 登录窗口关闭前要按页面内容判断登录结果，这里允许注入探测实现以便测试。
    this.inspectLoginState = inspectLoginState
      ?? ((page, platformId) => getPlatformAdapter(platformId).inspectLoginState(page));
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
      loginState: null,
      tracker: null,
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
      // 登录窗口存活期间持续探测页面状态，
      // 关闭时才能判断账号是否真的登录成功、是否已被平台限制。
      session.tracker = createLoginStateTracker(
        page,
        (target) => this.inspectLoginState(target, platform.id),
        (state) => { session.loginState = state; },
      );
      session.tracker.start();
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

  // 浏览器窗口关闭后收尾：以窗口存活期间探测到的页面内容为准判断登录结果。
  finishSession(session) {
    if (session.status === 'closed') return;
    session.status = 'closed';
    session.closedAt = now();
    session.context = null;
    session.page = null;
    session.tracker?.stop();
    const outcome = evaluateLoginOutcome(session.loginState, session.authentication);
    session.message = outcome.message;
    try {
      this.repository.updateProfileByBinding(session.platformId, session.profileId, {
        health: outcome.health,
        lastLoginAt: now(),
        lastError: outcome.lastError,
        restrictedUntil: outcome.restrictedUntil ?? null,
      });
    } catch {
      // 登录态记录可能被并发删除，忽略即可。
    }
  }

  async closeSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) throw new ValidationError('未找到该登录会话。');
    if (session.context) {
      // 关闭前再探测一次，尽量拿到最新的页面状态。
      try {
        await session.tracker?.probeNow();
      } catch {
        // 探测失败时退回 URL 兜底判断。
      }
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
    const { context, page, binding, tracker, ...rest } = session;
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