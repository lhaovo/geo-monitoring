import { createChatPlatformAdapter } from '../base.js';

export const yuanbaoAdapter = createChatPlatformAdapter({
  id: 'yuanbao',
  label: '腾讯元宝',
  entryUrl: 'https://yuanbao.tencent.com/chat/',
  defaultMode: 'headless',
  shareFlow: {
    triggerSelectors: ['[aria-label="分享"]', 'div[aria-label="分享"]', 'button[aria-label*="分享"]', '[role=button][aria-label*="分享"]', 'button[title*="分享"]'],
    triggerLabels: ['分享'],
    selectAllSelectors: ['input[type=checkbox]', 'label:has-text("全选")'],
    selectAllLabels: ['全选'],
    copySelectors: ['[data-share-type="link"]', '[aria-label="复制链接"]', 'button:has-text("复制链接")'],
    copyLabels: ['复制链接', '生成链接'],
    linkSelectors: ['input[readonly]', 'textarea[readonly]', 'a[href*="yuanbao"]', 'a[href*="tencent.com"]'],
    closeSelectors: ['button:has-text("取消")'],
    closeLabels: ['取消'],
    urlPattern: /https?:\/\/(?:yuanbao\.tencent\.com|yb\.tencent\.com)\//u,
  },
  responseSelectors: [
    '[data-conv-speaker=ai][data-conv-status=finished] .hyc-content-md-done',
    '[data-conv-speaker=ai] .agent-chat__speech-card__text',
    '[data-message-role=assistant]',
    '[data-role=assistant]',
    '[class*=assistant-message]',
    '[class*=markdown]',
    '[class*=message-content]',
  ],
});
