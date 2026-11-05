import { deepseekAdapter } from './deepseek/adapter.js';
import { doubaoAdapter } from './doubao/adapter.js';
import { kimiAdapter } from './kimi/adapter.js';
import { qwenAdapter } from './qwen/adapter.js';
import { wenxiaoyanAdapter } from './wenxiaoyan/adapter.js';
import { yuanbaoAdapter } from './yuanbao/adapter.js';
import { ValidationError } from '../shared/errors.js';

const adapters = Object.freeze({
  deepseek: deepseekAdapter,
  doubao: doubaoAdapter,
  kimi: kimiAdapter,
  qwen: qwenAdapter,
  wenxiaoyan: wenxiaoyanAdapter,
  yuanbao: yuanbaoAdapter,
});

export function listPlatformAdapters() {
  return Object.values(adapters);
}

export function getPlatformAdapter(platformId) {
  const adapter = adapters[platformId];
  if (!adapter) throw new ValidationError(`不支持的平台：${platformId}。`);
  return adapter;
}
