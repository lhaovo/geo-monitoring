import assert from 'node:assert/strict';
import test from 'node:test';
import { getPlatformAdapter, listPlatformAdapters } from '../src/platforms/index.js';

test('returns DeepSeek configuration with its chat entry URL', () => {
  const deepseek = getPlatformAdapter('deepseek');
  assert.equal(deepseek.id, 'deepseek');
  assert.equal(deepseek.label, 'DeepSeek');
  assert.equal(deepseek.entryUrl, 'https://chat.deepseek.com/');
});

test('rejects an unsupported platform', () => {
  assert.throws(() => getPlatformAdapter('unknown'), /不支持的平台：unknown/);
});

test('returns Qwen and Yuanbao web entry URLs', () => {
  assert.equal(getPlatformAdapter('qwen').entryUrl, 'https://www.qianwen.com/');
  assert.equal(getPlatformAdapter('yuanbao').entryUrl, 'https://yuanbao.tencent.com/chat/');
});

test('registers all six supported platforms', () => {
  assert.deepEqual(
    listPlatformAdapters().map((adapter) => adapter.id).sort(),
    ['deepseek', 'doubao', 'kimi', 'qwen', 'wenxiaoyan', 'yuanbao'],
  );
});
