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
    /Unsupported platform "unknown"\. Supported platforms: deepseek, doubao, kimi/,
  );
});
