import { createChatPlatformAdapter } from './base.mjs';
import { kimiAdapter } from './kimi.mjs';

const deepseekAdapter = createChatPlatformAdapter({
  id: 'deepseek',
  label: 'DeepSeek',
  entryUrl: 'https://chat.deepseek.com/',
  loginMethod: 'password',
  defaultMode: 'headless',
  loginTriggerLabels: ['登录', '立即登录'],
  loginMethodLabels: ['密码登录', '账号密码登录', '使用密码登录'],
  loginFlow: {
    loginTriggerSelectors: ['button:has-text("登录")', '[role=button]:has-text("登录")'],
    loginMethodSelectors: ['button:has-text("密码登录")', '[role=button]:has-text("密码登录")'],
    accountInputSelectors: [
      'input[type="text"][placeholder*="手机号/邮箱"]',
      'input[type="text"][placeholder*="邮箱"]',
      'input[type="text"][placeholder*="手机"]',
    ],
    passwordInputSelectors: ['input[type="password"]'],
    submitSelectors: [
      '.ds-sign-in-form .ds-button--primary',
      '.ds-sign-in-form [role="button"][class*="primary"]',
      '.ds-button--primary.ds-button--filled',
    ],
    submitLabels: ['登录'],
  },
  shareFlow: {
    // DeepSeek hides the native share entry entirely while the account is muted.
    triggerSelectors: [
      'div[role=button][aria-label="\u6717\u8bfb"] ~ div[role=button]',
      'div[role=button][aria-label="\u505c\u6b62\u6717\u8bfb"] ~ div[role=button]',
    ],
    selectAllSelectors: [
      'label:has-text("\u5168\u9009")',
      '[role=checkbox]:has-text("\u5168\u9009")',
    ],
    selectAllLabels: ['\u5168\u9009'],
    prepareSelectors: [
      '[role=button]:has-text("\u521b\u5efa\u5206\u4eab\u94fe\u63a5")',
      'button:has-text("\u521b\u5efa\u5206\u4eab\u94fe\u63a5")',
    ],
    prepareLabels: ['\u521b\u5efa\u5206\u4eab\u94fe\u63a5'],
    copySelectors: [
      '[role=button]:has-text("\u521b\u5efa\u5e76\u590d\u5236")',
      'button:has-text("\u521b\u5efa\u5e76\u590d\u5236")',
    ],
    copyLabels: ['\u521b\u5efa\u5e76\u590d\u5236'],
    linkSelectors: [
      '.ds-copyable-text-line',
      '[role=dialog]',
      'input[readonly]',
      'textarea[readonly]',
    ],
    closeSelectors: ['[role=dialog] [aria-label="\u5173\u95ed"]'],
    closeLabels: ['\u53d6\u6d88'],
    urlPattern: /https?:\/\/chat\.deepseek\.com\/share\//u,
    clipboardTimeoutMs: 20_000,
  },
  responseSelectors: ['.ds-markdown', '[class*=markdown]', '[class*=message-content]'],
  minimumAnswerLength: 4,
});

const doubaoAdapter = createChatPlatformAdapter({
  id: 'doubao',
  label: '豆包',
  entryUrl: 'https://www.doubao.com/chat/',
  loginMethod: 'sms_code',
  defaultMode: 'headed',
  loginTriggerLabels: ['登录', '立即登录'],
  loginMethodLabels: ['验证码登录', '手机号登录', '短信登录'],
  loginFlow: {
    loginTriggerSelectors: ['button.login-btn-header-CTKsn1', 'button:has-text("登录")'],
    loginMethodSelectors: ['button:has-text("手机号登录")'],
    phoneInputSelectors: ['input[placeholder="请输入手机号"]', 'input[placeholder*="手机号"]'],
    codeInputSelectors: [
      'input[placeholder="\u8bf7\u8f93\u5165\u9a8c\u8bc1\u7801"]',
      'input[placeholder*="\u9a8c\u8bc1\u7801"]',
      'input.semi-input[inputmode="decimal"]:not([placeholder="\u8bf7\u8f93\u5165\u624b\u673a\u53f7"])',
      'input.semi-input:not([placeholder="\u8bf7\u8f93\u5165\u624b\u673a\u53f7"])',
      'input[inputmode="decimal"]:not([placeholder="\u8bf7\u8f93\u5165\u624b\u673a\u53f7"])',
    ],
    agreementSelectors: ['button[role=checkbox]', '[data-slot=checkbox]', '[class*=login] input[type=checkbox]', 'input[type=checkbox]'],
    nextStepSelectors: ['button:has-text("下一步")'],
    nextStepLabels: ['下一步'],
    requestSmsSelectors: ['button:has-text("获取验证码")', 'a:has-text("获取验证码")'],
    requestSmsLabels: ['获取验证码', '发送验证码', '重新获取'],
    submitSelectors: ['button:has-text("登录")'],
    submitLabels: ['登录', '验证'],
  },
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
    '[data-message-id] [data-container-type=block-v2] [data-streaming=false]',
    '[data-message-id] [data-container-type=block-v2]',
  ],
});

