const INPUT_SELECTORS = [
  'textarea:not([disabled])',
  '[contenteditable=true][role=textbox]',
  '[contenteditable=true]',
  'input[type=text]:not([disabled])',
];

const SEND_BUTTON_SELECTORS = [
  'button[aria-label*=发送]',
  'button[aria-label*=Send]',
  'button[title*=发送]',
  'button[title*=Send]',
  'a[aria-label*=发送]',
  'a[aria-label*=Send]',
  '[role=button][aria-label*=发送]',
  '[role=button][aria-label*=Send]',
  '#yuanbao-send-btn',
  'button[class*=send]',
  'button[class*=submit]',
];

// 等待回答期间探测验证码的间隔。验证码与风控提示往往在提交问题之后才出现，
// 只在打开页面时探测一次会完全漏掉。
const CHALLENGE_PROBE_INTERVAL_MS = 5_000;

const LOGIN_PROMPT_SELECTORS = [
  'input[type=password]:visible',
  'input[autocomplete=one-time-code]:visible',
  'input[name="fm-sms-login-id"]:visible',
  'input[name="fm-smscode"]:visible',
  'input[placeholder*="手机号"]:visible',
  'input[placeholder*="验证码"]:visible',
  'form:has(input[type=password]):visible',
  'form:has(input[type=tel]):visible',
  '[class*=login-modal]:visible',
  '[class*=login-dialog]:visible',
  '[class*=login-panel]:visible',
  '[class*=signin-modal]:visible',
  '[class*=sign-in]:visible',
  '[class*=passport]:visible',
];

const SMS_CODE_INPUT_SELECTORS = [
  'input[autocomplete=one-time-code]',
  'input[name="fm-smscode"]',
  'input[placeholder*="验证码"]',
  'input[inputmode=decimal]',
];

const CHALLENGE_SELECTORS = [
  'iframe[src*=captcha]:visible',
  '[class*=captcha]:visible',
  '[id*=captcha]:visible',
  '[class*=slider-verify]:visible',
  '[class*=sliderVerify]:visible',
  '[class*=security-verify]:visible',
  // 阿里云内容安全（Baxia）的滑块验证：拦截框本身不带 captcha 字样，
  // 真正的验证码渲染在 punish iframe 里，选择器要覆盖这两种形态。
  'iframe[id*=baxia]:visible',
  'iframe[src*=baxia]:visible',
  'iframe[src*=punish]:visible',
  'iframe[src*="_____tmd_____"]:visible',
  '[class*=baxia-dialog]:visible',
  '[class*=nc-container]:visible',
  '[class*=nc_wrapper]:visible',
  '[class*=aliyun-captcha]:visible',
  // 网易易盾的空间点选验证码（DeepSeek 用的是这种）：
  // 弹窗挂在 ds-modal 里，类名带 shumei / captcha。
  '.ds-shumei-captcha-modal:visible',
  '[class*=shumei-captcha]:visible',
  '[class*=shumei_captcha]:visible',
  '[id^=sm-captcha]:visible',
  // 极验（Geetest）滑动 / 点选验证码
  '[class*=geetest]:visible',
  'iframe[src*=geetest]:visible',
];

const LOGIN_TEXT_PATTERN = /^(?:登录|立即登录|手机号登录|手机号码登录|验证码登录|短信登录|密码登录|账号密码登录|扫码登录|登录\/注册)$/u;
const CHALLENGE_TEXT_PATTERN = /(?:请完成安全验证|拖动滑块|滑到最右|完成拼图|验证码校验|请按住滑块|拖动到最右边|请拖动下方滑块完成验证|通过验证以确保正常访问|向右滑动|向右拖动滑块|点击图中最小的|请依次点击图中)/u;
const LOGIN_ERROR_PATTERN = /(?:账号或密码错误|账号密码错误|用户名或密码错误|密码错误|验证码错误|验证码不正确|验证码无效|无效的验证码|验证码已失效|验证码已过期|验证码格式|手机号格式不正确|请输入正确的手机号|登录失败|登录异常)/u;
const LOGIN_INPUT_PATTERN = /(?:手机号|手机号码|验证码|密码|账号|帐号|邮箱|phone|mobile|password|passcode|verification|one[- ]?time)/iu;
const ACCOUNT_RESTRICTION_PATTERN = /(?:\u8fdd\u53cd\u7528\u6237\u4f7f\u7528\u89c4\u8303|(?:\u8d26\u53f7|\u8d26\u6237|\u5e10\u53f7)[^\u3002\uff01\uff1f!?\n]{0,32}(?:\u7981\u8a00|\u5c01\u7981|\u9650\u5236|\u7981\u6b62\u4f7f\u7528|\u6682\u65f6\u65e0\u6cd5\u4f7f\u7528)|(?:\u4f60|\u60a8)(?:\u5df2|\u88ab)[^\u3002\uff01\uff1f!?\n]{0,12}(?:\u7981\u6b62\u4f7f\u7528|\u6682\u65f6\u65e0\u6cd5\u4f7f\u7528))/u;
const RESTRICTED_UNTIL_PATTERN = /(\d{4})\s*\u5e74\s*(\d{1,2})\s*\u6708\s*(\d{1,2})\s*\u65e5\s*(\d{1,2}):(\d{2})/u;

