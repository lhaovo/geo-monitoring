import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { resolveBrowserExecutable } from '../browser.js';
import { captureCitations } from '../citations.js';
import { createPlatformRunArtifacts, relativeArtifactPath } from './artifacts.js';

export const SEARCH_PROMPT_SUFFIX = '请先搜索相关信息，参考可靠的公开来源后再回答。';

export function buildSubmittedQuestion(question, appendSearchPrompt = false) {
  const text = String(question ?? '').trim();
  return appendSearchPrompt ? `${text}\n\n${SEARCH_PROMPT_SUFFIX}` : text;
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  const error = new Error('监控任务已取消。');
  error.name = 'CancellationError';
  throw error;
}

async function capturePage(page, directory, name) {
  const screenshotPath = path.join(directory, `${name}.png`);
  const htmlPath = path.join(directory, `${name}.html`);
  // 截图与页面内容并行采集。浏览器上下文可能在采集过程中被关闭（例如取消任务时），
  // 此时两个 Promise 都会 reject。必须先挂好兜底处理器再等待结果，
  // 否则先失败的那个会让另一个变成「无人接管的 rejection」，
  // Node 会以未捕获异常直接退出，整个监控服务随之崩溃。
  const screenshot = page.screenshot({ path: screenshotPath, fullPage: true });
  const html = page.content().then((content) => writeFile(htmlPath, content, 'utf8'));
  const settled = await Promise.allSettled([screenshot, html]);
  const failure = settled.find((result) => result.status === 'rejected');
  if (failure) throw failure.reason;
  return { screenshotPath, htmlPath };
}

// 分享链接是 best-effort 采集：平台可能没有分享入口、被静默、或交互失败，
// 任何一种情况都不应让整次监测失败。
export async function captureShareLink(page, adapter, { timeoutMs = 30_000 } = {}) {
  if (typeof adapter?.captureShareLink !== 'function') {
    return { status: 'unavailable', url: null, reason: '平台未提供分享链接能力。' };
  }
  try {
    const result = await adapter.captureShareLink(page, { timeoutMs });
    if (!result?.url) {
      return { status: 'unavailable', url: null, reason: result?.reason ?? '平台未返回可用的分享链接。' };
    }
    return { status: 'captured', url: result.url, reason: null };
  } catch (error) {
    return { status: 'failed', url: null, reason: error?.message ?? '分享链接采集失败。' };
  }
}

export async function executePlatformRun({ platformRun, adapter, paths, mode, appendSearchPrompt = false, emit, signal }) {
  throwIfAborted(signal);
  try {
    return await runPlatformRun({ platformRun, adapter, paths, mode, appendSearchPrompt, emit, signal });
  } catch (error) {
    // 验证码只能在有头模式下人工处理：headless 撞到验证码时，
    // 关掉无头浏览器、用同一个登录态改用有头模式重跑这条任务。
    if (error?.code !== 'human_challenge' || mode === 'headed') throw error;
    emit(`${adapter.label} 触发验证码，改用有头模式重新打开浏览器，请在窗口中手动完成验证。`);
    throwIfAborted(signal);
    let result;
    try {
      result = await runPlatformRun({ platformRun, adapter, paths, mode: 'headed', appendSearchPrompt, emit, signal, attemptLabel: '-retry' });
    } catch (retryError) {
      // 保留第一次尝试的证据，两次尝试的产物合并落库。
      retryError.artifacts = [...(error.artifacts ?? []), ...(retryError.artifacts ?? [])];
      throw retryError;
    }
    // 有头模式跑成功时，第一次（无头）尝试的证据同样要保留下来。
    result.artifacts = [...(error.artifacts ?? []), ...(result.artifacts ?? [])];
    return result;
  }
}

