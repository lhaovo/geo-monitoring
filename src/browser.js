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