export function parseAccountRestriction(text) {
  const message = String(text ?? '').replace(/\s+/gu, ' ').trim();
  if (!message || !ACCOUNT_RESTRICTION_PATTERN.test(message)) return null;
  const untilMatch = message.match(RESTRICTED_UNTIL_PATTERN);
  const pad = (value) => String(value).padStart(2, '0');
  const restrictionType = /\u7981\u8a00/u.test(message)
    ? 'muted'
    : /\u5c01\u7981/u.test(message) ? 'banned' : 'restricted';
  return {
    status: 'restricted',
    reason: 'account_restricted',
    restrictionType,
    message,
    restrictedUntil: untilMatch
      ? untilMatch[1] + '-' + pad(untilMatch[2]) + '-' + pad(untilMatch[3]) + 'T' + pad(untilMatch[4]) + ':' + untilMatch[5] + ':00+08:00'
      : null,
    restrictedUntilText: untilMatch ? untilMatch[0].replace(/\s+/gu, '') : null,
  };
}
function pageRoots(page) {
  const mainFrame = page.mainFrame();
  const roots = [];
  for (const frame of page.frames()) {
    if (frame !== mainFrame) roots.push(frame);
  }
  roots.push(page);
  return roots;
}

function isVisibleCandidate(candidate, box, { minimumWidth = 0, minimumHeight = 0 } = {}) {
  if (!box || box.width < minimumWidth || box.height < minimumHeight) return false;
  return true;
}

export async function firstVisible(root, selectors, {
  minimumWidth = 0,
  minimumHeight = 0,
  requireEnabled = false,
} = {}) {
  for (const selector of selectors) {
    const candidates = root.locator(selector);
    const count = await candidates.count().catch(() => 0);
    for (let index = count - 1; index >= 0; index -= 1) {
      const candidate = candidates.nth(index);
      if (!await candidate.isVisible().catch(() => false)) continue;
      const box = await candidate.boundingBox().catch(() => null);
      if (!isVisibleCandidate(candidate, box, { minimumWidth, minimumHeight })) continue;
      if (requireEnabled && !await candidate.isEnabled().catch(() => false)) continue;
      return candidate;
    }
  }
  return null;
}

export async function firstVisibleAcrossFrames(page, selectors, options = {}) {
  for (const root of pageRoots(page)) {
    const candidate = await firstVisible(root, selectors, options);
    if (candidate) return candidate;
  }
  return null;
}

async function firstVisibleMatchingText(root, pattern, { maxTextLength = 300 } = {}) {
  const candidates = root.getByText(pattern);
  const count = await candidates.count().catch(() => 0);
  for (let index = count - 1; index >= 0; index -= 1) {
    const candidate = candidates.nth(index);
    if (!await candidate.isVisible().catch(() => false)) continue;
    const text = (await candidate.innerText().catch(() => '')).trim();
    if (!text || text.length > maxTextLength) continue;
    return candidate;
  }
  return null;
}

async function firstVisibleMatchingTextAcrossFrames(page, pattern, options = {}) {
  for (const root of pageRoots(page)) {
    const candidate = await firstVisibleMatchingText(root, pattern, options);
    if (candidate) return candidate;
  }
  return null;
}




