const INPUT_SELECTORS = [
  'textarea:not([disabled])',
  '[contenteditable="true"][role="textbox"]',
  '[contenteditable="true"]',
  'input[type="text"]:not([disabled])',
];

const SEND_BUTTON_SELECTORS = [
  'button[aria-label*="发送"]',
  'button[aria-label*="Send"]',
  'button[title*="发送"]',
  'button[title*="Send"]',
  'button[class*="send"]',
  'button[class*="submit"]',
];

async function firstVisible(page, selectors, { minimumWidth = 0, minimumHeight = 0 } = {}) {
  for (const selector of selectors) {
    const candidates = page.locator(selector);
    const count = await candidates.count();
    for (let index = count - 1; index >= 0; index -= 1) {
      const candidate = candidates.nth(index);
      if (await candidate.isVisible()) {
        const box = await candidate.boundingBox();
        if (box && box.width >= minimumWidth && box.height >= minimumHeight) return candidate;
      }
    }
  }
  return null;
}

export async function waitForChatInput(page, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const input = await firstVisible(page, INPUT_SELECTORS, { minimumWidth: 80, minimumHeight: 20 });
    if (input) return input;
    await page.waitForTimeout(750);
  }
  throw new Error('未发现可用的聊天输入框；请检查该平台是否仍需要登录或验证码。');
}

export async function submitQuestion(page, question) {
  const input = await waitForChatInput(page);
  await input.fill(question);
  await page.waitForTimeout(250);
  const sendButton = await firstVisible(page, SEND_BUTTON_SELECTORS);
  if (sendButton && await sendButton.isEnabled()) {
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
      if (await candidate.isVisible()) {
        const text = (await candidate.innerText()).trim();
        if (text) return text;
      }
    }
  }
  return '';
}

export function createChatPlatformAdapter({ id, label, entryUrl, responseSelectors }) {
  return Object.freeze({
    id,
    label,
    entryUrl,
    async submitQuestion(page, question) {
      return submitQuestion(page, question);
    },
    async waitForAnswer(page, { timeoutMs = 300_000, stableForMs = 4_000 } = {}) {
      const deadline = Date.now() + timeoutMs;
      let previous = '';
      let stableSince = null;
      while (Date.now() < deadline) {
        const content = await readLastResponse(page, responseSelectors);
        if (content.length >= 24) {
          if (content === previous) {
            stableSince ??= Date.now();
            if (Date.now() - stableSince >= stableForMs) return content;
          } else {
            previous = content;
            stableSince = null;
          }
        }
        await page.waitForTimeout(1_000);
      }
      if (previous) return previous;
      throw new Error('等待平台回答超时。');
    },
  });
}
