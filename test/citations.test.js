import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeCitations, parsePlatformReportedCount } from '../src/citations.js';

test('keeps unique external source URLs and assigns citation positions', () => {
  const citations = normalizeCitations([
    { href: 'https://www.example.com/article?id=1', text: ' Example   source ' },
    { href: 'https://www.example.com/article?id=1', text: 'Detailed source title' },
    { href: 'https://chat.example.ai/conversation/1', text: 'Internal link' },
    { href: 'javascript:void(0)', text: 'Action' },
    { href: 'https://news.example.org/story', text: 'Second source' },
  ], 'https://chat.example.ai/conversation/1');

  assert.deepEqual(citations, [
    {
      position: 1,
      title: 'Detailed source title',
      url: 'https://www.example.com/article?id=1',
      domain: 'example.com',
      citationFragments: [],
      citationOccurrences: 0,
    },
    {
      position: 2,
      title: 'Second source',
      url: 'https://news.example.org/story',
      domain: 'news.example.org',
      citationFragments: [],
      citationOccurrences: 0,
    },
  ]);
});

test('groups Kimi text-fragment citations by their original source page', () => {
  const citations = normalizeCitations([
    { href: 'https://news.example.org/article#:~:text=first', text: '' },
    { href: 'https://news.example.org/article#:~:text=second', text: '' },
    { href: 'https://news.example.org/article', text: 'Full source title' },
  ], 'https://www.kimi.com/chat/1');

  assert.equal(citations.length, 1);
  assert.equal(citations[0].url, 'https://news.example.org/article');
  assert.equal(citations[0].title, 'Full source title');
  assert.equal(citations[0].citationFragments.length, 2);
  assert.equal(citations[0].citationOccurrences, 2);
});

test('keeps Kimi source-panel links while counting a regular inline citation', () => {
  const citations = normalizeCitations([
    { href: 'https://source.example/article', text: '来源卡片', className: 'kimi-source-card' },
    {
      href: 'https://source.example/article', text: '', className: 'pua-ref-cite-tag', isInlineCitation: true,
    },
  ], 'https://www.kimi.com/chat/1');

  assert.equal(citations.length, 1);
  assert.equal(citations[0].title, '来源卡片');
  assert.equal(citations[0].citationOccurrences, 1);
});

test('counts DeepSeek citation tags without URL text fragments', () => {
  const citations = normalizeCitations([
    { href: 'https://news.example.org/article', text: '-1', hasCitationMarker: true },
    { href: 'https://news.example.org/article', text: 'Source title', className: 'source-card' },
  ], 'https://chat.deepseek.com/a/chat/s/1');

  assert.equal(citations[0].citationOccurrences, 1);
  assert.equal(citations[0].title, 'Source title');
});

test('reads the source count following the platform-specific source label', () => {
  assert.equal(parsePlatformReportedCount('deepseek', '12 个网页'), 12);
  assert.equal(parsePlatformReportedCount('doubao', '搜索 4 个关键词，参考 17 篇资料'), 17);
  assert.equal(parsePlatformReportedCount('kimi', '引用来源 8'), 8);
  assert.equal(parsePlatformReportedCount('kimi', '参考 3 篇资料'), null);
});

test('reads the source count for the remaining platforms', () => {
  assert.equal(parsePlatformReportedCount('qwen', '共 15 篇来源'), 15);
  assert.equal(parsePlatformReportedCount('yuanbao', '参考来源（9）'), 9);
  assert.equal(parsePlatformReportedCount('yuanbao', '来源 6'), 6);
  assert.equal(parsePlatformReportedCount('wenxiaoyan', '搜索全球 23 篇资料'), 23);
  assert.equal(parsePlatformReportedCount('wenxiaoyan', '搜索了 5 篇资料'), null);
});