async function isLikelyChatInput(candidate) {
  const attributes = await candidate.evaluate((element) => ({
    type: String(element.getAttribute('type') ?? '').toLowerCase(),
    placeholder: String(element.getAttribute('placeholder') ?? ''),
    ariaLabel: String(element.getAttribute('aria-label') ?? ''),
    name: String(element.getAttribute('name') ?? ''),
  })).catch(() => null);
  if (!attributes) return false;
  if (['password', 'tel', 'email'].includes(attributes.type)) return false;
  return !LOGIN_INPUT_PATTERN.test([attributes.placeholder, attributes.ariaLabel, attributes.name].join(' '));
}

async function firstVisibleChatInput(page) {
  for (const root of pageRoots(page)) {
    for (const selector of INPUT_SELECTORS) {
      const candidates = root.locator(selector);
      const count = await candidates.count().catch(() => 0);
      for (let index = count - 1; index >= 0; index -= 1) {
        const candidate = candidates.nth(index);
        if (!await candidate.isVisible().catch(() => false)) continue;
        if (!await candidate.isEnabled().catch(() => false)) continue;
        const box = await candidate.boundingBox().catch(() => null);
        if (!isVisibleCandidate(candidate, box, { minimumWidth: 80, minimumHeight: 20 })) continue;
        if (!await isLikelyChatInput(candidate)) continue;
        return candidate;
      }
    }
  }
  return null;
}

export async function probeLoginState(page, { loginPromptSelectors = [], loginPromptTextPattern = null } = {}) {
  if (page.isClosed()) return { status: 'closed', reason: 'page_closed' };
  const restrictionText = await firstVisibleMatchingTextAcrossFrames(page, ACCOUNT_RESTRICTION_PATTERN, { maxTextLength: 600 });
  if (restrictionText) {
    const message = (await restrictionText.innerText().catch(() => '')).trim();
    return parseAccountRestriction(message) ?? {
      status: 'restricted',
      reason: 'account_restricted',
      restrictionType: 'restricted',
      message: message || '账号已被平台限制。',
      restrictedUntil: null,
      restrictedUntilText: null,
    };
  }
  const challengeText = await firstVisibleMatchingTextAcrossFrames(page, CHALLENGE_TEXT_PATTERN);
  if (challengeText) return { status: 'challenge', reason: 'human_challenge' };

  const challengeWidget = await firstVisibleAcrossFrames(page, CHALLENGE_SELECTORS);
  const smsCodeInput = await firstVisibleAcrossFrames(page, SMS_CODE_INPUT_SELECTORS);
  if (challengeWidget && !smsCodeInput) return { status: 'challenge', reason: 'human_challenge' };

  const loginPrompt = await firstVisibleAcrossFrames(page, [...LOGIN_PROMPT_SELECTORS, ...loginPromptSelectors])
    ?? await firstVisibleMatchingTextAcrossFrames(page, LOGIN_TEXT_PATTERN)
    ?? (loginPromptTextPattern ? await firstVisibleMatchingTextAcrossFrames(page, loginPromptTextPattern) : null);
  const chatInput = await firstVisibleChatInput(page);
  if (chatInput && !loginPrompt) return { status: 'authenticated', reason: 'chat_input_visible' };
  if (loginPrompt) return { status: 'unauthenticated', reason: 'login_prompt_visible' };

  const urls = [page.url(), ...page.frames().map((frame) => frame.url())];
  if (urls.some((url) => /(?:login|signin|sign-in|passport|auth)/iu.test(url))) {
    return { status: 'unauthenticated', reason: 'login_url' };
  }
  return { status: 'unknown', reason: 'chat_input_not_found' };
}

export async function describeLoginPage(page) {
  const smsCodeInput = await firstVisibleAcrossFrames(page, SMS_CODE_INPUT_SELECTORS);
  const challengeText = await firstVisibleMatchingTextAcrossFrames(page, CHALLENGE_TEXT_PATTERN);
  const restrictionText = await firstVisibleMatchingTextAcrossFrames(page, ACCOUNT_RESTRICTION_PATTERN, { maxTextLength: 600 });
  const widgets = [];
  for (const selector of CHALLENGE_SELECTORS) {
    const found = await firstVisibleAcrossFrames(page, [selector]).catch(() => null);
    if (!found) continue;
    widgets.push({
      selector,
      box: await found.boundingBox().catch(() => null),
      html: await found.evaluate((element) => element.outerHTML.slice(0, 200)).catch(() => null),
    });
  }
  return {
    url: page.url(),
    smsCodeInputVisible: Boolean(smsCodeInput),
    challengeTextVisible: challengeText ? (await challengeText.innerText().catch(() => '')).trim() : null,
    restriction: restrictionText
      ? parseAccountRestriction((await restrictionText.innerText().catch(() => '')).trim())
      : null,
    challengeWidgets: widgets,
  };
}

