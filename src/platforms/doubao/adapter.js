import { createChatPlatformAdapter } from '../base.js';

export const doubaoAdapter = createChatPlatformAdapter({
  id: 'doubao',
  label: '豆包',
  entryUrl: 'https://www.doubao.com/chat/',
  defaultMode: 'headed',
  shareFlow: {
    hoverSelectors: ['[data-testid="message_content"]', '[data-testid="receive_message"]'],
    triggerSelectors: ['[data-testid="message_action_share"]:visible'],
    triggerLabels: ['分享'],
    selectAllSelectors: ['label:has-text("全选")', '[role=checkbox]:visible'],
    selectAllLabels: ['全选'],
    copySelectors: ['[data-testid="thread_share_copy_btn"]'],
    copyLabels: ['复制链接', '生成链接'],
    linkSelectors: ['input[readonly]', 'textarea[readonly]', 'a[href*="/thread/"]'],
    closeSelectors: ['button:has-text("取消")'],
    closeLabels: ['取消'],
    urlPattern: /https?:\/\/(?:www\.)?doubao\.com\/thread\//u,
  },
  responseSelectors: [
    '[class*=markdown]',
    '[class*=message-content]',
    '[class*=bot-message]',
    // Current Doubao chat renders each assistant block this way. A completed
    // block has data-streaming="false" and does not use a markdown class.
    '[data-message-id] [data-container-type=block-v2] [data-streaming=false]',
    '[data-message-id] [data-container-type=block-v2]',
  ],
});
