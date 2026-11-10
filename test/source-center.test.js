import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openDatabase } from '../src/db/database.js';
import { GeoRepository } from '../src/db/repository.js';

async function withRepository(callback) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'geo-source-center-'));
  const database = openDatabase(path.join(directory, 'geo.sqlite'));
  try {
    await callback(new GeoRepository(database));
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
}

// 造一个品牌、两个问题、两个平台，每个回答都引用同一批来源，
// 用于验证来源中心的域名排行、问题维度与平台维度。
async function seed(repository) {
  const brand = repository.createBrand({ name: '千威', aliases: [], products: [], ownedDomains: ['example.com'] });
  const first = repository.createPrompt(brand.id, { text: '哪个牌子更稳？' });
  const second = repository.createPrompt(brand.id, { text: '线上买更便宜吗？' });
  const run = repository.createRun({ projectId: brand.id, promptIds: [first.id, second.id], platforms: ['deepseek', 'kimi'] });
  for (const platformRun of repository.getRunDetail(run.id).platformRuns) {
    repository.startPlatformRun(platformRun.id);
    repository.completePlatformRun(platformRun.id, {
      content: '推荐千威。',
      citations: [
        { position: 1, title: '千威说明书', url: 'https://shop.example.com/a', domain: 'shop.example.com', citationFragments: [], citationOccurrences: 2 },
        { position: 2, title: '对比文章', url: 'https://news.example.org/b', domain: 'news.example.org', citationFragments: [], citationOccurrences: 1 },
      ],
    });
  }
  return { brand, first, second };
}

test('来源中心给出域名排行与占比', async () => {
  await withRepository(async (repository) => {
    const { brand } = await seed(repository);
    const data = repository.getBrandSources(brand.id, { days: 30 });
    assert.equal(data.summary.uniqueUrls, 2);
    assert.equal(data.summary.domains, 2);
    assert.equal(data.summary.citationCount, 8);
    assert.equal(data.summary.platformCount, 2);
    assert.equal(data.summary.questionCount, 2);
    assert.equal(data.domains[0].domain, 'shop.example.com');
    assert.equal(data.domains[0].citationCount, 4);
    assert.equal(data.domains[0].urlCount, 1);
    assert.equal(data.domains[0].share, 50);
    assert.equal(data.domains[0].urlShare, 50);
    assert.equal(data.domains[0].owned, true);
    assert.equal(data.domains[1].domain, 'news.example.org');
    assert.equal(data.summary.ownedDomainCitations, 1);
    assert.equal(data.summary.externalDomains, 1);
  });
});

test('来源中心按问题维度聚合，可下钻到某个问题', async () => {
  await withRepository(async (repository) => {
    const { brand, first } = await seed(repository);
    const data = repository.getBrandSources(brand.id, { days: 30 });
    const question = data.questions.find((item) => item.promptId === first.id);
    assert.equal(question.citationCount, 4);
    assert.equal(question.urlCount, 2);
    assert.equal(question.domainCount, 2);
    assert.deepEqual([...question.platforms].sort(), ['deepseek', 'kimi']);

    const filtered = repository.getBrandSources(brand.id, { days: 30, promptId: first.id });
    assert.equal(filtered.summary.questionCount, 1);
    assert.equal(filtered.summary.citationCount, 4);
    assert.equal(filtered.sources.length, 2);
  });
});

test('来源中心按平台筛选并保留跨平台出现记录', async () => {
  await withRepository(async (repository) => {
    const { brand } = await seed(repository);
    const filtered = repository.getBrandSources(brand.id, { days: 30, platformId: 'kimi' });
    assert.equal(filtered.summary.citationCount, 4);
    assert.equal(filtered.summary.platformCount, 1);
    assert.deepEqual(filtered.platformStats[0].platforms ?? [], []);
    assert.equal(filtered.platformStats[0].platformId, 'kimi');
    assert.equal(filtered.platformStats[0].urlCount, 2);
    // 同一个 URL 在两个平台都出现过，按平台筛选后平台标签只剩一个。
    const shop = filtered.sources.find((item) => item.domain === 'shop.example.com');
    assert.deepEqual(shop.platforms, ['kimi']);
    const all = repository.getBrandSources(brand.id, { days: 30 });
    assert.deepEqual(all.sources.find((item) => item.domain === 'shop.example.com').platforms.sort(), ['deepseek', 'kimi']);
  });
});

test('来源中心支持只看提及品牌与只看自有域名', async () => {
  await withRepository(async (repository) => {
    const { brand } = await seed(repository);
    const mentioned = repository.getBrandSources(brand.id, { days: 30, mention: 'mentioned' });
    assert.equal(mentioned.summary.uniqueUrls, 1);
    assert.equal(mentioned.sources[0].domain, 'shop.example.com');
    assert.equal(mentioned.summary.mentionedCitationCount, 4);

    const owned = repository.getBrandSources(brand.id, { days: 30, owned: 'owned' });
    assert.equal(owned.summary.uniqueUrls, 1);
    assert.equal(owned.sources[0].domain, 'shop.example.com');

    const external = repository.getBrandSources(brand.id, { days: 30, owned: 'external' });
    assert.equal(external.summary.uniqueUrls, 1);
    assert.equal(external.sources[0].domain, 'news.example.org');
  });
});

test('来源中心关键词检索与候选项保持稳定', async () => {
  await withRepository(async (repository) => {
    const { brand } = await seed(repository);
    const searched = repository.getBrandSources(brand.id, { days: 30, search: 'news' });
    assert.equal(searched.summary.uniqueUrls, 1);
    assert.equal(searched.sources[0].domain, 'news.example.org');

    // 候选项基于「品牌 + 平台 + 时间」，不随其它筛选条件变化。
    const narrowed = repository.getBrandSources(brand.id, { days: 30, domain: 'news.example.org' });
    assert.deepEqual(narrowed.options.domains.sort(), ['news.example.org', 'shop.example.com']);
    assert.equal(narrowed.options.questions.length, 2);
  });
});

test('来源明细保留每次出现的平台与问题', async () => {
  await withRepository(async (repository) => {
    const { brand } = await seed(repository);
    const data = repository.getBrandSources(brand.id, { days: 30 });
    const shop = data.sources.find((item) => item.domain === 'shop.example.com');
    assert.equal(shop.detailTotal, 4);
    assert.equal(shop.details.length, 4);
    assert.ok(shop.details.every((item) => item.promptText && item.platformId && item.createdAt));
    assert.ok(shop.details.some((item) => item.brandMentioned));
  });
});