// 有头模式下等待操作员手动完成验证码。
// 探测结果不再是 challenge 即认为验证已通过（页面回到正常对话即算通过）。
async function waitForChallengeCleared(page, loginState, deadline) {
  while (Date.now() < deadline) {
    await page.waitForTimeout(1_000);
    const state = await probeLoginState(page, loginState).catch(() => null);
    if (state?.status !== 'challenge') return true;
  }
  return false;
}

// 等待回答期间探测验证码与登录态变化。
// - headless：命中拦截立刻抛出对应错误，交由上层快速失败
// - headed：等待操作员在可见窗口里手动把验证码过掉
// 返回 { cleared: true } 表示人工处理完验证码，可以继续等回答；返回 null 表示一切正常。
export async function guardAgainstInterruption(page, loginState, {
  mode = 'headless',
  challengeTimeoutMs = 180_000,
  onChallenge = null,
} = {}) {
  const state = await probeLoginState(page, loginState).catch(() => null);
  if (!state) return null;
  if (state.status === 'restricted') {
    const error = new Error(state.message ?? '账号已被平台限制。');
    error.code = 'account_restricted';
    error.restrictedUntil = state.restrictedUntil ?? null;
    error.restrictionType = state.restrictionType ?? 'restricted';
    throw error;
  }
  if (state.status === 'unauthenticated') {
    const error = new Error('登录状态已失效，请重新登录该账号后再执行监控。');
    error.code = 'login_required';
    error.loginState = state;
    throw error;
  }
  if (state.status !== 'challenge') return null;

  if (mode !== 'headed') {
    const error = new Error('平台要求人工完成验证码或安全校验，本次未继续执行。');
    error.code = 'human_challenge';
    error.loginState = state;
    throw error;
  }

  // 有头模式：等操作员在可见窗口里手动把验证码过掉。
  onChallenge?.({ status: 'challenge', timeoutMs: challengeTimeoutMs, loginState: state });
  const cleared = await waitForChallengeCleared(page, loginState, Date.now() + challengeTimeoutMs);
  if (!cleared) {
    const error = new Error('等待人工完成验证码超时。');
    error.code = 'human_challenge';
    error.loginState = state;
    throw error;
  }
  onChallenge?.({ status: 'cleared', timeoutMs: 0, loginState: null });
  return { cleared: true };
}

export async function waitForAuthenticated(page, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let last = { status: 'unknown', reason: 'not_checked' };
  let consecutiveAuthenticated = 0;
  while (Date.now() < deadline) {
    last = await probeLoginState(page);
    if (last.status === 'restricted') {
      const error = new Error(last.message || '账号已被平台限制。');
      error.code = 'account_restricted';
      error.loginState = last;
      throw error;
    }
    if (last.status === 'authenticated') {
      consecutiveAuthenticated += 1;
      if (consecutiveAuthenticated >= 2) return last;
    } else {
      consecutiveAuthenticated = 0;
    }
    await page.waitForTimeout(500);
  }
      const error = new Error(`登录状态未通过校验：${last.reason}。`);
  error.code = last.status === 'restricted'
    ? 'account_restricted'
    : last.status === 'challenge' ? 'human_challenge' : 'login_required';
  error.loginState = last;
  throw error;
}

export async function waitForChatInput(page, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const loginState = await probeLoginState(page);
    if (loginState.status === 'restricted') {
      const error = new Error(loginState.message || '账号已被平台限制。');
      error.code = 'account_restricted';
      error.loginState = loginState;
      throw error;
    }
    const input = await firstVisibleChatInput(page);
    if (input) return input;
    await page.waitForTimeout(750);
  }
  throw new Error('未找到可用的对话输入框，请检查登录状态或平台验证情况。');
}












export async function detectLoginError(page) {
  const candidate = await firstVisibleMatchingTextAcrossFrames(page, LOGIN_ERROR_PATTERN, { maxTextLength: 240 });
  if (!candidate) return null;
  return (await candidate.innerText().catch(() => '')).trim() || '登录失败';
}

