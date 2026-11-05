import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeBrandMentions, analyzeOwnedDomainCitations } from '../scripts/lib/brand.mjs';
import { normalizeCitations, parsePlatformReportedCount } from '../scripts/lib/citations.mjs';
import { calculateWorkerLimit } from '../scripts/lib/scheduler.mjs';

test('keeps unique source URLs within one answer and preserves citation occurrences', () => {
  const citations = normalizeCitations([
    { href: 'https://source.example/article#:~:text=one', text: '' },
    { href: 'https://source.example/article#:~:text=two', text: '' },
    { href: 'https://source.example/article', text: 'Source title' },
  ], 'https://www.kimi.com/chat/1');
  assert.equal(citations.length, 1);
  assert.equal(citations[0].citationOccurrences, 2);
  assert.equal(citations[0].title, 'Source title');
});

test('calculates a conservative worker cap with a configurable maximum', () => {
  assert.equal(calculateWorkerLimit({ availableMiB: 3_000, selectedBindingCount: 4 }), 1);
  assert.equal(calculateWorkerLimit({ availableMiB: 5_200, selectedBindingCount: 4 }), 2);
  assert.equal(calculateWorkerLimit({ availableMiB: 8_000, selectedBindingCount: 4 }), 3);
  assert.equal(calculateWorkerLimit({ availableMiB: 8_000, selectedBindingCount: 4, globalMaxWorkerConcurrency: 2 }), 2);
});

test('allows two profiles of the same platform to run concurrently', () => {
  assert.equal(calculateWorkerLimit({ availableMiB: 8_000, selectedBindingCount: 2 }), 2);
});

test('reports brand and owned-domain citations separately', () => {
  const brand = { name: 'Acme', aliases: ['Acme Pro'], ownedDomains: ['acme.com'] };
  assert.equal(analyzeBrandMentions('Acme Pro is recommended by Acme.', brand).occurrences, 3);
  const owned = analyzeOwnedDomainCitations([{ position: 1, domain: 'news.acme.com', url: 'https://news.acme.com/a', title: 'A' }], brand);
  assert.equal(owned.cited, true);
});

test('parses Wenxiaoyan reported search source count', () => {
  assert.equal(parsePlatformReportedCount('wenxiaoyan', '搜索全球27篇资料'), 27);
});
