import { existsSync } from 'node:fs';

export function browserCandidates({ localAppData = process.env.LOCALAPPDATA } = {}) {
  return [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    localAppData && `${localAppData}\\Google\\Chrome\\Application\\chrome.exe`,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ].filter(Boolean);
}

export function resolveBrowserExecutable({
  configuredPath = process.env.GEO_BROWSER_PATH,
  candidates = browserCandidates(),
  exists = existsSync,
} = {}) {
  const allCandidates = configuredPath ? [configuredPath, ...candidates] : candidates;
  const executablePath = allCandidates.find((candidate) => exists(candidate));

  if (!executablePath) {
    throw new Error(
      'No local Chrome or Edge executable was found. Install one or set GEO_BROWSER_PATH to its executable path.',
    );
  }

  return executablePath;
}

// 反自动化检测参数。
//
// Blink 的 AutomationControlled 特性会让 navigator.webdriver 直接返回 true，
// 平台的指纹采集（阿里的 x5sec、网易易盾等）据此判定浏览器被脚本控制，
// 滑块 / 点选验证码即使人工操作，也会被服务端拒收（error:InYHba）。
// 关掉该特性后由 Chromium 原生返回 false：页面探针看到的 getter 仍是 [native code]，
// 与真实 Chrome 完全一致，不会因为「用 JS 造假值」而留下可被识破的破绽。
//
// 登录窗口与监控执行共用同一份浏览器用户目录，两处都要加，否则指纹前后不一致。
export const ANTI_AUTOMATION_ARGS = ['--disable-blink-features=AutomationControlled'];

// 所有平台共用的浏览器启动参数。
// 监控执行与人工登录用的是同一份浏览器用户目录（data/profiles/<平台>/<账号>/chrome），
// 指纹必须前后一致，所以参数只在这里维护一处，两边都从这里取。
export function browserLaunchOptions({ headless }) {
  return {
    executablePath: resolveBrowserExecutable(),
    headless,
    viewport: { width: 1440, height: 960 },
    args: [...ANTI_AUTOMATION_ARGS],
  };
}