export async function submitQuestion(page, question) {
  const input = await waitForChatInput(page);
  await input.fill(question);
  await page.waitForTimeout(250);
  const sendButton = await firstVisible(page, SEND_BUTTON_SELECTORS, { requireEnabled: true });
  if (sendButton) {
    await sendButton.click();
    return 'send_button';
  }
  await input.press('Enter');
  return 'enter_key';
}

async function readLastResponse(page, selectors) {
  for (const selector of selectors) {
    const candidates = page.locator(selector);
    const count = await candidates.count();
    for (let index = count - 1; index >= 0; index -= 1) {
      const candidate = candidates.nth(index);
      if (!await candidate.isVisible().catch(() => false)) continue;
      const text = (await candidate.innerText()).trim();
      if (text) return text;
    }
  }
  return '';
}

const SHARE_URL_PATTERN = /https?:\/\/[^\s<>"'\x60]+/giu;

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function shareLabelPattern(labels = []) {
  const values = labels.map((label) => escapeRegExp(label)).filter(Boolean);
  return values.length ? new RegExp(values.join('|'), 'u') : null;
}

export function extractShareUrl(value, urlPattern = /^https?:\/\//u) {
  const text = String(value ?? '')
    .trim()
    .replace(/\\u([0-9a-f]{4})/giu, (_match, code) => String.fromCharCode(Number.parseInt(code, 16)))
    .replace(/\\\//gu, '/');
  if (!text) return null;
  const matches = text.match(SHARE_URL_PATTERN) ?? [];
  for (const raw of matches) {
    const candidate = raw.replace(/[)\]}>\uFF0C\u3002\uFF1B\u3001\uFF01\uFF1F!?.,;:]+$/gu, '');
    let parsed;
    try {
      parsed = new URL(candidate);
    } catch {
      continue;
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) continue;
    if (urlPattern instanceof RegExp && !urlPattern.test(candidate)) continue;
    return candidate;
  }
  return null;
}

async function readClipboardText(page) {
  return page.evaluate(async () => {
    try {
      return await navigator.clipboard.readText();
    } catch {
      return '';
    }
  }).catch(() => '');
}

function watchShareResponses(page, urlPattern) {
  const urls = [];
  const seen = new Set();
  let stopped = false;
  const onResponse = (response) => {
    if (stopped || !response.ok()) return;
    const contentType = String(response.headers()['content-type'] ?? '');
    if (!/json|text/iu.test(contentType)) return;
    void response.text().then((text) => {
      if (stopped) return;
      const url = extractShareUrl(text, urlPattern);
      if (!url || seen.has(url)) return;
      seen.add(url);
      urls.push(url);
    }).catch(() => undefined);
  };
  page.on('response', onResponse);
  return {
    url() {
      return urls.at(-1) ?? null;
    },
    stop() {
      stopped = true;
      page.off('response', onResponse);
    },
  };
}

async function grantShareClipboardPermission(page) {
  const context = page.context?.();
  if (!context?.grantPermissions) return;
  const permissions = ['clipboard-read', 'clipboard-write'];
  const origin = (() => {
    try {
      return new URL(page.url()).origin;
    } catch {
      return null;
    }
  })();
  try {
    await context.grantPermissions(permissions, origin ? { origin } : undefined);
  } catch {
    await context.grantPermissions(permissions).catch(() => undefined);
  }
}

async function hoverShareContext(page, selectors = []) {
  for (const selector of selectors) {
    const candidate = await firstVisibleAcrossFrames(page, [selector]);
    if (!candidate) continue;
    await candidate.hover({ timeout: 3_000 }).catch(() => undefined);
    await page.waitForTimeout(400);
    return selector;
  }
  return null;
}

async function clickShareControl(page, selectors = [], labels = [], timeoutMs = 8_000) {
  const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
  const labelPattern = shareLabelPattern(labels);
  let lastError = null;
  do {
    const selectorControl = await firstVisibleAcrossFrames(page, selectors);
    if (selectorControl) {
      try {
        await selectorControl.click({ timeout: 3_000 });
        return { clicked: true, method: 'selector' };
      } catch (error) {
        lastError = error;
      }
    }
    if (labelPattern) {
      const labelControl = await firstVisibleMatchingTextAcrossFrames(page, labelPattern, { maxTextLength: 120 });
      if (labelControl) {
        try {
          await labelControl.click({ timeout: 3_000 });
          return { clicked: true, method: 'label' };
        } catch (error) {
          lastError = error;
        }
      }
    }
    if (Date.now() >= deadline) break;
    await page.waitForTimeout(250);
  } while (Date.now() <= deadline);
  return { clicked: false, method: null, error: lastError?.message ?? null };
}

