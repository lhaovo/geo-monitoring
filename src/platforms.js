export const PLATFORMS = Object.freeze({
  deepseek: Object.freeze({
    id: 'deepseek',
    label: 'DeepSeek',
    entryUrl: 'https://chat.deepseek.com/',
  }),
  doubao: Object.freeze({
    id: 'doubao',
    label: '豆包',
    entryUrl: 'https://www.doubao.com/chat/',
  }),
  kimi: Object.freeze({
    id: 'kimi',
    label: 'Kimi',
    entryUrl: 'https://www.kimi.com/',
  }),
});

export function getPlatform(id) {
  const platform = PLATFORMS[id];

  if (!platform) {
    const supported = Object.keys(PLATFORMS).join(', ');
    throw new Error(`Unsupported platform "${id}". Supported platforms: ${supported}`);
  }

  return platform;
}
