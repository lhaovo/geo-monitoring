import { existsSync } from 'node:fs';

export function browserCandidates({ localAppData = process.env.LOCALAPPDATA } = {}) {
  return [
    process.env.GEO_BROWSER_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    localAppData && `${localAppData}\\Google\\Chrome\\Application\\chrome.exe`,
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);
}

export function resolveBrowserExecutable(configuredPath) {
  const candidates = [configuredPath, ...browserCandidates()].filter(Boolean);
  const executablePath = candidates.find((candidate) => existsSync(candidate));
  if (!executablePath) {
    throw new Error('Chrome or Edge was not found. Set GEO_BROWSER_PATH or pass --browser with the executable path.');
  }
  return executablePath;
}

export function isLikelyProfileLock(error) {
  return /user data directory|profile|process singleton|target page, context or browser has been closed/iu.test(String(error?.message ?? error));
}
