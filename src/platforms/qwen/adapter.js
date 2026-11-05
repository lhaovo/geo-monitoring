import { createChatPlatformAdapter } from '../base.js';

export const qwenAdapter = createChatPlatformAdapter({
  id: 'qwen',
  label: '千问',
  entryUrl: 'https://www.qianwen.com/',
  defaultMode: 'headless',
  shareFlow: {
    hoverSelectors: ['[data-answer-feedback-toolbar="true"]', '.qk-markdown-complete', '.chat-answers-card-wrap', '[class*=answer-card]'],
    triggerSelectors: ['[data-answer-feedback-toolbar="true"] > div > div.flex.size-6.cursor-pointer:nth-child(4)', 'button[aria-label*="分享"]', '[role=button][aria-label*="分享"]', 'button[title*="分享"]'],
    triggerLabels: ['分享'],
    selectAllSelectors: ['.share-selection-oLUKAD', 'label:has-text("全选")'],
    selectAllLabels: ['全选'],
    copySelectors: ['button:has-text("复制链接")'],
    copyLabels: ['复制链接', '生成链接'],
    linkSelectors: ['a[href*="qianwen.my.cn/share/chat/"]', 'input[readonly]', 'textarea[readonly]'],
    closeSelectors: ['button:has-text("取消")'],
    closeLabels: ['取消'],
    urlPattern: /https?:\/\/(?:qianwen\.my\.cn|www\.qianwen\.com)\/share\/chat\//u,
  },
  responseSelectors: [
    '[data-message-role=assistant]',
    '[data-role=assistant]',
    '[class*=assistant-message]',
    '[class*=answer-content]',
    '[class*=markdown]',
    '[class*=message-content]',
  ],
});
