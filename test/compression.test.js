import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { gunzipSync } from 'node:zlib';
import { buildServer } from '../src/api/server.js';

// 任务详情 JSON 单次可达数 MB、证据 HTML 可达 1 MB 以上，
// 而前端在任务运行期间每 2.5 秒就会拉一次任务详情。
// 不压缩的话浏览器要反复下载几十 MB，压缩后能省掉 3~6 倍带宽。
test('接口响应按 Accept-Encoding 压缩，解压后与原文一致', async () => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), 'geo-compress-'));
  const app = await buildServer({ dataDirectory });
  try {
    const plain = await app.inject({
      method: 'GET', url: '/api/platforms/status', headers: { 'accept-encoding': 'identity' },
    });
    assert.equal(plain.statusCode, 200);
    assert.equal(plain.headers['content-encoding'], undefined);
    assert.ok(plain.rawPayload.length > 1024, '样本需大于压缩阈值，否则测不出压缩效果');

    const compressed = await app.inject({
      method: 'GET', url: '/api/platforms/status', headers: { 'accept-encoding': 'gzip' },
    });
    assert.equal(compressed.statusCode, 200);
    assert.equal(compressed.headers['content-encoding'], 'gzip');
    assert.deepEqual(
      JSON.parse(gunzipSync(compressed.rawPayload).toString('utf8')),
      JSON.parse(plain.body),
    );
    assert.ok(compressed.rawPayload.length < plain.rawPayload.length, '压缩后的体积应当更小');
  } finally {
    await app.close();
    await rm(dataDirectory, { recursive: true, force: true });
  }
});

// 证据文件由 @fastify/static 直接吐给浏览器，压缩插件的 onSend 钩子
// 同样会作用在它上面。压缩后必须同步处理 content-length：
// 留着压缩前的长度，浏览器会一直等数据，页面直接卡住。
test('静态证据文件同样被压缩，且 content-length 与实际长度一致', async () => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), 'geo-compress-'));
  const artifacts = path.join(dataDirectory, 'artifacts', 'run-1');
  await mkdir(artifacts, { recursive: true });
  const html = `<!doctype html><html><body>${'<p>采集证据正文内容</p>'.repeat(2000)}</body></html>`;
  await writeFile(path.join(artifacts, 'answer.html'), html, 'utf8');

  const app = await buildServer({ dataDirectory });
  try {
    const plain = await app.inject({
      method: 'GET', url: '/artifacts/run-1/answer.html', headers: { 'accept-encoding': 'identity' },
    });
    assert.equal(plain.statusCode, 200);
    assert.equal(plain.headers['content-encoding'], undefined);
    assert.equal(plain.rawPayload.toString('utf8'), html);

    const compressed = await app.inject({
      method: 'GET', url: '/artifacts/run-1/answer.html', headers: { 'accept-encoding': 'gzip' },
    });
    assert.equal(compressed.statusCode, 200);
    assert.equal(compressed.headers['content-encoding'], 'gzip');
    assert.equal(gunzipSync(compressed.rawPayload).toString('utf8'), html, '解压后应与原文完全一致');
    assert.ok(compressed.rawPayload.length < plain.rawPayload.length, '压缩后的体积应当更小');

    const declared = compressed.headers['content-length'];
    assert.ok(
      declared === undefined || Number(declared) === compressed.rawPayload.length,
      `content-length 不能保留压缩前的长度（实际 ${declared}，压缩体 ${compressed.rawPayload.length}）`,
    );
  } finally {
    await app.close();
    await rm(dataDirectory, { recursive: true, force: true });
  }
});