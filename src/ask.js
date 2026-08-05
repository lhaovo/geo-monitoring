import path from 'node:path';
import { chromium } from 'playwright';
import { resolveBrowserExecutable } from './browser.js';
import { captureCitations } from './citations.js';
import { createRunArtifacts, writeRunRecord } from './run-artifacts.js';
import { getPlatform } from './platforms.js';

const PLATFORM_IDS = ['deepseek', 'doubao', 'kimi', 'qwen', 'yuanbao'];
const INPUT_SELECTORS = [
  'textarea:not([disabled])',
  '[contenteditable="true"][role="textbox"]',
  '[contenteditable="true"]',
  'input[type="text"]:not([disabled])',
];
const SEND_BUTTON_SELECTORS = [
  'button[class*="bg-dbx-text-highlight"]',
  'button[aria-label*="发送"]',
  'button[aria-label*="Send"]',
  'button[title*="发送"]',
  'button[title*="Send"]',
];

function timestamp() {
  return new Date().toISOString();
}

async function firstVisible(page, selectors, { minimumWidth = 0, minimumHeight = 0 } = {}) {
  for (const selector of selectors) {
    const candidates = page.locator(selector);
    const count = await candidates.count();

    for (let index = 0; index < count; index += 1) {
      const candidate = candidates.nth(index);
      if (await candidate.isVisible()) {
        const box = await candidate.boundingBox();
        if (box && box.width > minimumWidth && box.height > minimumHeight) return candidate;
      }
    }
  }

  return null;
}

async function waitForChatInput(page, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const input = await firstVisible(page, INPUT_SELECTORS, { minimumWidth: 80, minimumHeight: 20 });
    if (input) return input;
    await page.waitForTimeout(750);
  }

  throw new Error('No visible chat input was found. Check whether the page still needs a manual login.');
}

async function submitQuestion(page, question) {
  const input = await waitForChatInput(page);
  await input.fill(question);
  await page.waitForTimeout(300);

  const sendButton = await firstVisible(page, SEND_BUTTON_SELECTORS);
  if (sendButton && await sendButton.isEnabled()) {
    await sendButton.click();
    return 'send_button';
  }

  await input.press('Enter');
  return 'enter_key';
}

async function launchAndAsk(platformId, question, dataDirectory) {
  const platform = getPlatform(platformId);
  const artifacts = await createRunArtifacts(dataDirectory, platform.id);
  const record = {
    platform: platform.id,
    platformLabel: platform.label,
    question,
    entryUrl: platform.entryUrl,
    startedAt: timestamp(),
    submittedAt: null,
    endedAt: null,
    status: 'starting',
    submissionMethod: null,
    currentUrl: null,
    screenshots: [],
    citations: null,
    error: null,
  };

  const persist = () => writeRunRecord(artifacts.recordPath, record);
  const context = await chromium.launchPersistentContext(artifacts.profileDirectory, {
    executablePath: resolveBrowserExecutable(),
    headless: false,
    viewport: { width: 1440, height: 960 },
  });
  const page = context.pages()[0] ?? await context.newPage();

  const screenshot = async (name) => {
    const filename = `${name}.png`;
    await page.screenshot({ path: path.join(artifacts.runDirectory, filename) });
    record.screenshots.push(filename);
    record.currentUrl = page.url();
    await persist();
  };

  try {
    await page.goto(platform.entryUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    record.status = 'page_opened';
    record.currentUrl = page.url();
    await screenshot('01-opened');
    record.submissionMethod = await submitQuestion(page, question);
    record.submittedAt = timestamp();
    record.status = 'question_submitted';
    await screenshot('02-submitted');
    await persist();
    console.log(`${platform.label}: question submitted.`);
  } catch (error) {
    record.status = 'submission_failed';
    record.error = error.message;
    record.currentUrl = page.url();
    try {
      await screenshot('error');
    } catch {
      // Preserve the original failure when screenshot capture also fails.
    }
    await persist();
    console.error(`${platform.label}: ${error.message}`);
  }

  const captureResponse = async (label) => {
    if (page.isClosed()) return;
    try {
      await screenshot(label);
      const citations = await captureCitations(page, {
        platformId: platform.id,
        runDirectory: artifacts.runDirectory,
      });
      record.citations = citations;
      await persist();
    } catch (error) {
      console.error(`${platform.label}: could not save ${label}: ${error.message}`);
    }
  };

  setTimeout(() => void captureResponse('03-response-60s'), 60_000);
  setTimeout(() => void captureResponse('04-response-120s'), 120_000);

  context.once('close', () => {
    record.status = 'closed';
    record.endedAt = timestamp();
    void persist();
  });

  return context;
}

const question = process.argv.slice(2).join(' ').trim();
const platformIds = (process.env.GEO_PLATFORMS ?? PLATFORM_IDS.join(','))
  .split(',')
  .map((platformId) => platformId.trim())
  .filter(Boolean);
if (!question) {
  console.error('Usage: npm run ask -- "your question"');
  process.exitCode = 1;
} else {
  const dataDirectory = path.resolve('data');
  const contexts = await Promise.all(
    platformIds.map((platformId) => launchAndAsk(platformId, question, dataDirectory)),
  );

  console.log('All platform windows are open. Response screenshots will be saved after 60 and 120 seconds.');
  const keepAlive = setInterval(() => undefined, 1_000);
  await Promise.all(contexts.map((context) => new Promise((resolve) => context.once('close', resolve))));
  clearInterval(keepAlive);
}
