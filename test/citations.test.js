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
    },
    {
      position: 2,
      title: 'Second source',
      url: 'https://news.example.org/story',
      domain: 'news.example.org',
      citationFragments: [],
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
});

test('reads the source count following the platform-specific source label', () => {
  assert.equal(parsePlatformReportedCount('deepseek', '12 个网页'), 12);
  assert.equal(parsePlatformReportedCount('doubao', '搜索 4 个关键词，参考 17 篇资料'), 17);
  assert.equal(parsePlatformReportedCount('kimi', '参考 3 篇资料'), null);
});
