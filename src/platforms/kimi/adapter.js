import { createChatPlatformAdapter } from '../base.js';

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
    const finalActionsVisible = response
      ? await isVisible(response.locator('.segment-assistant-actions'))
      : false;

    // Kimi can render an earlier markdown block while the final answer is
    // still streaming. The stop button is the reliable completion signal;
    // completed answers also expose their action row.
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

  if (previous) {
    throw new Error('Kimi 回答在 5 分钟内未确认结束，已保留页面证据供复核。');
  }
  throw new Error('Kimi 未生成可采集的回答；请检查登录状态、验证码或平台页面。');
}

const baseKimiAdapter = createChatPlatformAdapter({
  id: 'kimi',
  label: 'Kimi',
  entryUrl: 'https://www.kimi.com/',
  defaultMode: 'headless',
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
  responseSelectors: ['[class*="markdown"]', '[data-message-id]', '[class*="message-content"]'],
});

// Kimi exposes a visible stop-generation control. Its generic markdown
// blocks may stabilize before streaming has actually finished, so override
// the shared response waiter with Kimi's completion state.
export const kimiAdapter = Object.freeze({ ...baseKimiAdapter, waitForAnswer: waitForKimiAnswer });
