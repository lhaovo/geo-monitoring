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

export function analyzeBrandMentions(text, brand) {
  const content = String(text ?? '');
  const terms = [...new Set([
    brand?.name,
    ...(brand?.aliases ?? []),
    ...(brand?.products ?? []),
  ].map((term) => String(term ?? '').trim()).filter(Boolean))];
  const matches = terms
    .map((term) => ({ term, occurrences: countOccurrences(content, term) }))
    .filter((match) => match.occurrences > 0);
  return {
    mentioned: matches.length > 0,
    occurrences: matches.reduce((total, match) => total + match.occurrences, 0),
    matches,
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
