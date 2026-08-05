import { createChatPlatformAdapter } from '../base.js';

export const yuanbaoAdapter = createChatPlatformAdapter({
  id: 'yuanbao',
  label: '腾讯元宝',
  entryUrl: 'https://yuanbao.tencent.com/chat/',
  responseSelectors: [
    '[data-conv-speaker="ai"][data-conv-status="finished"] .hyc-content-md-done',
    '[data-conv-speaker="ai"] .agent-chat__speech-card__text',
    '[data-message-role="assistant"]',
    '[data-role="assistant"]',
    '[class*="assistant-message"]',
    '[class*="markdown"]',
    '[class*="message-content"]',
  ],
});
