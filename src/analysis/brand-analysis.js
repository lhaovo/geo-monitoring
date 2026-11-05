// 品牌提及与自有域名引用的分析逻辑。
// 与 skill 版本保持一致：提及按「名称 + 别名 + 产品」匹配，自有域名按后缀匹配，
// 因此 example.com 也会被视为自有域名。

function normalized(value) {
  return String(value ?? '').toLocaleLowerCase();
}

export function countOccurrences(text, term) {
  if (!text || !term) return 0;
  const source = text.toLocaleLowerCase();
  const needle = term.toLocaleLowerCase();
  let count = 0;
  let offset = 0;
  while (true) {
    const index = source.indexOf(needle, offset);
    if (index < 0) return count;
    count += 1;
    offset = index + Math.max(needle.length, 1);
  }
}

// 品牌匹配词表：名称 + 别名 + 产品，与 skill 版本口径一致。
export function brandTerms(brand) {
  return [...new Set([
    brand?.name,
    ...(brand?.aliases ?? []),
    ...(brand?.products ?? []),
  ].map((term) => String(term ?? '').trim()).filter(Boolean))];
}

export function analyzeBrandMentions(text, brand) {
  const content = String(text ?? '');
  const terms = brandTerms(brand);
  const matches = terms
    .map((term) => ({ term, occurrences: countOccurrences(content, term) }))
    .filter((match) => match.occurrences > 0);
  return {
    mentioned: matches.length > 0,
    occurrences: matches.reduce((total, match) => total + match.occurrences, 0),
    matches,
  };
}

// 引用源提及分析：对每条引用的标题（平台渲染的来源卡片标题，通常带站点名与
// 摘要片段）做品牌词匹配，用来判断「来源本身是否提到了品牌」。
// 这一层完全基于已抓取的数据，不需要额外网络请求。
export function analyzeCitationMentions(citations, brand) {
  const terms = brandTerms(brand);
  const rows = [];
  const matchedTerms = new Set();
  let count = 0;
  let occurrences = 0;

  for (const citation of citations ?? []) {
    const title = String(citation?.title ?? '');
    const hits = terms
      .map((term) => ({ term, occurrences: countOccurrences(title, term) }))
      .filter((hit) => hit.occurrences > 0);
    const hitOccurrences = hits.reduce((total, hit) => total + hit.occurrences, 0);
    if (hits.length) {
      count += 1;
      occurrences += hitOccurrences;
      for (const hit of hits) matchedTerms.add(hit.term);
    }
    rows.push({
      position: citation?.position ?? null,
      url: citation?.url ?? '',
      domain: citation?.domain ?? '',
      title,
      mentioned: hits.length > 0,
      occurrences: hitOccurrences,
      matchedTerms: hits.map((hit) => hit.term),
    });
  }

  return {
    mentioned: count > 0,
    count,
    occurrences,
    matchedTerms: [...matchedTerms],
    citations: rows,
  };
}

// 回答提及与引用源提及的交叉判断：
// - backed：回答提到品牌，且引用源里也有品牌，属于「来源支撑」
// - unsupported：回答提到品牌，但没有任何引用源提到，属于「模型自有认知」
export function analyzeMentionSupport(answerAnalysis, sourceAnalysis) {
  // 兼容两种字段名：分析模块的 mentioned 与仓储层的 brandMentioned / sourceMentioned。
  const answerMentioned = Boolean(answerAnalysis?.mentioned ?? answerAnalysis?.brandMentioned);
  const sourceMentioned = Boolean(sourceAnalysis?.mentioned ?? sourceAnalysis?.sourceMentioned);
  return {
    mentionBackedBySource: answerMentioned && sourceMentioned,
    mentionWithoutSource: answerMentioned && !sourceMentioned,
  };
}

export function isOwnedDomain(domain, ownedDomains) {
  const host = normalized(domain).replace(/^www\./u, '');
  return (ownedDomains ?? []).some((ownedDomain) => {
    const normalizedDomain = normalized(ownedDomain).replace(/^www\./u, '').trim();
    if (!normalizedDomain) return false;
    return host === normalizedDomain || host.endsWith(`.${normalizedDomain}`);
  });
}

export function analyzeOwnedDomainCitations(citations, brand) {
  const matched = (citations ?? []).filter((citation) => isOwnedDomain(citation.domain, brand?.ownedDomains ?? []));
  return {
    cited: matched.length > 0,
    count: matched.length,
    citations: matched.map(({ position, domain, url, title }) => ({ position, domain, url, title })),
  };
}
