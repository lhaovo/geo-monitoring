import path from 'node:path';
import { chromium } from 'playwright';
import { resolveBrowserExecutable } from './browser.js';
import {
  appendRunLog,
  createRunArtifacts,
  writeRunRecord,
} from './run-artifacts.js';

const LOGIN_PATH_FRAGMENT = /(?:^|\/)(?:login|signin|sign-in|sign_in|passport|auth|account)(?:\/|$)/i;

function now() {
  return new Date().toISOString();
}

export function describeAuthentication(url) {
  try {
    return LOGIN_PATH_FRAGMENT.test(new URL(url).pathname)
      ? 'login_flow_detected'
      : 'manual_review_required';
  } catch {
    return 'manual_review_required';
  }
}

export async function launchPlatform(platform, { dataDirectory = path.resolve('data'), profileId = '' } = {}) {
  const artifacts = await createRunArtifacts(dataDirectory, platform.id, new Date(), profileId);
  const record = {
    platform: platform.id,
    platformLabel: platform.label,
    entryUrl: platform.entryUrl,
    startedAt: now(),
    endedAt: null,
    status: 'starting',
    authentication: 'manual_review_required',
    currentUrl: null,
    title: null,
    screenshots: [],
    events: [],
  };

  const persist = async () => writeRunRecord(artifacts.recordPath, record);
  const log = async (message) => {
    record.events.push({ at: now(), message });
    await appendRunLog(artifacts.logPath, message);
    await persist();
  };

  const takeSnapshot = async (page, reason) => {
    const index = String(++screenshotSequence).padStart(2, '0');
    const filename = `${index}-${reason}.png`;
    const screenshotPath = path.join(artifacts.runDirectory, filename);

    try {
      await page.screenshot({ path: screenshotPath });
      record.screenshots.push(filename);
      record.currentUrl = page.url();
      record.title = await page.title();
      record.authentication = describeAuthentication(record.currentUrl);
      await log(`Saved screenshot: ${filename}`);
    } catch (error) {
      await log(`Could not save screenshot (${reason}): ${error.message}`);
    }
  };

  let screenshotSequence = 0;

  await persist();
  await log(`Starting visible browser for ${platform.label}.`);

  const executablePath = resolveBrowserExecutable();
  await log(`Using local browser executable: ${executablePath}`);
  const context = await chromium.launchPersistentContext(artifacts.profileDirectory, {
    executablePath,
    headless: false,
    viewport: { width: 1440, height: 960 },
  });
  const page = context.pages()[0] ?? await context.newPage();

  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) {
      record.currentUrl = frame.url();
      record.authentication = describeAuthentication(frame.url());
      void log(`Main frame navigated to: ${frame.url()}`);
      setTimeout(() => {
        void takeSnapshot(page, 'navigation');
      }, 750);
    }
  });

  page.on('pageerror', (error) => {
    void log(`Page error: ${error.message}`);
  });

  try {
    await page.goto(platform.entryUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    record.status = 'page_opened';
    await takeSnapshot(page, 'opened');
  } catch (error) {
    record.status = 'navigation_failed';
    await log(`Could not open entry URL: ${error.message}`);
    await takeSnapshot(page, 'navigation-failed');
  }

  await persist();
  console.log(`\n${platform.label} 已在可见浏览器中打开。`);
  console.log('请在浏览器中手动完成登录、扫码或验证码。');
  console.log('登录完成后，在此终端按 Enter 保存一张当前页面截图；关闭浏览器或按 Ctrl+C 结束。\n');

  const snapshotOnEnter = async () => {
    await takeSnapshot(page, 'operator-snapshot');
    console.log(`已保存截图至 ${artifacts.runDirectory}`);
  };
  process.stdin.resume();
  process.stdin.on('data', () => {
    void snapshotOnEnter();
  });

  // A pending Promise alone does not keep Node alive when this is run from a
  // non-interactive terminal. Keep the visible browser session alive until it
  // is explicitly closed by the operator or interrupted.
  const keepAlive = setInterval(() => undefined, 1_000);
  let closed = false;
  const close = async (reason) => {
    if (closed) return;
    closed = true;
    clearInterval(keepAlive);
    record.status = 'closed';
    record.endedAt = now();
    await log(`Browser session closed: ${reason}`);
    await persist();
    process.stdin.pause();
    if (context.browser()?.isConnected()) {
      await context.close();
    }
  };

  const onSignal = () => {
    void close('interrupted');
  };
  process.once('SIGINT', onSignal);

  await new Promise((resolve) => context.once('close', resolve));
  if (!closed) {
    closed = true;
    clearInterval(keepAlive);
    record.status = 'closed';
    record.endedAt = now();
    await log('Browser window was closed by the operator.');
    await persist();
    process.stdin.pause();
  }
}