async function readSelectionState(control) {
  return control.evaluate((element) => {
    const input = element.matches('input[type="checkbox"]')
      ? element
      : element.querySelector('input[type="checkbox"]');
    if (input) return { known: true, checked: Boolean(input.checked) };
    const ariaChecked = element.getAttribute('aria-checked');
    if (ariaChecked != null) return { known: true, checked: ariaChecked === 'true' };
    const state = element.getAttribute('data-state');
    if (state != null) return { known: true, checked: ['checked', 'on'].includes(state) };
    const className = typeof element.className === 'string' ? element.className : '';
    if (/(?:^|[-_\s])(?:checked|selected)(?:$|[-_\s])/iu.test(className)) {
      return { known: true, checked: true };
    }
    if (element.querySelector('[data-icon-type*="checkboxChecked"], [class*="checkbox-checked"], [class*="checkboxChecked"]')) {
      return { known: true, checked: true };
    }
    return { known: false, checked: null };
  }).catch(() => ({ known: false, checked: null }));
}

async function ensureShareSelection(page, flow = {}) {
  const selectors = flow.selectAllSelectors ?? [];
  const labels = flow.selectAllLabels ?? [];
  let control = await firstVisibleAcrossFrames(page, selectors);
  if (!control) {
    const pattern = shareLabelPattern(labels);
    if (pattern) control = await firstVisibleMatchingTextAcrossFrames(page, pattern, { maxTextLength: 80 });
  }
  if (!control) return { found: false, clicked: false };
  const state = await readSelectionState(control);
  if (state.known && state.checked === true) return { found: true, clicked: false, checked: true };
  if (state.known && state.checked === false) {
    try {
      await control.click({ timeout: 3_000 });
      await page.waitForTimeout(300);
      return { found: true, clicked: true, checked: true };
    } catch {
      return { found: true, clicked: false, checked: false };
    }
  }
  try {
    await control.click({ timeout: 3_000 });
    await page.waitForTimeout(300);
    const after = await readSelectionState(control);
    return { found: true, clicked: true, checked: after.known ? after.checked : null };
  } catch {
    return { found: true, clicked: false, checked: null };
  }
}

async function readShareUrlFromPage(page, selectors = [], urlPattern = /^https?:\/\//u) {
  const query = selectors.length
    ? selectors.join(', ')
    : 'input[readonly], textarea, a[href^="http"]';
  const values = [];
  for (const root of pageRoots(page)) {
    const candidates = root.locator(query);
    const count = await candidates.count().catch(() => 0);
    for (let index = count - 1; index >= 0 && values.length < 50; index -= 1) {
      const candidate = candidates.nth(index);
      if (!await candidate.isVisible().catch(() => false)) continue;
      const inputValue = await candidate.inputValue().catch(() => null);
      const textValue = await candidate.textContent().catch(() => null);
      const href = await candidate.getAttribute('href').catch(() => null);
      for (const value of [inputValue, textValue, href]) {
        const url = extractShareUrl(value, urlPattern);
        if (url) values.push(url);
      }
    }
  }
  return values[0] ?? null;
}

async function waitForShareUrl(page, previousValue, urlPattern, timeoutMs = 8_000, responseCapture = null, linkSelectors = []) {
  const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
  do {
    const capturedUrl = responseCapture?.url?.() ?? null;
    if (capturedUrl) return { url: capturedUrl, value: null, method: 'network' };
    const value = await readClipboardText(page);
    const clipboardUrl = extractShareUrl(value, urlPattern);
    if (clipboardUrl && (value !== previousValue || !previousValue)) {
      return { url: clipboardUrl, value, method: 'clipboard' };
    }
    const pageUrl = await readShareUrlFromPage(page, linkSelectors, urlPattern);
    if (pageUrl) return { url: pageUrl, value, method: 'link_input' };
    if (Date.now() >= deadline) break;
    await page.waitForTimeout(300);
  } while (Date.now() <= deadline);
  return { url: null, value: null, method: null };
}

