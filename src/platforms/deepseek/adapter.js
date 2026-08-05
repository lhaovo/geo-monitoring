import { createChatPlatformAdapter } from '../base.js';

export const deepseekAdapter = createChatPlatformAdapter({
  id: 'deepseek',
  label: 'DeepSeek',
  entryUrl: 'https://chat.deepseek.com/',
  responseSelectors: ['.ds-markdown', '[class*="markdown"]', '[class*="message-content"]'],
});
