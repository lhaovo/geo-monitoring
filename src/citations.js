import { writeFile } from 'node:fs/promises';
import path from 'node:path';

const SOURCE_TRIGGER_PATTERNS = Object.freeze({
  deepseek: /\d+\s*\u4e2a\u7f51\u9875/,
  doubao: /\u53c2\u8003\s*\d+\s*\u7bc7\u8d44\u6599/,
  kimi: /\u5f15\u7528/,
});

export function normalizeCitations(anchors, responseUrl) {
  const responseHost = new URL(responseUrl).hostname;
  const citationByUrl = new Map();
  const citations = [];

  for (const anchor of anchors) {
    try {
      const url = new URL(anchor.href);
      if (!['http:', 'https:'].includes(url.protocol) || url.hostname === responseHost) continue;

      const originalUrl = url.toString();
      const citationFragment = url.hash.startsWith('#:~:text=') ? originalUrl : null;
      const isInlineCitation = citationFragment || anchor.isInlineCitation || (anchor.hasCitationMarker && !anchor.className);
      if (citationFragment) url.hash = '';
      const canonicalUrl = url.toString();
      const title = anchor.text.replace(/\s+/g, ' ').trim();
      const existing = citationByUrl.get(canonicalUrl);
      if (existing) {
        if (title.length > existing.title.length) existing.title = title;
        if (citationFragment && !existing.citationFragments.includes(citationFragment)) {
          existing.citationFragments.push(citationFragment);
        }
        if (isInlineCitation) existing.citationOccurrences += 1;
        continue;
      }

      const citation = {
        position: citations.length + 1,
        title,
        url: canonicalUrl,
        domain: url.hostname.replace(/^www\./, ''),
        citationFragments: citationFragment ? [citationFragment] : [],
        citationOccurrences: isInlineCitation ? 1 : 0,
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
  const patterns = {
    deepseek: /(\d+)\s*\u4e2a\u7f51\u9875/u,
    doubao: /\u53c2\u8003\s*(\d+)\s*\u7bc7\u8d44\u6599/u,
    kimi: /\u5f15\u7528\u6765\u6e90\s*(\d+)/u,
    qwen: /(\d+)\s*\u7bc7\u6765\u6e90/u,
    yuanbao: /(?:\u53c2\u8003\u6765\u6e90|\u6765\u6e90)\s*[\uff08(]?(\d+)[\uff09)]?/u,
    wenxiaoyan: /\u641c\u7d22\u5168\u7403\s*(\d+)\s*\u7bc7\u8d44\u6599/u,
  };
  const match = patterns[platformId]?.exec(String(text ?? ''));
  return match ? Number(match[1]) : null;
}

async function collectAnchors(locator) {
  return locator.evaluateAll((nodes) => nodes.map((node) => ({
    href: node.href,
    text: (node.textContent || '').trim(),
    className: typeof node.className === 'string' ? node.className : '',
    hasCitationMarker: Boolean(node.querySelector('.ds-markdown-cite')),
    isInlineCitation: node.matches?.('.pua-ref-cite-tag') ?? false,
  })));
}

async function collectWenxiaoyanResponseAnchors(page) {
  const anchors = [];
  for (const selector of [
    '.chat-search-answer-generate:visible a[href]',
    '.chat-right-bar:visible a[href]',
  ]) {
    const locator = page.locator(selector);
    const count = await locator.count().catch(() => 0);
    if (count) anchors.push(...await collectAnchors(locator));
  }
  return anchors;
}

// 文小言把参考资料渲染成带 data-show-ext 的有序列表，每一项都内嵌了外链与
// 标题，可以直接读出平台自报的资料总数，无需触发任何交互。
async function readWenxiaoyanSourceList(page) {
  const lists = page.locator('ol[class*="_reference_"], [class*="_reference-list_"]');
  const count = await lists.count().catch(() => 0);
  for (let listIndex = count - 1; listIndex >= 0; listIndex -= 1) {
    const data = await lists.nth(listIndex).evaluate((list) => {
      let reportedCount = null;
      try {
        const showExt = JSON.parse(list.getAttribute('data-show-ext') || '{}');
        reportedCount = Number(showExt.total_num) || null;
      } catch {
        reportedCount = null;
      }
      const items = [...list.querySelectorAll('li[data-long-press-ext-info], li[class*="_reference-item_"]')]
        .map((item, index) => {
          let ext = {};
          try { ext = JSON.parse(item.getAttribute('data-long-press-ext-info') || '{}'); } catch { ext = {}; }
          const href = ext.link || item.querySelector('a[href]')?.href || null;
          const text = String(ext.linkTitle || item.textContent || '').replace(/\s+/gu, ' ').trim();
          return {
            href,
            text,
            className: 'wenxiaoyan-reference-item',
            hasCitationMarker: true,
            isInlineCitation: true,
            index: index + 1,
          };
        })
        .filter((item) => /^https?:\/\//u.test(item.href || ''));
      return { reportedCount, items };
    }).catch(() => ({ reportedCount: null, items: [] }));
    if (data.items.length) {
      return {
        opened: true,
        platformReportedCount: data.reportedCount,
        displayedSourceLinkCount: data.items.length,
        capturedCardCount: data.items.length,
        capturedCardIndexes: data.items.map((item) => item.index),
        missingSourceIndexes: data.reportedCount
          ? Array.from({ length: data.reportedCount }, (_, index) => index + 1)
            .filter((index) => !data.items.some((item) => item.index === index))
          : [],
        anchors: data.items,
      };
    }
  }
  return { opened: false, platformReportedCount: null, anchors: [] };
}

async function readKimiSourcePanel(page) {
  const headers = page.getByText(/^\s*\u5f15\u7528\u6765\u6e90(?:\s*\d+)?\s*$/u);
  const count = await headers.count();

  for (let index = count - 1; index >= 0; index -= 1) {
    const header = headers.nth(index);
    if (!await header.isVisible().catch(() => false)) continue;

    return header.evaluate((node) => {
      const externalAnchors = (container) => [...container.querySelectorAll('a[href]')]
        .filter((anchor) => /^https?:\/\//u.test(anchor.href))
        .map((anchor) => ({
          href: anchor.href,
          text: (anchor.textContent || '').trim(),
          className: 'kimi-source-card',
          hasCitationMarker: false,
          isInlineCitation: false,
        }));

      let reportedCountText = node.textContent || '';
      let titleContainer = node.parentElement;
      for (let depth = 0; titleContainer && depth < 4; depth += 1, titleContainer = titleContainer.parentElement) {
        const candidateText = titleContainer.textContent || '';
        if (/\u5f15\u7528\u6765\u6e90\s*\d+/u.test(candidateText)) {
          reportedCountText = candidateText;
          break;
        }
      }

      let panel = node.parentElement;
      for (let depth = 0; panel && depth < 8; depth += 1, panel = panel.parentElement) {
        const anchors = externalAnchors(panel);
        if (anchors.length) {
          return {
            found: true,
            reportedCountText,
            anchors,
          };
        }
      }

      return { found: true, reportedCountText, anchors: [] };
    });
  }

  return { found: false, reportedCountText: '', anchors: [] };
}

async function scrollKimiSourcePanel(page) {
  const headers = page.getByText(/^\s*\u5f15\u7528\u6765\u6e90(?:\s*\d+)?\s*$/u);
  const count = await headers.count();

  for (let index = count - 1; index >= 0; index -= 1) {
    const header = headers.nth(index);
    if (!await header.isVisible().catch(() => false)) continue;

    return header.evaluate((node) => {
      const hasExternalAnchor = (container) => Boolean(container.querySelector('a[href^="http://"], a[href^="https://"]'));
      let panel = node.parentElement;
      for (let depth = 0; panel && depth < 8; depth += 1, panel = panel.parentElement) {
        if (hasExternalAnchor(panel)) break;
      }
      if (!panel) return false;

      const scrollable = [panel, ...panel.querySelectorAll('*')].find((element) => (
        element.scrollHeight > element.clientHeight + 1
        && getComputedStyle(element).overflowY !== 'visible'
      ));
      if (!scrollable) return false;

      const before = scrollable.scrollTop;
      scrollable.scrollTop += Math.max(160, Math.floor(scrollable.clientHeight * 0.8));
      return scrollable.scrollTop > before;
    });
  }

  return false;
}

async function collectKimiResponseAnchors(page) {
  const responses = page.locator('.segment.segment-assistant');
  const count = await responses.count();
  if (!count) return [];
  return collectAnchors(responses.nth(count - 1).locator('a[href]'));
}

async function revealSources(page, platformId) {
  if (platformId === 'wenxiaoyan') return readWenxiaoyanSourceList(page);
  if (platformId === 'qwen') {
    const sourceAnchors = [];
    const trigger = page.getByText(/\d+\s*篇来源/u).last();
    if (!await trigger.count() || !await trigger.isVisible()) {
      return { opened: false, platformReportedCount: null, anchors: [] };
    }
    const triggerText = await trigger.innerText();
    const reportedCount = Number(/(\d+)/u.exec(triggerText)?.[1] ?? 0) || null;
    try {
      await trigger.click({ force: true });
      await page.waitForTimeout(500);
      sourceAnchors.push(...await page.locator('[data-c="refer_panel"][data-d="card"]').evaluateAll((nodes) => nodes.map((node) => {
        const parsePayload = (value) => {
          try { return JSON.parse(value ?? '{}'); } catch { return {}; }
        };
        const payload = parsePayload(node.getAttribute('data-click-extra') || node.getAttribute('data-log-params'));
        const href = payload.url || payload.ref_url || '';
        return {
          href,
          text: payload.title || (node.textContent || '').trim(),
          className: 'qwen-source-card',
          hasCitationMarker: false,
        };
      }).filter((item) => /^https?:\/\//u.test(item.href))));
      return { opened: true, platformReportedCount: reportedCount, anchors: sourceAnchors };
    } catch {
      return { opened: false, platformReportedCount: reportedCount, anchors: sourceAnchors };
    }
  }

  if (platformId === 'yuanbao') {
    const sourceAnchors = [];
    const sourceIndexes = new Set();
    const occurrenceByIndex = new Map();
    const sourceByIndex = new Map();
    let displayedSourceLinkCount = 0;
    const responseRoots = page.locator('[data-conv-speaker="ai"][data-conv-status="finished"]');
    const responseRoot = await responseRoots.count() ? responseRoots.last() : page.locator('body');

    const readTextLinks = async () => responseRoot.locator('.hyc-common-markdown__link__content').evaluateAll((nodes) => nodes.map((node) => {
      const href = (node.textContent ?? '').trim();
      const containerText = (node.closest('li')?.textContent ?? '').replace(href, '').trim();
      return {
        href,
        text: containerText || href,
        className: 'yuanbao-text-link',
        hasCitationMarker: false,
      };
    }).filter((item) => /^https?:\/\//u.test(item.href)));

    const readCards = async (popup) => popup.locator('.hyc-common-markdown__ref_card[data-url]').evaluateAll((nodes) => nodes.map((node) => ({
      index: node.getAttribute('data-idx') ?? '',
      href: node.getAttribute('data-url') ?? '',
      text: (node.querySelector('.hyc-common-markdown__ref_card-title')?.textContent
        || node.querySelector('.hyc-common-markdown__ref_card-foot__source_txt')?.textContent
        || '').trim(),
    })).filter((card) => card.index && /^https?:\/\//u.test(card.href)));
    const cardFingerprint = (cards) => cards.map((card) => `${card.index}\u0000${card.href}`).join('\u0001');

    const waitForPopupCards = async (popup, previousFingerprint = '') => {
      const deadline = Date.now() + 3_000;
      while (Date.now() < deadline) {
        const cards = await readCards(popup);
        const fingerprint = cardFingerprint(cards);
        if (fingerprint && fingerprint !== previousFingerprint) return { cards, fingerprint };
        await page.waitForTimeout(150);
      }
      const cards = await readCards(popup);
      return { cards, fingerprint: cardFingerprint(cards) };
    };

    // Wait for the last answer's source markers/URL list to stop changing.
    const stableDeadline = Date.now() + 15_000;
    let previousSourceFingerprint = '';
    let stableSince = 0;
    let emptySince = Date.now();
    while (Date.now() < stableDeadline) {
      const fingerprint = await responseRoot.locator('.hyc-common-markdown__ref-list__trigger, .hyc-common-markdown__link__content')
        .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-idx-list') || (node.textContent || '').trim()).join('\u0001'));
      if (!fingerprint) {
        if (Date.now() - emptySince >= 3_000) break;
      } else if (fingerprint === previousSourceFingerprint) {
        stableSince ||= Date.now();
        if (Date.now() - stableSince >= 750) break;
      } else {
        previousSourceFingerprint = fingerprint;
        stableSince = 0;
        emptySince = Date.now();
      }
      await page.waitForTimeout(150);
    }

    // Read the bottom "来源（权威原文）" URL text before opening any popup;
    // Yuanbao may remount/virtualize the answer while a popup is open.
    const initialTextLinks = await readTextLinks();
    displayedSourceLinkCount = initialTextLinks.length;
    sourceAnchors.push(...initialTextLinks);

    const closeAd = page.locator('[class*="downloadPCAdsWrapper"] [class*="close"]').last();
    try {
      if (await closeAd.count() && await closeAd.isVisible()) await closeAd.click({ force: true });
    } catch {
      // The ad is optional and can disappear while the page is settling.
    }

    // Read every trigger in the latest answer, including off-screen triggers.
    const triggers = responseRoot.locator('.hyc-common-markdown__ref-list__trigger');
    const triggerData = await triggers.evaluateAll((nodes) => nodes.map((node, index) => ({
      index,
      indexes: (node.getAttribute('data-idx-list') ?? '').split(',').map((value) => value.trim()).filter(Boolean),
    })).filter((item) => item.indexes.length));
    const triggerGroups = new Map();
    for (const item of triggerData) {
      const key = item.indexes.join(',');
      const group = triggerGroups.get(key) ?? { ...item, occurrences: 0 };
      group.occurrences += 1;
      triggerGroups.set(key, group);
      for (const value of item.indexes) {
        sourceIndexes.add(value);
        occurrenceByIndex.set(value, (occurrenceByIndex.get(value) ?? 0) + 1);
      }
    }

    let opened = false;
    for (const group of triggerGroups.values()) {
      const trigger = triggers.nth(group.index);
      try {
        await trigger.scrollIntoViewIfNeeded({ timeout: 2_000 });
        await trigger.click({ force: true });
        opened = true;
        const popup = page.locator('.hyc-common-markdown__ref-list__popup:visible').last();
        await popup.waitFor({ state: 'visible', timeout: 2_000 });
        let cards = await readCards(popup);
        let fingerprint = cardFingerprint(cards);
        const seenFingerprints = new Set();
        for (let pageIndex = 0; pageIndex < 100; pageIndex += 1) {
          if (fingerprint) seenFingerprints.add(fingerprint);
          for (const card of cards) sourceByIndex.set(card.index, card);

          const nextButton = popup.locator('.hyc-common-markdown__ref-list__header button').last();
          if (!await nextButton.count()) break;
          const disabled = await nextButton.isDisabled().catch(() => false);
          const ariaDisabled = await nextButton.getAttribute('aria-disabled').catch(() => null);
          if (disabled || ariaDisabled === 'true') break;
          await nextButton.click({ force: true });
          const next = await waitForPopupCards(popup, fingerprint);
          cards = next.cards;
          fingerprint = next.fingerprint;
          if (!fingerprint || seenFingerprints.has(fingerprint)) break;
        }
        await page.keyboard.press('Escape');
      } catch {
        // Keep sources captured from the other inline reference triggers.
      }
    }

    const sortedIndexes = [...sourceIndexes].sort((left, right) => {
      const leftNumber = Number(left);
      const rightNumber = Number(right);
      return Number.isNaN(leftNumber) || Number.isNaN(rightNumber)
        ? left.localeCompare(right)
        : leftNumber - rightNumber;
    });
    const missingSourceIndexes = sortedIndexes.filter((sourceIndex) => !sourceByIndex.has(sourceIndex));
    for (const sourceIndex of sortedIndexes) {
      const source = sourceByIndex.get(sourceIndex);
      if (!source) continue;
      const occurrences = occurrenceByIndex.get(sourceIndex) ?? 1;
      for (let occurrence = 0; occurrence < occurrences; occurrence += 1) {
        sourceAnchors.push({
          href: source.href,
          text: source.text,
          className: '',
          hasCitationMarker: true,
        });
      }
    }

    // Collect the bottom source list once more after all popup interactions.
    sourceAnchors.push(...await readTextLinks());
    return {
      opened,
      platformReportedCount: sourceIndexes.size || null,
      displayedSourceLinkCount,
      capturedCardCount: sourceByIndex.size,
      capturedCardIndexes: [...sourceByIndex.keys()],
      missingSourceIndexes,
      anchors: sourceAnchors,
    };
  }

  if (platformId === 'kimi') {
    const responseRoots = page.locator('.segment.segment-assistant');
    const responseCount = await responseRoots.count();
    const responseRoot = responseCount ? responseRoots.nth(responseCount - 1) : null;
    const triggers = responseRoot ? responseRoot.locator('.ref-action') : page.locator('.ref-action');
    const triggerCount = await triggers.count();
    let trigger = null;
    for (let index = triggerCount - 1; index >= 0; index -= 1) {
      const candidate = triggers.nth(index);
      if (await candidate.isVisible().catch(() => false)) {
        trigger = candidate;
        break;
      }
    }
    if (!trigger) return { opened: false, platformReportedCount: null, anchors: [] };

    try {
      await trigger.click({ force: true });
    } catch {
      return { opened: false, platformReportedCount: null, anchors: [] };
    }

    const sourcesByUrl = new Map();
    let platformReportedCount = null;
    let sourcePanelOpened = false;
    let stablePasses = 0;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const panel = await readKimiSourcePanel(page);
      if (!panel.found) {
        await page.waitForTimeout(150);
        continue;
      }

      sourcePanelOpened = true;
      platformReportedCount ??= parsePlatformReportedCount('kimi', panel.reportedCountText);
      const before = sourcesByUrl.size;
      for (const anchor of panel.anchors) {
        const existing = sourcesByUrl.get(anchor.href);
        if (!existing || anchor.text.length > existing.text.length) sourcesByUrl.set(anchor.href, anchor);
      }

      if (platformReportedCount && sourcesByUrl.size >= platformReportedCount) break;
      const scrolled = await scrollKimiSourcePanel(page);
      stablePasses = sourcesByUrl.size === before ? stablePasses + 1 : 0;
      if (!scrolled || stablePasses >= 3) break;
      await page.waitForTimeout(150);
    }

    const capturedCardCount = sourcesByUrl.size;
    try {
      await page.keyboard.press('Escape');
    } catch {
      // The source panel may already be closed by the platform.
    }
    return {
      opened: sourcePanelOpened,
      platformReportedCount,
      displayedSourceLinkCount: capturedCardCount,
      capturedCardCount,
      // Kimi's source sidebar exposes a total count but no stable source
      // identifiers. Do not invent missing/index values from list position.
      capturedCardIndexes: [],
      missingSourceIndexes: [],
      anchors: [...sourcesByUrl.values()],
    };
  }

  const pattern = SOURCE_TRIGGER_PATTERNS[platformId];
  if (!pattern) return { opened: false, platformReportedCount: null, anchors: [] };

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
        anchors: [],
      };
    }
  }

  return { opened: false, platformReportedCount: null, anchors: [] };
}

export async function captureCitations(page, { platformId, runDirectory }) {
  let sourcePanelOpened = false;
  let platformReportedCount = null;
  let capturedCardCount = null;
  let capturedCardIndexes = [];
  let missingSourceIndexes = [];
  let displayedSourceLinkCount = null;
  let platformSourceAnchors = [];
  try {
    ({
      opened: sourcePanelOpened,
      platformReportedCount,
      displayedSourceLinkCount,
      capturedCardCount,
      capturedCardIndexes,
      missingSourceIndexes,
      anchors: platformSourceAnchors,
    } = await revealSources(page, platformId));
  } catch {
    // A source panel is optional. Collect links already exposed in the response.
  }

  const anchors = platformId === 'kimi'
    ? await collectKimiResponseAnchors(page)
    : platformId === 'wenxiaoyan'
      ? await collectWenxiaoyanResponseAnchors(page)
      : await collectAnchors(page.locator('a[href]'));
  const citations = normalizeCitations([...anchors, ...platformSourceAnchors], page.url());
  const citationPath = path.join(runDirectory, 'citations.json');
  const screenshotPath = path.join(runDirectory, 'citations.png');

  await writeFile(citationPath, `${JSON.stringify({
    capturedAt: new Date().toISOString(),
    responseUrl: page.url(),
    sourcePanelOpened,
    platformReportedCount,
    displayedSourceLinkCount,
    capturedCardCount,
    capturedCardIndexes,
    missingSourceIndexes,
    uniqueUrlCount: citations.length,
    citations,
    citationOccurrences: citations.reduce((total, citation) => total + citation.citationOccurrences, 0),
  }, null, 2)}\n`, 'utf8');
  await page.screenshot({ path: screenshotPath });

  return {
    citationPath,
    screenshot: path.basename(screenshotPath),
    count: citations.length,
    citationOccurrences: citations.reduce((total, citation) => total + citation.citationOccurrences, 0),
    sourcePanelOpened,
    platformReportedCount,
    displayedSourceLinkCount,
    capturedCardCount,
    capturedCardIndexes,
    missingSourceIndexes,
    uniqueUrlCount: citations.length,
  };
}
