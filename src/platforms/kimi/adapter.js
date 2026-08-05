import { createChatPlatformAdapter } from '../base.js';

export const kimiAdapter = createChatPlatformAdapter({
  id: 'kimi',
  label: 'Kimi',
  entryUrl: 'https://www.kimi.com/',
  responseSelectors: ['[class*="markdown"]', '[data-message-id]', '[class*="message-content"]'],
});
