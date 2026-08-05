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
      const isInlineCitation = citationFragment || (anchor.hasCitationMarker && !anchor.className);
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
  const pattern = platformId === 'deepseek'
    ? /(\d+)\s*\u4e2a\u7f51\u9875/
    : platformId === 'doubao'
      ? /\u53c2\u8003\s*(\d+)\s*\u7bc7\u8d44\u6599/
      : null;
  const match = pattern?.exec(text);
  return match ? Number(match[1]) : null;
}

async function revealSources(page, platformId) {
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

  const anchors = await page.locator('a[href]').evaluateAll((nodes) => nodes.map((node) => ({
    href: node.href,
    text: (node.textContent || '').trim(),
    className: typeof node.className === 'string' ? node.className : '',
    hasCitationMarker: Boolean(node.querySelector('.ds-markdown-cite')),
  })));
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