const qwenAdapter = createChatPlatformAdapter({
  id: 'qwen',
  label: '千问',
  entryUrl: 'https://www.qianwen.com/',
  loginMethod: 'sms_code',
  defaultMode: 'headless',
  loginTriggerLabels: ['登录', '立即登录'],
  loginMethodLabels: ['验证码登录', '手机号登录', '短信登录'],
  loginFlow: {
    loginTriggerSelectors: ['button:has-text("登录")', '[role=button]:has-text("登录")'],
    loginMethodSelectors: ['button:has-text("手机号登录")', 'button:has-text("验证码登录")'],
    phoneInputSelectors: ['input[name="fm-sms-login-id"]', 'input[placeholder*="手机号"]'],
    codeInputSelectors: ['input[name="fm-smscode"]', 'input[placeholder*="验证码"]'],
    agreementSelectors: ['input[name="fm-agreement-checkbox"]', '#fm-agreement-checkbox'],
    consentSelectors: [
      '[role=dialog] button:text-is("同意")',
      '[class*=dialog] button:text-is("同意")',
      '[class*=modal] button:text-is("同意")',
      'button:text-is("同意")',
      '[role=button]:text-is("同意")',
    ],
    consentLabels: ['同意'],
    requestSmsSelectors: ['a.send-btn-link'],
    requestSmsLabels: ['获取验证码', '发送验证码', '重新获取'],
    submitSelectors: ['button.fm-button.fm-submit.sms-login'],
    submitLabels: ['登录', '验证'],
  },
  shareFlow: {
    hoverSelectors: ['[data-answer-feedback-toolbar="true"]', '.qk-markdown-complete', '.chat-answers-card-wrap', '[class*=answer-card]'],
    triggerSelectors: ['[data-answer-feedback-toolbar="true"] > div > div.flex.size-6.cursor-pointer:nth-child(4)', 'button[aria-label*="??"]', '[role=button][aria-label*="??"]', 'button[title*="??"]'],
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

const wenxiaoyanAdapter = createChatPlatformAdapter({
  id: 'wenxiaoyan',
  label: '文小言',
  entryUrl: 'https://wenxin.baidu.com/',
  loginMethod: 'sms_code',
  defaultMode: 'headless',
  loginTriggerLabels: ['登录', '立即登录'],
  loginMethodLabels: ['短信登录'],
  loginState: {
    loginPromptSelectors: ['div[class*="_login-btn_"]'],
    loginPromptTextPattern: /(?:请登录|登录同步历史对话)/u,
  },
  loginFlow: {
    loginTriggerSelectors: ['div[class*="_login-btn_"]', 'button:has-text("登录")', 'div:has-text("登录")'],
    loginMethodSelectors: ['#TANGRAM__PSP_11__changeSmsCodeItem', 'span:has-text("短信登录")'],
    phoneInputSelectors: ['#TANGRAM__PSP_11__smsPhone', 'input[name="username"][placeholder*="手机号"]'],
    codeInputSelectors: ['#TANGRAM__PSP_11__smsVerifyCode', 'input[name="password"][placeholder*="验证码"]'],
    agreementSelectors: ['#TANGRAM__PSP_11__smsIsAgree', 'input[name="smsIsAgree"]'],
    requestSmsSelectors: ['#TANGRAM__PSP_11__smsTimer', 'button:has-text("发送验证码")'],
    requestSmsLabels: ['发送验证码', '获取验证码', '重新发送'],
    submitSelectors: ['#TANGRAM__PSP_11__smsSubmit', 'input[type=submit]'],
    submitLabels: ['登录', '验证'],
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

const yuanbaoAdapter = createChatPlatformAdapter({
  id: 'yuanbao',
  label: '腾讯元宝',
  entryUrl: 'https://yuanbao.tencent.com/chat/',
  loginMethod: 'sms_code',
  defaultMode: 'headless',
  loginTriggerLabels: ['登录', '立即登录'],
  loginMethodLabels: ['手机号登录', '手机登录', '验证码登录', '手机'],
  loginFlow: {
    loginTriggerSelectors: ['button:has-text("登录")', '[role=button]:has-text("登录")'],
    loginMethodSelectors: ['button:has-text("手机号登录")', 'button:has-text("手机")'],
    phoneInputSelectors: ['input[placeholder="请输入手机号"]', 'input[type="tel"]'],
    codeInputSelectors: ['input[placeholder="请输入验证码"]', 'input[placeholder*="验证码"]'],
    agreementSelectors: ['input[type="checkbox"].t-checkbox__former', 'input[type=checkbox]'],
    requestSmsSelectors: ['a.hyc-phone-login__send-code'],
    requestSmsLabels: ['获取验证码', '发送验证码', '重新获取'],
    submitSelectors: ['button.hyc-phone-login__btn'],
    submitLabels: ['登录', '验证'],
  },
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

const adapters = Object.freeze({
  deepseek: deepseekAdapter,
  doubao: doubaoAdapter,
  kimi: kimiAdapter,
  qwen: qwenAdapter,
  wenxiaoyan: wenxiaoyanAdapter,
  yuanbao: yuanbaoAdapter,
});

export function getPlatformAdapter(platformId) {
  const adapter = adapters[platformId];
  if (!adapter) throw new Error(`Unsupported platform: ${platformId}.`);
  return adapter;
}

export function listPlatformAdapters() {
  return Object.values(adapters);
}
