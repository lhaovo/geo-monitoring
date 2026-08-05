import { createChatPlatformAdapter } from '../base.js';

export const doubaoAdapter = createChatPlatformAdapter({
  id: 'doubao',
  label: '豆包',
  entryUrl: 'https://www.doubao.com/chat/',
  responseSelectors: [
    '[class*="markdown"]',
    '[class*="message-content"]',
    '[class*="bot-message"]',
    // Current Doubao chat renders each assistant block this way. A completed
    // block has data-streaming="false" and does not use a markdown class.
    '[data-message-id] [data-container-type="block-v2"] [data-streaming="false"]',
    '[data-message-id] [data-container-type="block-v2"]',
  ],
});
