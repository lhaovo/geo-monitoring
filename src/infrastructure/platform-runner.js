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

async function capturePage(page, directory, name) {
  const screenshotPath = path.join(directory, `${name}.png`);
  const htmlPath = path.join(directory, `${name}.html`);
  await Promise.all([
    page.screenshot({ path: screenshotPath, fullPage: true }),
    writeFile(htmlPath, await page.content(), 'utf8'),
  ]);
  return { screenshotPath, htmlPath };
}

export async function executePlatformRun({ platformRun, adapter, paths, mode, appendSearchPrompt = false, emit }) {
  const artifacts = await createPlatformRunArtifacts(paths, platformRun.runId, platformRun.id, adapter.id);
  const browserContext = await chromium.launchPersistentContext(artifacts.profileDirectory, {
    executablePath: resolveBrowserExecutable(),
    headless: mode === 'headless',
    viewport: { width: 1440, height: 960 },
  });
  const page = browserContext.pages()[0] ?? await browserContext.newPage();
  const savedArtifacts = [];
  const saveSnapshot = async (name) => {
    const captured = await capturePage(page, artifacts.directory, name);
    savedArtifacts.push(
      { kind: 'screenshot', relativePath: relativeArtifactPath(paths, captured.screenshotPath) },
      { kind: 'html', relativePath: relativeArtifactPath(paths, captured.htmlPath) },
    );
  };

  try {
    emit(`打开 ${adapter.label} 页面。`);
    await page.goto(adapter.entryUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await saveSnapshot('01-opened');
    const submittedQuestion = buildSubmittedQuestion(platformRun.prompt.text, appendSearchPrompt);
    const submissionMethod = await adapter.submitQuestion(page, submittedQuestion);
    emit(`问题已提交（${submissionMethod}），等待回答。`);
    await saveSnapshot('02-submitted');
    const content = await adapter.waitForAnswer(page);
    await saveSnapshot('03-answer');
    const citationResult = await captureCitations(page, { platformId: adapter.id, runDirectory: artifacts.directory });
    savedArtifacts.push(
      { kind: 'citations', relativePath: relativeArtifactPath(paths, citationResult.citationPath) },
      { kind: 'screenshot', relativePath: relativeArtifactPath(paths, path.join(artifacts.directory, citationResult.screenshot)) },
    );
    return {
      content,
      responseUrl: page.url(),
      sourcePanelOpened: citationResult.sourcePanelOpened,
      platformReportedCount: citationResult.platformReportedCount,
      displayedSourceLinkCount: citationResult.displayedSourceLinkCount,
      capturedCardCount: citationResult.capturedCardCount,
      capturedCardIndexes: citationResult.capturedCardIndexes,
      missingSourceIndexes: citationResult.missingSourceIndexes,
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
    await browserContext.close();
  }
}
