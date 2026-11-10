// 自有内容链接的归一化与匹配。
//
// AI 回答里的引用 URL 往往和投稿时的原始链接不完全一致：协议、大小写、
// 末尾斜杠、以及 utm/spm/from 这类追踪参数都可能不同。
// 监测「我们自己的文章有没有被 AI 引用」时，必须先归一化再比对，
// 否则同一篇文章会因为一个追踪参数就统计不到。

// 常见的追踪参数：不参与文章身份，忽略后仍视为同一篇文章。
const TRACKING_PARAM = /^(utm_|spm|from$|ref$|src$|source$|share|scene|click|weibo|wechat|wxshare|share_|xhs)/i;

function decodePath(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

// 把任意写法的链接归一化成 { host, path, query, key, pathKey }。
// key 用于精确比对，pathKey 用于「同一篇文章 + 不同追踪参数」的宽松比对。
export function normalizeUrl(url) {
  const raw = String(url ?? '').trim();
  // 含空白的输入一定不是链接；域名必须带点，否则「不是链接」会被当成主机名。
  if (!raw || /\s/u.test(raw)) return null;
  let parsed;
  try {
    parsed = new URL(raw.includes('://') ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) return null;
  const host = parsed.hostname.toLowerCase().replace(/^www\./u, '');
  if (!host.includes('.') || !/^[a-z0-9.-]+$/u.test(host)) return null;
  const path = decodePath(parsed.pathname || '/').replace(/\/+$/u, '') || '/';
  const params = [...parsed.searchParams.entries()]
    .filter(([key]) => !TRACKING_PARAM.test(key))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`);
  const query = params.join('&');
  return {
    host,
    path,
    query,
    domain: host,
    key: `${host}${path}${query ? `?${query}` : ''}`,
    pathKey: `${host}${path}`,
  };
}

// 为一批自有链接建立索引，匹配时先精确后宽松。
export function buildLinkIndex(links = []) {
  const byKey = new Map();
  const byPathKey = new Map();
  for (const link of links) {
    if (!link) continue;
    if (link.normalizedUrl && !byKey.has(link.normalizedUrl)) byKey.set(link.normalizedUrl, link);
    if (link.pathKey && !byPathKey.has(link.pathKey)) byPathKey.set(link.pathKey, link);
  }
  return { byKey, byPathKey };
}

// 返回命中的自有链接；精确命中优先，其次是同路径（忽略追踪参数）。
export function matchOwnedLink(url, index) {
  if (!index) return null;
  const normalized = normalizeUrl(url);
  if (!normalized) return null;
  const exact = index.byKey.get(normalized.key);
  if (exact) return { link: exact, matchType: 'exact' };
  const byPath = index.byPathKey.get(normalized.pathKey);
  if (byPath) return { link: byPath, matchType: 'path' };
  return null;
}