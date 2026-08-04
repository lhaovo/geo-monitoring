import { writeFile } from 'node:fs/promises';
import path from 'node:path';

const SOURCE_TRIGGER_PATTERNS = Object.freeze({
  deepseek: /\d+\s*\u4e2a\u7f51\u9875/,
  doubao: /\u53c2\u8003\s*\d+\s*\u7bc7\u8d44\u6599/,
});

export function normalizeCitations(anchors, responseUrl) {
  const responseHost = new URL(responseUrl).hostname;
  const citationByUrl = new Map();
  const citations = [];

  for (const anchor of anchors) {
    try {
      const url = new URL(anchor.href);
      if (!['http:', 'https:'].includes(url.protocol) || url.hostname === responseHost) continue;

      const canonicalUrl = url.toString();
      const title = anchor.text.replace(/\s+/g, ' ').trim();
      const existing = citationByUrl.get(canonicalUrl);
      if (existing) {
        if (title.length > existing.title.length) existing.title = title;
        continue;
      }

      const citation = {
        position: citations.length + 1,
        title,
        url: canonicalUrl,
        domain: url.hostname.replace(/^www\./, ''),
      };
      citations.push(citation);
      citationByUrl.set(canonicalUrl, citation);
    } catch {
      // Ignore non-URL links such as page anchors and javascript actions.
    }
  }

  return citations;
}

export function parsePlatformReportedCount(platformId, text) {
  const pattern = platformId === 'deepseek'
    ? /(\d+)\s*\u4e2a\u7f51\u9875/
    : platformId === 'doubao'
      ? /\u53c2\u8003\s*(\d+)\s*\u7bc7\u8d44\u6599/
      : null;
  const match = pattern?.exec(text);
  return match ? Number(match[1]) : null;
}

async function revealSources(page, platformId) {
  const pattern = SOURCE_TRIGGER_PATTERNS[platformId];
  if (!pattern) return { opened: false, platformReportedCount: null };

  const triggers = page.getByText(pattern);
  const count = await triggers.count();
  for (let index = count - 1; index >= 0; index -= 1) {
    const trigger = triggers.nth(index);
    if (await trigger.isVisible()) {
      const text = await trigger.innerText();
      await trigger.click();
      await page.waitForTimeout(500);
      return {
        opened: true,
        platformReportedCount: parsePlatformReportedCount(platformId, text),
      };
    }
  }

  return { opened: false, platformReportedCount: null };
}

export async function captureCitations(page, { platformId, runDirectory }) {
  let sourcePanelOpened = false;
  let platformReportedCount = null;
  try {
    ({ opened: sourcePanelOpened, platformReportedCount } = await revealSources(page, platformId));
  } catch {
    // A source panel is optional. Collect links already exposed in the response.
  }

  const anchors = await page.locator('a[href]').evaluateAll((nodes) => nodes.map((node) => ({
    href: node.href,
    text: (node.textContent || '').trim(),
  })));
  const citations = normalizeCitations(anchors, page.url());
  const citationPath = path.join(runDirectory, 'citations.json');
  const screenshotPath = path.join(runDirectory, 'citations.png');

  await writeFile(citationPath, `${JSON.stringify({
    capturedAt: new Date().toISOString(),
    responseUrl: page.url(),
    sourcePanelOpened,
    platformReportedCount,
    citations,
  }, null, 2)}\n`, 'utf8');
  await page.screenshot({ path: screenshotPath });

  return {
    citationPath,
    screenshot: path.basename(screenshotPath),
    count: citations.length,
    sourcePanelOpened,
    platformReportedCount,
  };
}