async function closeShareDialog(page, flow = {}) {
  const close = await clickShareControl(page, flow.closeSelectors ?? [], flow.closeLabels ?? [], 1_500);
  if (close.clicked) return { closed: true, method: close.method };
  await page.keyboard.press('Escape').catch(() => undefined);
  await page.waitForTimeout(300);
  return { closed: true, method: 'escape' };
}

function unavailableShare(reason, error = null) {
  return {
    status: 'unavailable',
    url: null,
    method: null,
    capturedAt: new Date().toISOString(),
    dialogOpened: false,
    reason,
    error,
  };
}

function failedShare(reason, error, { dialogOpened = false, method = null } = {}) {
  return {
    status: 'failed',
    url: null,
    method,
    capturedAt: new Date().toISOString(),
    dialogOpened,
    reason,
    error: error?.message ?? String(error ?? reason),
  };
}

async function captureShareLink(page, shareFlow = {}, { onDialogOpen = null } = {}) {
  if (!shareFlow || shareFlow.supported === false) {
    return unavailableShare('share_not_supported');
  }
  await page.bringToFront().catch(() => undefined);
  await hoverShareContext(page, shareFlow.hoverSelectors ?? []);
  const trigger = await clickShareControl(
    page,
    shareFlow.triggerSelectors ?? [],
    shareFlow.triggerLabels ?? [],
    shareFlow.triggerTimeoutMs ?? 12_000,
  );
  if (!trigger.clicked) return unavailableShare('share_trigger_not_found', trigger.error);

  let dialogOpened = false;
  const dialogSelectors = [
    ...(shareFlow.linkSelectors ?? []),
    ...(shareFlow.selectAllSelectors ?? []),
    ...(shareFlow.prepareSelectors ?? []),
    ...(shareFlow.copySelectors ?? []),
    ...(shareFlow.closeSelectors ?? []),
  ];
  const dialogLabels = [
    ...(shareFlow.selectAllLabels ?? []),
    ...(shareFlow.prepareLabels ?? []),
    ...(shareFlow.copyLabels ?? []),
    ...(shareFlow.closeLabels ?? []),
  ];
  const dialogPattern = shareLabelPattern(dialogLabels);
  const dialogDeadline = Date.now() + Math.max(0, Number(shareFlow.dialogTimeoutMs ?? 8_000) || 0);
  do {
    if (await firstVisibleAcrossFrames(page, dialogSelectors)) {
      dialogOpened = true;
      break;
    }
    if (dialogPattern && await firstVisibleMatchingTextAcrossFrames(page, dialogPattern, { maxTextLength: 120 })) {
      dialogOpened = true;
      break;
    }
    if (Date.now() >= dialogDeadline) break;
    await page.waitForTimeout(250);
  } while (Date.now() <= dialogDeadline);

  if (!dialogOpened) {
    return failedShare('share_dialog_not_found', 'The share dialog did not expose a known control.', { dialogOpened: false });
  }

  await grantShareClipboardPermission(page);
  const selection = await ensureShareSelection(page, shareFlow);
  let prepareResult = { clicked: false, method: null, error: null };
  if ((shareFlow.prepareSelectors ?? []).length || (shareFlow.prepareLabels ?? []).length) {
    prepareResult = await clickShareControl(
      page,
      shareFlow.prepareSelectors ?? [],
      shareFlow.prepareLabels ?? [],
      shareFlow.prepareTimeoutMs ?? 12_000,
    );
    if (!prepareResult.clicked) {
      const result = failedShare(
        'share_prepare_control_not_found',
        prepareResult.error ?? 'No share preparation control was found.',
        { dialogOpened: true, method: prepareResult.method },
      );
      result.selection = selection;
      if (typeof onDialogOpen === 'function') await onDialogOpen().catch(() => undefined);
      await closeShareDialog(page, shareFlow);
      return result;
    }
    await page.waitForTimeout(300);
  }
  const urlPattern = shareFlow.urlPattern ?? /^https?:\/\//u;
  let shareUrl = await readShareUrlFromPage(page, shareFlow.linkSelectors ?? [], urlPattern);
  let method = shareUrl ? 'link_input' : null;
  let copyResult = { clicked: false, method: null, error: null };
  if (!shareUrl) {
    const clipboardBefore = await readClipboardText(page);
    const responseCapture = watchShareResponses(page, urlPattern);
    try {
      copyResult = await clickShareControl(
        page,
        shareFlow.copySelectors ?? [],
        shareFlow.copyLabels ?? [],
        shareFlow.copyTimeoutMs ?? 12_000,
      );
      if (!copyResult.clicked) {
        const result = failedShare('share_copy_control_not_found', copyResult.error ?? 'No copy/generate control was found.', { dialogOpened: true, method: copyResult.method });
        result.selection = selection;
        if (typeof onDialogOpen === 'function') await onDialogOpen().catch(() => undefined);
        await closeShareDialog(page, shareFlow);
        return result;
      }
      const captured = await waitForShareUrl(
        page,
        clipboardBefore,
        urlPattern,
        shareFlow.clipboardTimeoutMs ?? 8_000,
        responseCapture,
        shareFlow.linkSelectors ?? [],
      );
      shareUrl = captured.url;
      method = captured.method;
    } finally {
      responseCapture.stop();
    }
  }

  if (typeof onDialogOpen === 'function') await onDialogOpen().catch(() => undefined);
  await closeShareDialog(page, shareFlow);

  if (!shareUrl) {
    const result = failedShare('share_url_not_found', 'The share action completed but no URL was exposed.', { dialogOpened: true, method });
    result.selection = selection;
    result.prepareMethod = prepareResult.method;
    result.copyMethod = copyResult.method;
    return result;
  }

  return {
    status: 'captured',
    url: shareUrl,
    method: method ?? 'unknown',
    capturedAt: new Date().toISOString(),
    dialogOpened: true,
    selection,
    prepareMethod: prepareResult.method,
    copyMethod: copyResult.method,
    error: null,
  };
}

