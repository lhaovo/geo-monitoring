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
    },
    {
      position: 2,
      title: 'Second source',
      url: 'https://news.example.org/story',
      domain: 'news.example.org',
    },
  ]);
});

test('reads the source count following the platform-specific source label', () => {
  assert.equal(parsePlatformReportedCount('deepseek', '12 个网页'), 12);
  assert.equal(parsePlatformReportedCount('doubao', '搜索 4 个关键词，参考 17 篇资料'), 17);
  assert.equal(parsePlatformReportedCount('kimi', '参考 3 篇资料'), null);
});
