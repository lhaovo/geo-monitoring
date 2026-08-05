import { createChatPlatformAdapter } from '../base.js';

export const qwenAdapter = createChatPlatformAdapter({
  id: 'qwen',
  label: '千问',
  entryUrl: 'https://www.qianwen.com/',
  responseSelectors: [
    '[data-message-role="assistant"]',
    '[data-role="assistant"]',
    '[class*="assistant-message"]',
    '[class*="answer-content"]',
    '[class*="markdown"]',
    '[class*="message-content"]',
  ],
});
