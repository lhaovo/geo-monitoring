import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openDatabase } from '../src/db/database.js';
import { GeoRepository } from '../src/db/repository.js';
import { buildLinkIndex, matchOwnedLink, normalizeUrl } from '../src/analysis/owned-links.js';

async function withRepository(callback) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'geo-owned-links-'));
  const database = openDatabase(path.join(directory, 'geo.sqlite'));
  try {
    await callback(new GeoRepository(database));
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
}

// 造一个已完成的回答：给定内容与引用来源。
async function seedAnswer(repository, brandId, { promptText = '哪个牌子更稳？', platform = 'deepseek', citations }) {
  const prompt = repository.createPrompt(brandId, { text: promptText });
  const run = repository.createRun({ projectId: brandId, promptIds: [prompt.id], platforms: [platform] });
  const platformRun = repository.getRunDetail(run.id).platformRuns[0];
  repository.startPlatformRun(platformRun.id);
  repository.completePlatformRun(platformRun.id, { content: '推荐千威。', citations });
  return { prompt, platformRun };
}

test('链接归一化会忽略协议、大小写、末尾斜杠与追踪参数', () => {
  const first = normalizeUrl('https://WWW.Example.com/post/1/?utm_source=x&id=7#top');
  const second = normalizeUrl('example.com/post/1?id=7');
  assert.equal(first.key, second.key);
  assert.equal(first.pathKey, 'example.com/post/1');
  assert.equal(normalizeUrl('不是链接'), null);
});

test('自有链接匹配优先精确，其次忽略追踪参数', () => {
  const link = { id: 'l1', normalizedUrl: 'example.com/post/1', pathKey: 'example.com/post/1' };
  const index = buildLinkIndex([link]);
  assert.equal(matchOwnedLink('https://example.com/post/1', index).matchType, 'exact');
  assert.equal(matchOwnedLink('https://example.com/post/1?utm_source=weibo', index).matchType, 'exact');
  assert.equal(matchOwnedLink('https://example.com/post/1?id=7', index).matchType, 'path');
  assert.equal(matchOwnedLink('https://example.com/post/2', index), null);
});

test('批量导入自有链接并去重', async () => {
  await withRepository(async (repository) => {
    const brand = repository.createBrand({ name: '千威' });
    const result = repository.importBrandLinks(brand.id, [
      'https://example.com/post/1',
      'https://example.com/post/1?utm_source=x',
      '不是链接',
    ]);
    assert.equal(result.imported, 1);
    assert.equal(result.duplicates, 1);
    assert.deepEqual(result.invalid, ['不是链接']);
    assert.equal(repository.listBrandLinks(brand.id).length, 1);
    assert.throws(() => repository.createBrandLink(brand.id, { url: 'https://example.com/post/1' }), /已经在监测列表/);
  });
});

test('采集到的引用命中自有链接时自动标记', async () => {
  await withRepository(async (repository) => {
    const brand = repository.createBrand({ name: '千威' });
    const link = repository.createBrandLink(brand.id, { url: 'https://example.com/post/1', title: '我们的文章' });
    await seedAnswer(repository, brand.id, {
      citations: [{ position: 1, title: '我们的文章', url: 'https://example.com/post/1?utm_source=weibo', domain: 'example.com', citationFragments: [], citationOccurrences: 3 }],
    });
    const data = repository.getBrandOwnedLinks(brand.id, { days: 30 });
    assert.equal(data.summary.links, 1);
    assert.equal(data.summary.citedLinks, 1);
    assert.equal(data.summary.coverageRate, 100);
    assert.equal(data.summary.citationCount, 1);
    assert.equal(data.summary.citationOccurrences, 3);
    assert.equal(data.links[0].id, link.id);
    assert.equal(data.links[0].title, '我们的文章');
    assert.deepEqual(data.links[0].platforms, ['deepseek']);
    assert.equal(data.links[0].details.length, 1);
  });
});

test('新增自有链接后可以回算历史引用', async () => {
  await withRepository(async (repository) => {
    const brand = repository.createBrand({ name: '千威' });
    await seedAnswer(repository, brand.id, {
      citations: [{ position: 1, title: '我们的文章', url: 'https://example.com/post/1', domain: 'example.com', citationFragments: [], citationOccurrences: 1 }],
    });
    // 采集时还没有这条链接，历史引用一开始不会被标记。
    assert.equal(repository.getBrandOwnedLinks(brand.id, { days: 30 }).summary.citedLinks, 0);
    repository.createBrandLink(brand.id, { url: 'https://example.com/post/1' });
    const result = repository.recomputeBrandLinkCitations(brand.id);
    assert.equal(result.matched, 1);
    assert.equal(repository.getBrandOwnedLinks(brand.id, { days: 30 }).summary.citedLinks, 1);
  });
});

test('自有链接统计区分被引用与未被引用，并支持平台筛选', async () => {
  await withRepository(async (repository) => {
    const brand = repository.createBrand({ name: '千威' });
    repository.createBrandLink(brand.id, { url: 'https://example.com/post/1' });
    repository.createBrandLink(brand.id, { url: 'https://example.com/post/2' });
    repository.createBrandLink(brand.id, { url: 'https://example.com/post/3' });
    await seedAnswer(repository, brand.id, {
      platform: 'kimi',
      citations: [{ position: 1, title: '我们的文章', url: 'https://example.com/post/1', domain: 'example.com', citationFragments: [], citationOccurrences: 1 }],
    });
    const data = repository.getBrandOwnedLinks(brand.id, { days: 30 });
    assert.equal(data.summary.links, 3);
    assert.equal(data.summary.citedLinks, 1);
    assert.equal(data.summary.unreferencedLinks, 2);
    assert.equal(data.summary.coverageRate, 33.3);
    assert.equal(data.summary.platformCount, 1);
    assert.equal(data.links.filter((item) => !item.cited).length, 2);

    const byPlatform = repository.getBrandOwnedLinks(brand.id, { days: 30, platformId: 'deepseek' });
    assert.equal(byPlatform.summary.citedLinks, 0);
    assert.equal(byPlatform.summary.links, 3);
  });
});

test('删除自有链接会同时清掉引用上的标记', async () => {
  await withRepository(async (repository) => {
    const brand = repository.createBrand({ name: '千威' });
    const link = repository.createBrandLink(brand.id, { url: 'https://example.com/post/1' });
    await seedAnswer(repository, brand.id, {
      citations: [{ position: 1, title: '我们的文章', url: 'https://example.com/post/1', domain: 'example.com', citationFragments: [], citationOccurrences: 1 }],
    });
    repository.deleteBrandLink(link.id);
    assert.equal(repository.listBrandLinks(brand.id).length, 0);
    assert.equal(repository.getBrandOwnedLinks(brand.id, { days: 30 }).summary.citedLinks, 0);
  });
});