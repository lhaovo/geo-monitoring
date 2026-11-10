import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
import { ANTI_AUTOMATION_ARGS, browserLaunchOptions } from '../src/browser.js';

test('反自动化参数包含 AutomationControlled 开关', () => {
  assert.deepEqual(ANTI_AUTOMATION_ARGS, ['--disable-blink-features=AutomationControlled']);
});

test('启动参数对有头 / 无头模式都带上反自动化参数', () => {
  for (const headless of [true, false]) {
    const options = browserLaunchOptions({ headless });
    assert.equal(options.headless, headless);
    assert.ok(options.args.includes('--disable-blink-features=AutomationControlled'));
  }
});

// 平台风控会采集 navigator.webdriver 判断浏览器是否被脚本控制。
// 用 JS 覆盖虽然也能改成 false，但 getter 源码会暴露成 JS 函数，一行代码即可识破；
// Chromium 原生参数返回的是原生实现，与真实 Chrome 一致。
test('浏览器对外表现为非自动化环境', async () => {
  const browser = await chromium.launch(browserLaunchOptions({ headless: true }));
  try {
    const page = await browser.newPage();
    await page.goto('about:blank');
    const probe = await page.evaluate(() => ({
      webdriver: navigator.webdriver,
      getterSource: Object.getOwnPropertyDescriptor(Navigator.prototype, 'webdriver').get.toString(),
    }));
    assert.equal(probe.webdriver, false);
    assert.match(probe.getterSource, /\[native code\]/);
  } finally {
    await browser.close();
  }
});