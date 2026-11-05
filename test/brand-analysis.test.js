import assert from 'node:assert/strict';
import test from 'node:test';
import {
  analyzeBrandMentions,
  analyzeOwnedDomainCitations,
  countOccurrences,
  isOwnedDomain,
} from '../src/analysis/brand-analysis.js';

const brand = {
  name: '千威',
  aliases: ['Qianwei'],
  products: ['千威云'],
  ownedDomains: ['example.com'],
};

test('按品牌名称、别名和产品统计提及次数', () => {
  const result = analyzeBrandMentions('推荐千威云，Qianwei 也很好用。千威值得考虑。', brand);
  assert.equal(result.mentioned, true);
  // 「千威」在「千威云」中也会被计一次，因此总数为 4。
  assert.equal(result.occurrences, 4);
  assert.deepEqual(result.matches.map((item) => item.term).sort(), ['Qianwei', '千威', '千威云']);
});

test('回答中没有品牌时不视为提及', () => {
  const result = analyzeBrandMentions('这款产品口碑不错。', brand);
  assert.equal(result.mentioned, false);
  assert.equal(result.occurrences, 0);
  assert.deepEqual(result.matches, []);
});

test('统计指定词的出现次数', () => {
  assert.equal(countOccurrences('aa', 'a'), 2);
  assert.equal(countOccurrences('abcabc', 'abc'), 2);
  assert.equal(countOccurrences('', 'a'), 0);
});

test('自有域名按后缀匹配，忽略 www 前缀', () => {
  assert.equal(isOwnedDomain('example.com', brand.ownedDomains), true);
  assert.equal(isOwnedDomain('www.example.com', brand.ownedDomains), true);
  assert.equal(isOwnedDomain('news.example.com', brand.ownedDomains), true);
  assert.equal(isOwnedDomain('example.com.cn', brand.ownedDomains), false);
  assert.equal(isOwnedDomain('notexample.com', brand.ownedDomains), false);
});

test('自有域名引用分析只保留命中的来源', () => {
  const citations = [
    { position: 1, domain: 'example.com', url: 'https://example.com/a', title: '官网' },
    { position: 2, domain: 'news.example.com', url: 'https://news.example.com/b', title: '子域' },
    { position: 3, domain: 'other.org', url: 'https://other.org/c', title: '第三方' },
  ];
  const result = analyzeOwnedDomainCitations(citations, brand);
  assert.equal(result.cited, true);
  assert.equal(result.count, 2);
  assert.deepEqual(result.citations.map((item) => item.domain), ['example.com', 'news.example.com']);
});

test('没有自有域名引用时返回未命中', () => {
  const result = analyzeOwnedDomainCitations([{ position: 1, domain: 'other.org', url: 'https://other.org/c' }], brand);
  assert.equal(result.cited, false);
  assert.equal(result.count, 0);
});
