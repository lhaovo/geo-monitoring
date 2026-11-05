import assert from 'node:assert/strict';
import test from 'node:test';
import { getPlatform } from '../src/platforms.js';

test('returns DeepSeek configuration with its chat entry URL', () => {
  assert.deepEqual(getPlatform('deepseek'), {
    id: 'deepseek',
    label: 'DeepSeek',
    entryUrl: 'https://chat.deepseek.com/',
  });
});

test('rejects an unsupported platform with the supported ids', () => {
  assert.throws(
    () => getPlatform('unknown'),
    /Unsupported platform "unknown"\. Supported platforms: deepseek, doubao, kimi, qwen, wenxiaoyan, yuanbao/,
  );
});

test('returns Qwen and Yuanbao web entry URLs', () => {
  assert.equal(getPlatform('qwen').entryUrl, 'https://www.qianwen.com/');
  assert.equal(getPlatform('yuanbao').entryUrl, 'https://yuanbao.tencent.com/chat/');
});
