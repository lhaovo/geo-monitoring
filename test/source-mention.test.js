import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { analyzeCitationMentions, analyzeMentionSupport } from '../src/analysis/brand-analysis.js';
import { openDatabase } from '../src/db/database.js';
import { GeoRepository } from '../src/db/repository.js';

const brand = {
  name: '千威',
  aliases: ['Qianwei'],
  products: ['千威云'],
  ownedDomains: ['example.com'],
};

async function withRepository(callback) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'geo-source-mention-'));
  const database = openDatabase(path.join(directory, 'geo.sqlite'));
  try {
    await callback(new GeoRepository(database));
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
}

// 造一个已完成的回答：给定内容与引用来源。
async function seedAnswer(repository, { content, citations }) {
  const brandRecord = repository.createBrand({ name: brand.name, aliases: brand.aliases, products: brand.products });
  const prompt = repository.createPrompt(brandRecord.id, { text: '哪个牌子更稳？' });
  const run = repository.createRun({ projectId: brandRecord.id, promptIds: [prompt.id], platforms: ['deepseek'] });
  const platformRun = repository.getRunDetail(run.id).platformRuns[0];
  repository.startPlatformRun(platformRun.id);
  repository.completePlatformRun(platformRun.id, { content, citations });
  return { brandRecord, prompt, run, platformRun };
}

test('引用标题命中品牌词时判定来源提及品牌', () => {
  const result = analyzeCitationMentions([
    { position: 1, domain: 'baike.example', url: 'https://baike.example/a', title: '百度百科2026/09/17千威枸橼酸西地那非片' },
    { position: 2, domain: 'news.example', url: 'https://news.example/b', title: '每日新闻 他达拉非对比' },
  ], brand);
  assert.equal(result.mentioned, true);
  assert.equal(result.count, 1);
  assert.deepEqual(result.matchedTerms, ['千威']);
  assert.equal(result.citations[0].mentioned, true);
  assert.equal(result.citations[1].mentioned, false);
});

test('引用来源没有标题时不算命中', () => {
  const result = analyzeCitationMentions([{ position: 1, domain: 'a.example', url: 'https://a.example/a', title: '' }], brand);
  assert.equal(result.mentioned, false);
  assert.equal(result.count, 0);
  assert.deepEqual(result.matchedTerms, []);
});

test('回答提及与来源提及的交叉判断', () => {
  assert.deepEqual(
    analyzeMentionSupport({ mentioned: true }, { mentioned: true }),
    { mentionBackedBySource: true, mentionWithoutSource: false },
  );
  assert.deepEqual(
    analyzeMentionSupport({ brandMentioned: true }, { mentioned: false }),
    { mentionBackedBySource: false, mentionWithoutSource: true },
  );
  assert.deepEqual(
    analyzeMentionSupport({ mentioned: false }, { mentioned: false }),
    { mentionBackedBySource: false, mentionWithoutSource: false },
  );
});

test('回答落库时记录来源提及与支撑关系', async () => {
  await withRepository(async (repository) => {
    const { brandRecord, platformRun } = await seedAnswer(repository, {
      content: '推荐千威，效果稳定。',
      citations: [
        { position: 1, title: '千威 枸橼酸西地那非片说明书', url: 'https://baike.example/a', domain: 'baike.example', citationFragments: [], citationOccurrences: 1 },
        { position: 2, title: '他达拉非对比文章', url: 'https://news.example/b', domain: 'news.example', citationFragments: [], citationOccurrences: 1 },
      ],
    });
    const answer = repository.getAnswer(repository.getRunDetail(platformRun.runId).platformRuns[0].answer.id);
    assert.equal(answer.brandMentioned, true);
    assert.equal(answer.sourceMentioned, true);
    assert.equal(answer.sourceMentionCount, 1);
    assert.deepEqual(answer.sourceMatchedTerms, ['千威']);
    assert.equal(answer.mentionBackedBySource, true);
    assert.equal(answer.mentionWithoutSource, false);
    assert.equal(answer.citations[0].brandMentioned, true);
    assert.equal(answer.citations[1].brandMentioned, false);

    const sources = repository.getBrandSources(brandRecord.id, { days: 30 });
    assert.equal(sources.summary.sourceMentionedUrls, 1);
    assert.equal(sources.summary.sourceMentionedRate, 50);
    assert.equal(sources.sources.find((item) => item.url === 'https://baike.example/a').brandMentioned, true);
    assert.deepEqual(sources.sources.find((item) => item.url === 'https://baike.example/a').matchedTerms, ['千威']);
  });
});

test('回答提到品牌但来源未提到时记为无来源支撑', async () => {
  await withRepository(async (repository) => {
    const { platformRun } = await seedAnswer(repository, {
      content: '推荐千威，效果稳定。',
      citations: [
        { position: 1, title: '他达拉非对比文章', url: 'https://news.example/b', domain: 'news.example', citationFragments: [], citationOccurrences: 1 },
      ],
    });
    const answer = repository.getAnswer(repository.getRunDetail(platformRun.runId).platformRuns[0].answer.id);
    assert.equal(answer.brandMentioned, true);
    assert.equal(answer.sourceMentioned, false);
    assert.equal(answer.mentionBackedBySource, false);
    assert.equal(answer.mentionWithoutSource, true);
  });
});

test('品牌词变更后回算历史回答', async () => {
  await withRepository(async (repository) => {
    const { brandRecord, platformRun } = await seedAnswer(repository, {
      content: '推荐千威，效果稳定。',
      citations: [
        { position: 1, title: '千威 枸橼酸西地那非片说明书', url: 'https://baike.example/a', domain: 'baike.example', citationFragments: [], citationOccurrences: 1 },
      ],
    });
    const answerId = repository.getRunDetail(platformRun.runId).platformRuns[0].answer.id;
    assert.equal(repository.getAnswer(answerId).brandMentioned, true);

    repository.updateBrand(brandRecord.id, { name: '万艾可', aliases: [], products: [] });
    const after = repository.getAnswer(answerId);
    assert.equal(after.brandMentioned, false);
    assert.equal(after.sourceMentioned, false);
    assert.equal(after.mentionCount, 0);
    assert.deepEqual(after.matchedTerms, []);
    assert.equal(after.citations[0].brandMentioned, false);
  });
});

test('回算接口返回处理的回答数量', async () => {
  await withRepository(async (repository) => {
    const { brandRecord } = await seedAnswer(repository, {
      content: '推荐千威。',
      citations: [{ position: 1, title: '千威说明书', url: 'https://baike.example/a', domain: 'baike.example', citationFragments: [], citationOccurrences: 1 }],
    });
    assert.deepEqual(repository.recomputeBrandAnalysis(brandRecord.id), { brandId: brandRecord.id, answers: 1 });
  });
});
