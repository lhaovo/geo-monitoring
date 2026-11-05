import assert from 'node:assert/strict';
import test from 'node:test';
import { createChatPlatformAdapter, extractShareUrl } from '../scripts/lib/platforms/base.mjs';
import { getPlatformAdapter } from '../scripts/lib/platforms/index.mjs';

function fakePage(content) {
  const candidate = {
    async isVisible() { return true; },
    async innerText() { return content; },
  };
  return {
    locator() {
      return {
        async count() { return 1; },
        nth() { return candidate; },
      };
    },
    async waitForTimeout() {},
  };
}

test('allows platforms to accept concise but complete answers', async () => {
  const adapter = createChatPlatformAdapter({
    id: 'test',
    label: 'Test',
    entryUrl: 'https://example.com/chat',
    responseSelectors: ['.answer'],
    minimumAnswerLength: 1,
  });
  const answer = await adapter.waitForAnswer(fakePage('短答'), { timeoutMs: 1_000, stableForMs: 0 });
  assert.equal(answer, '短答');
});
test('configures Wenxiaoyan with SMS login and the Baidu entry page', () => {
  const adapter = getPlatformAdapter('wenxiaoyan');
  assert.equal(adapter.loginMethod, 'sms_code');
  assert.equal(adapter.defaultMode, 'headless');
  assert.equal(adapter.entryUrl, 'https://wenxin.baidu.com/');
});

test('extracts a share URL from plain and labeled clipboard text', () => {
  assert.equal(
    extractShareUrl('https://www.kimi.com/share/example'),
    'https://www.kimi.com/share/example',
  );
  assert.equal(
    extractShareUrl('??????https://qianwen.my.cn/share/chat/example?from=app'),
    'https://qianwen.my.cn/share/chat/example?from=app',
  );
});

test('trims trailing punctuation without damaging a valid share URL', () => {
  assert.equal(
    extractShareUrl('?????https://www.doubao.com/thread/example?'),
    'https://www.doubao.com/thread/example',
  );
  assert.equal(
    extractShareUrl('https://www.kimi.com/share/example),'),
    'https://www.kimi.com/share/example',
  );
});

test('rejects text that is not an HTTP share URL', () => {
  assert.equal(extractShareUrl('????'), null);
  assert.equal(extractShareUrl('file:///tmp/share.html'), null);
  assert.equal(
    extractShareUrl('https://example.com/not-a-share', /kimi\.com\/share\//u),
    null,
  );
});

test('decodes JSON-escaped share URLs', () => {
  assert.equal(
    extractShareUrl('{"short_url":"https://mr.baidu.com/r/example?f=ot\\u0026u=abc"}'),
    'https://mr.baidu.com/r/example?f=ot&u=abc',
  );
});
