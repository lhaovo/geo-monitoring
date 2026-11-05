import { createChatPlatformAdapter } from '../base.js';

export const wenxiaoyanAdapter = createChatPlatformAdapter({
  id: 'wenxiaoyan',
  label: '文小言',
  entryUrl: 'https://wenxin.baidu.com/',
  defaultMode: 'headless',
  loginState: {
    loginPromptSelectors: ['div[class*="_login-btn_"]'],
    loginPromptTextPattern: /(?:请登录|登录同步历史对话)/u,
  },
  shareFlow: {
    hoverSelectors: ['.cosd-markdown-content', '.cs-answer-container'],
    triggerSelectors: ['[data-testid="menu-btn-share"]'],
    triggerLabels: ['分享'],
    selectAllSelectors: ['label:has-text("全选")', '._checkbox_1jf3l_17'],
    selectAllLabels: ['全选'],
    copySelectors: ['button:has-text("复制链接")'],
    copyLabels: ['复制链接', '生成链接'],
    linkSelectors: ['input[readonly]', 'textarea[readonly]', 'a[href*="mr.baidu.com"]'],
    closeSelectors: ['button:has-text("取消")'],
    closeLabels: ['取消'],
    urlPattern: /https?:\/\/(?:mr\.baidu\.com|wenxin\.baidu\.com)\//u,
    clipboardTimeoutMs: 30_000,
  },
  // 文小言在回答完成后才把 data-status 置为 COMPLETE，单纯的 markdown 长度
  // 不足以判断流式输出已经结束，因此额外等待完成标记并放宽整体超时。
  answerCompleteSelectors: ['.cs-answer-container[data-status="COMPLETE"]'],
  minimumAnswerTimeoutMs: 600_000,
  responseSelectors: [
    '.cs-answer-container[data-status="COMPLETE"] .cosd-markdown-content',
    '.cosd-markdown-content',
    '[data-role=assistant]',
    '[class*=assistant-message]',
    '[class*=answer-content]',
    '[class*=markdown]',
    '[class*=message-content]',
    '[class*=chat-message]',
  ],
});