export function createChatPlatformAdapter({
  id,
  label,
  entryUrl,
  responseSelectors,
  defaultMode = 'headless',
  minimumAnswerLength = 24,
  answerCompleteSelectors = [],
  minimumAnswerTimeoutMs = 0,
  loginState = {},
  shareFlow = {},
}) {
  return Object.freeze({
    id,
    label,
    entryUrl,
    defaultMode,
    loginState,
    inspectLoginState(page) {
      return probeLoginState(page, loginState);
    },
    detectLoginError(page) {
      return detectLoginError(page);
    },
    async submitQuestion(page, question) {
      return submitQuestion(page, question);
    },
    captureShareLink(page, options = {}) {
      return captureShareLink(page, shareFlow, options);
    },
    async waitForAnswer(page, {
      timeoutMs = 300_000,
      stableForMs = 4_000,
      minimumLength = minimumAnswerLength,
      mode = 'headless',
      challengeTimeoutMs = 180_000,
      onChallenge = null,
    } = {}) {
      const effectiveTimeoutMs = Math.max(timeoutMs, minimumAnswerTimeoutMs);
      let deadline = Date.now() + effectiveTimeoutMs;
      let previous = '';
      let stableSince = null;
      let lastComplete = answerCompleteSelectors.length === 0;
      let lastProbeAt = 0;
      while (Date.now() < deadline) {
        const content = await readLastResponse(page, responseSelectors);
        lastComplete = answerCompleteSelectors.length === 0
          || Boolean(await firstVisibleAcrossFrames(page, answerCompleteSelectors));
        if (content.length >= minimumLength && lastComplete) {
          if (content === previous) {
            stableSince ??= Date.now();
            if (Date.now() - stableSince >= stableForMs) return content;
          } else {
            previous = content;
            stableSince = null;
          }
        }

        // 验证码与风控提示通常在提交问题之后才出现，
        // 这里必须持续探测，否则只能白等到超时才发现出了问题。
        if (Date.now() - lastProbeAt >= CHALLENGE_PROBE_INTERVAL_MS) {
          lastProbeAt = Date.now();
          const interruption = await guardAgainstInterruption(page, loginState, { mode, challengeTimeoutMs, onChallenge });
          if (interruption?.cleared) {
            // 人工处理的时间不计入回答超时，给回答重新留出完整的时间窗。
            deadline = Date.now() + effectiveTimeoutMs;
          }
        }
        await page.waitForTimeout(1_000);
      }
      if (answerCompleteSelectors.length && !lastComplete) {
        const error = new Error('等待超时：平台尚未标记回答完成。');
        error.code = 'answer_incomplete';
        throw error;
      }
      if (previous) return previous;
      throw new Error('等待平台回答超时。');
    },
  });
}
