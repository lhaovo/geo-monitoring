import { createChatPlatformAdapter } from './base.mjs';

const STOP_GENERATION_SELECTOR = '.chat-editor .send-button-container.stop';
const ASSISTANT_SEGMENT_SELECTOR = '.segment.segment-assistant';

async function isVisible(locator) {
  return locator.count().then((count) => count > 0 && locator.last().isVisible()).catch(() => false);
}

async function readLatestAnswer(page) {
  const responses = page.locator(ASSISTANT_SEGMENT_SELECTOR);
  const responseCount = await responses.count();
  if (!responseCount) return { content: '', response: null, responseCount };

  const response = responses.nth(responseCount - 1);
  if (!await response.isVisible().catch(() => false)) return { content: '', response: null, responseCount };

  const markdowns = response.locator('.markdown-container .markdown, .markdown');
  const markdownCount = await markdowns.count();
  for (let index = markdownCount - 1; index >= 0; index -= 1) {
    const markdown = markdowns.nth(index);
    if (await markdown.isVisible().catch(() => false)) {
      const content = (await markdown.innerText()).trim();
      if (content) return { content, response, responseCount };
    }
  }
  return { content: (await response.innerText()).trim(), response, responseCount };
}

export async function waitForKimiAnswer(page, { timeoutMs = 300_000, stableForMs = 4_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  const initial = await readLatestAnswer(page);
  let sawStopGeneration = false;
  let observedSubmittedResponse = false;
  let previous = '';
  let stableSince = null;

  while (Date.now() < deadline) {
    const isGenerating = await isVisible(page.locator(STOP_GENERATION_SELECTOR));
    sawStopGeneration ||= isGenerating;
    const { content, response, responseCount } = await readLatestAnswer(page);
    observedSubmittedResponse ||= responseCount > initial.responseCount || (Boolean(content) && content !== initial.content);
    const finalActionsVisible = response ? await isVisible(response.locator('.segment-assistant-actions')) : false;
    const completionConfirmed = sawStopGeneration || (observedSubmittedResponse && finalActionsVisible);

    if (!content || isGenerating || !completionConfirmed) {
      previous = '';
      stableSince = null;
      await page.waitForTimeout(750);
      continue;
    }

    if (content !== previous) {
      previous = content;
      stableSince = null;
    } else {
      stableSince ??= Date.now();
      if (Date.now() - stableSince >= stableForMs) return content;
    }
    await page.waitForTimeout(750);
  }

  if (previous) throw new Error('Kimi answer did not confirm completion within five minutes. Evidence was retained.');
  throw new Error('Kimi did not produce an answer. Check login, verification, or the page structure.');
}

const baseAdapter = createChatPlatformAdapter({
  id: 'kimi',
  label: 'Kimi',
  loginMethod: 'sms_code',
  defaultMode: 'headless',
  loginTriggerLabels: ['登录', '立即登录'],
  loginMethodLabels: ['验证码登录', '手机号登录', '短信登录'],
  loginFlow: {
    loginTriggerSelectors: ['button:has-text("登录")', '[role=button]:has-text("登录")'],
    loginMethodSelectors: ['button:has-text("验证码登录")', 'button:has-text("手机号登录")'],
    phoneInputSelectors: ['.phone-form__phone-input', 'input[placeholder="手机号"]', 'input[placeholder*="手机号"]'],
    codeInputSelectors: ['.phone-form__code-input', 'input[placeholder="验证码"]', 'input[placeholder*="验证码"]'],
    agreementSelectors: ['input[type=checkbox]'],
    requestSmsSelectors: ['button.phone-form__send'],
    requestSmsLabels: ['发送验证码', '获取验证码', '重新获取'],
    submitSelectors: ['button.km-button.km-button-primary.km-button-large.km-button-block'],
    submitLabels: ['登录', '验证'],
  },
  shareFlow: {
    hoverSelectors: ['.segment-assistant-actions', '.segment-assistant'],
    triggerSelectors: ['button[aria-label*="分享"]', '[role=button][aria-label*="分享"]'],
    triggerLabels: ['分享'],
    selectAllSelectors: ['.select-all', 'label:has-text("全选")'],
    selectAllLabels: ['全选'],
    copySelectors: ['.simple-button:has-text("复制链接")', 'button:has-text("复制链接")'],
    copyLabels: ['复制链接', '生成链接'],
    linkSelectors: ['a[href*="/share/"]', 'input[readonly]', 'textarea[readonly]'],
    closeSelectors: ['.simple-button:has-text("取消")', 'button:has-text("取消")'],
    closeLabels: ['取消'],
    urlPattern: /https?:\/\/(?:www\.)?kimi\.com\/share\//u,
  },
  entryUrl: 'https://www.kimi.com/',
  responseSelectors: ['[class*="markdown"]', '[data-message-id]', '[class*="message-content"]'],
});

export const kimiAdapter = Object.freeze({ ...baseAdapter, waitForAnswer: waitForKimiAnswer });
