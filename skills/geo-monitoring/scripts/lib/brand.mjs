function normalized(value) {
  return String(value ?? '').toLocaleLowerCase();
}

function countOccurrences(text, term) {
  if (!term) return 0;
  let count = 0;
  let from = 0;
  while (from >= 0) {
    from = text.indexOf(term, from);
    if (from < 0) break;
    count += 1;
    from += term.length;
  }
  return count;
}

export function analyzeBrandMentions(text, brand) {
  const normalizedText = normalized(text);
  const terms = [...new Set([brand.name, ...(brand.aliases ?? [])].map(normalized).filter(Boolean))];
  const matches = terms.map((term) => ({ term, occurrences: countOccurrences(normalizedText, term) }))
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
    const normalizedDomain = normalized(ownedDomain).replace(/^www\./u, '');
    return host === normalizedDomain || host.endsWith(`.${normalizedDomain}`);
  });
}

export function analyzeOwnedDomainCitations(citations, brand) {
  const matched = citations.filter((citation) => isOwnedDomain(citation.domain, brand.ownedDomains));
  return {
    cited: matched.length > 0,
    count: matched.length,
    citations: matched.map(({ position, domain, url, title }) => ({ position, domain, url, title })),
  };
}
