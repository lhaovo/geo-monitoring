import { createChatPlatformAdapter } from '../base.js';

export const deepseekAdapter = createChatPlatformAdapter({
  id: 'deepseek',
  label: 'DeepSeek',
  entryUrl: 'https://chat.deepseek.com/',
  defaultMode: 'headless',
  shareFlow: {
    // DeepSeek 在账号被静默时才会隐藏原生分享入口。
    triggerSelectors: [
      'div[role=button][aria-label="朗读"] ~ div[role=button]',
      'div[role=button][aria-label="停止朗读"] ~ div[role=button]',
    ],
    selectAllSelectors: ['label:has-text("全选")', '[role=checkbox]:has-text("全选")'],
    selectAllLabels: ['全选'],
    prepareSelectors: [
      '[role=button]:has-text("创建分享链接")',
      'button:has-text("创建分享链接")',
    ],
    prepareLabels: ['创建分享链接'],
    copySelectors: [
      '[role=button]:has-text("创建并复制")',
      'button:has-text("创建并复制")',
    ],
    copyLabels: ['创建并复制'],
    linkSelectors: ['.ds-copyable-text-line', '[role=dialog]', 'input[readonly]', 'textarea[readonly]'],
    closeSelectors: ['[role=dialog] [aria-label="关闭"]'],
    closeLabels: ['取消'],
    urlPattern: /https?:\/\/chat\.deepseek\.com\/share\//u,
    clipboardTimeoutMs: 20_000,
  },
  responseSelectors: ['.ds-markdown', '[class*=markdown]', '[class*=message-content]'],
  minimumAnswerLength: 4,
});