// 真正跑一遍平台任务（无头或有头由 mode 决定）。
async function runPlatformRun({ platformRun, adapter, paths, mode, appendSearchPrompt, emit, signal, attemptLabel = '' }) {
  throwIfAborted(signal);
  const artifacts = await createPlatformRunArtifacts(paths, platformRun.runId, platformRun.id, adapter.id, platformRun.profileId);
  const browserContext = await chromium.launchPersistentContext(artifacts.profileDirectory, {
    executablePath: resolveBrowserExecutable(),
    headless: mode === 'headless',
    viewport: { width: 1440, height: 960 },
  });
  let abortClosePromise = null;
  const closeOnAbort = () => {
    abortClosePromise ??= browserContext.close().catch(() => undefined);
  };
  signal?.addEventListener('abort', closeOnAbort, { once: true });
  const page = browserContext.pages()[0] ?? await browserContext.newPage();
  const savedArtifacts = [];
  const saveSnapshot = async (name) => {
    // 重试（有头模式）使用独立文件名，避免覆盖第一次尝试的现场证据。
    const captured = await capturePage(page, artifacts.directory, `${name}${attemptLabel}`);
    savedArtifacts.push(
      { kind: 'screenshot', relativePath: relativeArtifactPath(paths, captured.screenshotPath) },
      { kind: 'html', relativePath: relativeArtifactPath(paths, captured.htmlPath) },
    );
  };

  try {
    throwIfAborted(signal);
    emit(`打开 ${adapter.label} 页面。`);
    await page.goto(adapter.entryUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    throwIfAborted(signal);
    await saveSnapshot('01-opened');

    // 登录态检查：受限、登录失效或遇到人工校验时直接终止，
    // 避免继续消耗问题配额或产出空回答。
    if (typeof adapter.inspectLoginState === 'function') {
      const loginState = await adapter.inspectLoginState(page).catch(() => null);
      if (loginState?.status === 'restricted') {
        const error = new Error(loginState.message ?? '账号已被平台限制。');
        error.code = 'account_restricted';
        error.restrictedUntil = loginState.restrictedUntil ?? null;
        error.restrictionType = loginState.restrictionType ?? 'restricted';
        throw error;
      }
      if (loginState?.status === 'unauthenticated') {
        const error = new Error('登录状态已失效，请重新登录该账号后再执行监控。');
        error.code = 'login_required';
        error.loginState = loginState;
        throw error;
      }
      if (loginState?.status === 'challenge') {
        const error = new Error('平台要求人工完成验证码或安全校验，本次未继续执行。');
        error.code = 'human_challenge';
        error.loginState = loginState;
        throw error;
      }
    }

    const submittedQuestion = buildSubmittedQuestion(platformRun.prompt.text, appendSearchPrompt);
    const submissionMethod = await adapter.submitQuestion(page, submittedQuestion);
    throwIfAborted(signal);
    emit(`问题已提交（${submissionMethod}），等待回答。`);
    await saveSnapshot('02-submitted');
    const content = await adapter.waitForAnswer(page, {
      mode,
      loginState: adapter.loginState ?? {},
      onChallenge: (info) => {
        if (info?.status === 'challenge') {
          emit(`${adapter.label} 触发验证码，请在浏览器窗口中手动完成验证（最多等待 ${Math.round((info.timeoutMs ?? 0) / 1000)} 秒）。`);
        } else {
          emit(`${adapter.label} 验证码已通过，继续等待回答。`);
        }
      },
    });
    throwIfAborted(signal);
    await saveSnapshot('03-answer');
    const citationResult = await captureCitations(page, { platformId: adapter.id, runDirectory: artifacts.directory });
    throwIfAborted(signal);
    savedArtifacts.push(
      { kind: 'citations', relativePath: relativeArtifactPath(paths, citationResult.citationPath) },
      { kind: 'screenshot', relativePath: relativeArtifactPath(paths, path.join(artifacts.directory, citationResult.screenshot)) },
    );

    // 分享链接采集为附加信息，失败不影响回答结果。
    const share = await captureShareLink(page, adapter);
    const sharePath = path.join(artifacts.directory, 'share.json');
    await writeFile(sharePath, `${JSON.stringify({
      capturedAt: new Date().toISOString(),
      status: share.status,
      url: share.url,
      reason: share.reason,
    }, null, 2)}\n`, 'utf8');
    savedArtifacts.push({ kind: 'share', relativePath: relativeArtifactPath(paths, sharePath) });

    return {
      content,
      responseUrl: page.url(),
      sourcePanelOpened: citationResult.sourcePanelOpened,
      platformReportedCount: citationResult.platformReportedCount,
      displayedSourceLinkCount: citationResult.displayedSourceLinkCount,
      capturedCardCount: citationResult.capturedCardCount,
      capturedCardIndexes: citationResult.capturedCardIndexes,
      missingSourceIndexes: citationResult.missingSourceIndexes,
      shareStatus: share.status,
      shareUrl: share.url,
      citations: JSON.parse(await readFile(citationResult.citationPath, 'utf8')).citations,
      artifacts: savedArtifacts,
    };
  } catch (error) {
    try {
      await saveSnapshot('error');
    } catch {
      // Keep the original error if evidence capture also fails.
    }
    error.artifacts = savedArtifacts;
    throw error;
  } finally {
    signal?.removeEventListener('abort', closeOnAbort);
    if (abortClosePromise) await abortClosePromise;
    else await browserContext.close();
  }
}
