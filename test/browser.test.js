import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveBrowserExecutable } from '../src/browser.js';
import { describeAuthentication } from '../src/login/authentication.js';

test('uses a configured browser before detected candidates', () => {
  const executable = resolveBrowserExecutable({
    configuredPath: 'D:\\portable\\chrome.exe',
    candidates: ['C:\\Chrome\\chrome.exe'],
    exists: (candidate) => candidate === 'D:\\portable\\chrome.exe',
  });

  assert.equal(executable, 'D:\\portable\\chrome.exe');
});

test('reports a helpful error when no supported browser is available', () => {
  assert.throws(
    () => resolveBrowserExecutable({ candidates: ['C:\\missing.exe'], exists: () => false }),
    /No local Chrome or Edge executable was found/,
  );
});

test('does not treat a successful login callback query as a login page', () => {
  assert.equal(
    describeAuthentication('https://www.doubao.com/chat/?from_login=1'),
    'manual_review_required',
  );
  assert.equal(
    describeAuthentication('https://chat.deepseek.com/sign_in'),
    'login_flow_detected',
  );
});
