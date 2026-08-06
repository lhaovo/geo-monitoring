import { createId, now } from '../shared/ids.js';
import { NotFoundError, ValidationError } from '../shared/errors.js';

const toBoolean = (value) => Boolean(value);

const parseJson = (value, fallback = []) => {
  try {
    return JSON.parse(value ?? JSON.stringify(fallback));
  } catch {
    return fallback;
  }
};

function listValue(value) {
  if (Array.isArray(value)) return [...new Set(value.map((item) => String(item).trim()).filter(Boolean))];
  if (typeof value === 'string') return [...new Set(value.split(/[,，\n;]/).map((item) => item.trim()).filter(Boolean))];
  return [];
}

function countOccurrences(text, term) {
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

function analyzeBrand(brand, content) {
  const terms = [...new Set([
    brand?.name,
    ...parseJson(brand?.aliases_json, []),
    ...parseJson(brand?.products_json, []),
  ].map((item) => String(item ?? '').trim()).filter(Boolean))];
  const matchedTerms = terms.filter((term) => countOccurrences(content, term) > 0);
  const mentionCount = matchedTerms.reduce((total, term) => total + countOccurrences(content, term), 0);
  return {
    brandMentioned: mentionCount > 0,
    mentionCount,
    matchedTerms,
    recommendation: 'unknown',
    analysisConfidence: matchedTerms.length ? 1 : 0,
  };
}

function mapBrand(row) {
  if (!row) return null;
  const aliases = parseJson(row.aliases_json, []);
  const products = parseJson(row.products_json, []);
  const ownedDomains = parseJson(row.owned_domains_json, []);
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    aliases,
    products,
    website: row.website ?? '',
    ownedDomains,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapPrompt(row) {
  if (!row) return null;
  return {
    id: row.id,
    brandId: row.project_id,
    projectId: row.project_id,
    text: row.text,
    category: row.category ?? '',
    enabled: toBoolean(row.enabled),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapRun(row) {
  if (!row) return null;
  return {
    id: row.id,
    brandId: row.project_id,
    projectId: row.project_id,
    status: row.status,
    mode: row.mode,
    concurrency: Number(row.concurrency ?? 3),
    appendSearchPrompt: Boolean(row.append_search_prompt),
    targetPlatforms: parseJson(row.target_platforms_json),
    totalChecks: Number(row.total_checks ?? 0),
    completedChecks: Number(row.completed_checks ?? 0),
    failedChecks: Number(row.failed_checks ?? 0),
    mentionedChecks: Number(row.mentioned_checks ?? 0),
    citationCount: Number(row.citation_count ?? 0),
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    cancelRequestedAt: row.cancel_requested_at,
  };
}

function mapPlatformRun(row) {
  if (!row) return null;
  return {
    id: row.id,
    runId: row.run_id,
    promptId: row.prompt_id,
    platformId: row.platform_id,
    mode: row.mode,
    status: row.status,
    errorMessage: row.error_message,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    prompt: row.prompt_text === undefined ? undefined : {
      id: row.prompt_id,
      text: row.prompt_text,
      category: row.prompt_category ?? '',
    },
  };
}

export class GeoRepository {
  constructor(database) {
    this.database = database;
  }

  createBrand({ name, description = '', aliases = [], products = [], website = '', ownedDomains = [] }) {
    if (!name?.trim()) throw new ValidationError('品牌名称不能为空。');
    const createdAt = now();
    const brand = {
      id: createId(),
      name: name.trim(),
      description: String(description ?? '').trim(),
      aliases: listValue(aliases),
      products: listValue(products),
      website: String(website ?? '').trim(),
      ownedDomains: listValue(ownedDomains),
      createdAt,
    };
    this.database.prepare(`INSERT INTO projects
      (id, name, description, aliases_json, products_json, website, owned_domains_json, created_at, updated_at)
      VALUES (@id, @name, @description, @aliases, @products, @website, @ownedDomains, @createdAt, @createdAt)`).run({
      ...brand,
      aliases: JSON.stringify(brand.aliases),
      products: JSON.stringify(brand.products),
      ownedDomains: JSON.stringify(brand.ownedDomains),
    });
    return this.getBrand(brand.id);
  }

  createProject(values) { return this.createBrand(values); }

  listBrands() {
    return this.database.prepare('SELECT * FROM projects ORDER BY updated_at DESC').all().map(mapBrand);
  }

  listProjects() { return this.listBrands(); }

  getBrand(brandId) {
    const brand = mapBrand(this.database.prepare('SELECT * FROM projects WHERE id = ?').get(brandId));
    if (!brand) throw new NotFoundError('未找到该品牌。');
    return brand;
  }

  getProject(projectId) { return this.getBrand(projectId); }

  updateBrand(brandId, values = {}) {
    const current = this.getBrand(brandId);
    const name = values.name === undefined ? current.name : String(values.name).trim();
    if (!name) throw new ValidationError('品牌名称不能为空。');
    const next = {
      name,
      description: values.description === undefined ? current.description : String(values.description ?? '').trim(),
      aliases: values.aliases === undefined ? current.aliases : listValue(values.aliases),
      products: values.products === undefined ? current.products : listValue(values.products),
      website: values.website === undefined ? current.website : String(values.website ?? '').trim(),
      ownedDomains: values.ownedDomains === undefined ? current.ownedDomains : listValue(values.ownedDomains),
    };
    this.database.prepare(`UPDATE projects SET name = ?, description = ?, aliases_json = ?, products_json = ?, website = ?, owned_domains_json = ?, updated_at = ? WHERE id = ?`)
      .run(next.name, next.description, JSON.stringify(next.aliases), JSON.stringify(next.products), next.website, JSON.stringify(next.ownedDomains), now(), brandId);
    return this.getBrand(brandId);
  }

  updateProject(projectId, values) { return this.updateBrand(projectId, values); }

  listPrompts(brandId) {
    this.getBrand(brandId);
    return this.database.prepare('SELECT * FROM prompts WHERE project_id = ? ORDER BY created_at ASC')
      .all(brandId).map(mapPrompt);
  }

  getPrompt(promptId) {
    const prompt = mapPrompt(this.database.prepare('SELECT * FROM prompts WHERE id = ?').get(promptId));
    if (!prompt) throw new NotFoundError('未找到该监控问题。');
    return prompt;
  }

  createPrompt(brandId, { text, category = '', enabled = true }) {
    this.getBrand(brandId);
    if (!text?.trim()) throw new ValidationError('监控问题不能为空。');
    const timestamp = now();
    const prompt = { id: createId(), brandId, text: text.trim(), category: String(category ?? '').trim(), enabled: enabled ? 1 : 0, timestamp };
    this.database.prepare(`INSERT INTO prompts (id, project_id, text, category, enabled, created_at, updated_at)
      VALUES (@id, @brandId, @text, @category, @enabled, @timestamp, @timestamp)`).run(prompt);
    return this.getPrompt(prompt.id);
  }

  updatePrompt(promptId, values = {}) {
    const current = this.getPrompt(promptId);
    const text = values.text === undefined ? current.text : String(values.text).trim();
    if (!text) throw new ValidationError('监控问题不能为空。');
    const category = values.category === undefined ? current.category : String(values.category ?? '').trim();
    const enabled = values.enabled === undefined ? current.enabled : Boolean(values.enabled);
    this.database.prepare('UPDATE prompts SET text = ?, category = ?, enabled = ?, updated_at = ? WHERE id = ?')
      .run(text, category, enabled ? 1 : 0, now(), promptId);
    return this.getPrompt(promptId);
  }

  deletePrompt(promptId) {
    this.getPrompt(promptId);
    this.database.prepare('DELETE FROM prompts WHERE id = ?').run(promptId);
  }

  createRun({ projectId, promptIds, platforms, mode = 'headless', platformModes = {}, concurrency = 3, appendSearchPrompt = false }) {
    this.getBrand(projectId);
    if (!Array.isArray(promptIds) || promptIds.length === 0) throw new ValidationError('至少选择一个监控问题。');
    if (!Array.isArray(platforms) || platforms.length === 0) throw new ValidationError('至少选择一个平台。');
    if (!['headless', 'headed'].includes(mode)) throw new ValidationError('mode 必须为 headless 或 headed。');
    const normalizedConcurrency = Number(concurrency);
    if (!Number.isInteger(normalizedConcurrency) || normalizedConcurrency < 1 || normalizedConcurrency > 6) {
      throw new ValidationError('concurrency 必须是 1 到 6 之间的整数。');
    }
    if (!platformModes || typeof platformModes !== 'object' || Array.isArray(platformModes)) {
      throw new ValidationError('platformModes 必须为平台到模式的对象。');
    }
    const uniquePromptIds = [...new Set(promptIds)];
    const prompts = uniquePromptIds.map((promptId) => this.getPrompt(promptId));
    if (prompts.some((prompt) => prompt.brandId !== projectId)) throw new ValidationError('监控问题不属于该品牌。');
    const timestamp = now();
    const run = {
      id: createId(), projectId, status: 'queued', mode, concurrency: normalizedConcurrency,
      appendSearchPrompt: Boolean(appendSearchPrompt),
      platforms: [...new Set(platforms)], timestamp,
    };
    for (const platformId of Object.keys(platformModes)) {
      if (!run.platforms.includes(platformId)) throw new ValidationError(`platformModes 包含未选择的平台：${platformId}。`);
    }
    const modeByPlatform = Object.fromEntries(run.platforms.map((platformId) => {
      const platformMode = platformModes[platformId] ?? mode;
      if (!['headless', 'headed'].includes(platformMode)) throw new ValidationError(`${platformId} 的模式必须为 headless 或 headed。`);
      return [platformId, platformMode];
    }));
    const write = this.database.transaction(() => {
      this.database.prepare(`INSERT INTO runs (id, project_id, status, mode, concurrency, append_search_prompt, target_platforms_json, created_at)
        VALUES (@id, @projectId, @status, @mode, @concurrency, @appendSearchPrompt, @platforms, @timestamp)`).run({
        ...run, platforms: JSON.stringify(run.platforms),
        appendSearchPrompt: run.appendSearchPrompt ? 1 : 0,
      });
      const itemStatement = this.database.prepare('INSERT INTO run_items (id, run_id, prompt_id, created_at) VALUES (?, ?, ?, ?)');
      const platformRunStatement = this.database.prepare(`INSERT INTO platform_runs
        (id, run_id, prompt_id, platform_id, mode, status, created_at) VALUES (?, ?, ?, ?, ?, 'queued', ?)`);
      for (const promptId of uniquePromptIds) {
        itemStatement.run(createId(), run.id, promptId, timestamp);
        for (const platformId of run.platforms) platformRunStatement.run(createId(), run.id, promptId, platformId, modeByPlatform[platformId], timestamp);
      }
    });
    write();
    return this.getRun(run.id);
  }

  runProgressSql() {
    return `
      (SELECT COUNT(*) FROM platform_runs pr0 WHERE pr0.run_id = r.id) AS total_checks,
      (SELECT COUNT(*) FROM platform_runs pr1 WHERE pr1.run_id = r.id AND pr1.status = 'completed') AS completed_checks,
      (SELECT COUNT(*) FROM platform_runs pr2 WHERE pr2.run_id = r.id AND pr2.status = 'failed') AS failed_checks,
      (SELECT COUNT(*) FROM answers a0 JOIN platform_runs pr3 ON pr3.id = a0.platform_run_id WHERE pr3.run_id = r.id AND a0.brand_mentioned = 1) AS mentioned_checks,
      (SELECT COUNT(*) FROM citations c0 JOIN answers a1 ON a1.id = c0.answer_id JOIN platform_runs pr4 ON pr4.id = a1.platform_run_id WHERE pr4.run_id = r.id) AS citation_count`;
  }

  listRuns({ projectId, limit = 50 } = {}) {
    const where = projectId ? 'WHERE r.project_id = ?' : '';
    const params = projectId ? [projectId, limit] : [limit];
    return this.database.prepare(`SELECT r.*, ${this.runProgressSql()} FROM runs r ${where} ORDER BY r.created_at DESC LIMIT ?`).all(...params).map(mapRun);
  }

  getRun(runId) {
    const row = this.database.prepare(`SELECT r.*, ${this.runProgressSql()} FROM runs r WHERE r.id = ?`).get(runId);
    const run = mapRun(row);
    if (!run) throw new NotFoundError('未找到该监测任务。');
    return run;
  }

  getRunDetail(runId) {
    const run = this.getRun(runId);
    const platformRuns = this.database.prepare(`SELECT pr.*, p.text AS prompt_text, p.category AS prompt_category
      FROM platform_runs pr JOIN prompts p ON p.id = pr.prompt_id WHERE pr.run_id = ? ORDER BY pr.created_at ASC`).all(runId).map(mapPlatformRun);
    const answerByPlatformRunId = new Map();
    const answerRows = this.database.prepare(`SELECT a.* FROM answers a JOIN platform_runs pr
      ON pr.id = a.platform_run_id WHERE pr.run_id = ?`).all(runId);
    for (const answerRow of answerRows) answerByPlatformRunId.set(answerRow.platform_run_id, {
      id: answerRow.id,
      content: answerRow.content,
      responseUrl: answerRow.response_url,
      sourcePanelOpened: toBoolean(answerRow.source_panel_opened),
      platformReportedCount: answerRow.platform_reported_count,
      displayedSourceLinkCount: answerRow.displayed_source_link_count,
      capturedCardCount: answerRow.captured_card_count,
      missingSourceIndexes: parseJson(answerRow.missing_source_indexes_json, []),
      brandMentioned: toBoolean(answerRow.brand_mentioned),
      mentionCount: Number(answerRow.mention_count ?? 0),
      matchedTerms: parseJson(answerRow.matched_terms_json, []),
      recommendation: answerRow.recommendation ?? 'unknown',
      analysisConfidence: Number(answerRow.analysis_confidence ?? 0),
      createdAt: answerRow.created_at,
      citations: [], artifacts: [],
    });
    const citationRows = this.database.prepare(`SELECT c.* FROM citations c JOIN answers a ON a.id = c.answer_id
      JOIN platform_runs pr ON pr.id = a.platform_run_id WHERE pr.run_id = ? ORDER BY c.position ASC`).all(runId);
    for (const row of citationRows) {
      const answer = [...answerByPlatformRunId.values()].find((candidate) => candidate.id === row.answer_id);
      if (answer) answer.citations.push({ id: row.id, position: row.position, title: row.title, url: row.url, domain: row.domain,
        citationFragments: parseJson(row.citation_fragments_json), citationOccurrences: row.citation_occurrences });
    }
    const artifactRows = this.database.prepare(`SELECT ar.* FROM artifacts ar JOIN platform_runs pr ON pr.id = ar.platform_run_id
      WHERE pr.run_id = ? ORDER BY ar.created_at ASC`).all(runId);
    for (const row of artifactRows) {
      const answer = answerByPlatformRunId.get(row.platform_run_id);
      if (answer) answer.artifacts.push({ id: row.id, kind: row.kind, relativePath: row.relative_path, createdAt: row.created_at });
    }
    return { ...run, platformRuns: platformRuns.map((platformRun) => ({ ...platformRun, answer: answerByPlatformRunId.get(platformRun.id) ?? null })) };
  }

  getAnswer(answerId) {
    const row = this.database.prepare(`SELECT a.*, pr.run_id, pr.prompt_id, pr.platform_id, pr.mode AS platform_run_mode,
      pr.status AS platform_run_status, p.text AS prompt_text, p.category AS prompt_category
      FROM answers a JOIN platform_runs pr ON pr.id = a.platform_run_id JOIN prompts p ON p.id = pr.prompt_id WHERE a.id = ?`).get(answerId);
    if (!row) throw new NotFoundError('未找到该平台回答。');
    const citations = this.database.prepare('SELECT * FROM citations WHERE answer_id = ? ORDER BY position ASC').all(answerId).map((citation) => ({
      id: citation.id, position: citation.position, title: citation.title, url: citation.url, domain: citation.domain,
      citationFragments: parseJson(citation.citation_fragments_json), citationOccurrences: citation.citation_occurrences,
    }));
    const artifacts = this.database.prepare('SELECT * FROM artifacts WHERE platform_run_id = ? ORDER BY created_at ASC').all(row.platform_run_id).map((artifact) => ({
      id: artifact.id, kind: artifact.kind, relativePath: artifact.relative_path, createdAt: artifact.created_at,
    }));
    return { id: row.id, platformRunId: row.platform_run_id, runId: row.run_id, platformId: row.platform_id, mode: row.platform_run_mode,
      platformRunStatus: row.platform_run_status, prompt: { id: row.prompt_id, text: row.prompt_text, category: row.prompt_category ?? '' },
      content: row.content, responseUrl: row.response_url, sourcePanelOpened: toBoolean(row.source_panel_opened), platformReportedCount: row.platform_reported_count,
      displayedSourceLinkCount: row.displayed_source_link_count, capturedCardCount: row.captured_card_count,
      missingSourceIndexes: parseJson(row.missing_source_indexes_json, []),
      brandMentioned: toBoolean(row.brand_mentioned), mentionCount: Number(row.mention_count ?? 0), matchedTerms: parseJson(row.matched_terms_json, []),
      recommendation: row.recommendation ?? 'unknown', analysisConfidence: Number(row.analysis_confidence ?? 0), createdAt: row.created_at, citations, artifacts };
  }

  getCitation(citationId) {
    const row = this.database.prepare(`SELECT c.*, a.platform_run_id FROM citations c JOIN answers a ON a.id = c.answer_id WHERE c.id = ?`).get(citationId);
    if (!row) throw new NotFoundError('未找到该引用网页。');
    return { id: row.id, answerId: row.answer_id, platformRunId: row.platform_run_id, position: row.position, title: row.title, url: row.url,
      domain: row.domain, citationFragments: parseJson(row.citation_fragments_json), citationOccurrences: row.citation_occurrences, createdAt: row.created_at };
  }

  getPendingPlatformRuns(runId) {
    this.getRun(runId);
    return this.database.prepare(`SELECT pr.*, p.text AS prompt_text, p.category AS prompt_category, r.cancel_requested_at
      FROM platform_runs pr JOIN prompts p ON p.id = pr.prompt_id JOIN runs r ON r.id = pr.run_id
      WHERE pr.run_id = ? AND pr.status = 'queued' ORDER BY pr.created_at ASC`).all(runId).map(mapPlatformRun);
  }

  startRun(runId) {
    this.getRun(runId);
    this.database.prepare(`UPDATE runs SET status = CASE WHEN status = 'queued' THEN 'running' ELSE status END,
      started_at = COALESCE(started_at, ?) WHERE id = ?`).run(now(), runId);
    return this.getRun(runId);
  }

  startPlatformRun(platformRunId) {
    this.database.prepare(`UPDATE platform_runs SET status = 'running', started_at = ? WHERE id = ? AND status = 'queued'`).run(now(), platformRunId);
  }

  completePlatformRun(platformRunId, result) {
    const timestamp = now();
    const brand = this.database.prepare(`SELECT p.* FROM projects p JOIN runs r ON r.project_id = p.id
      JOIN platform_runs pr ON pr.run_id = r.id WHERE pr.id = ?`).get(platformRunId);
    const analysis = analyzeBrand(brand, result.content ?? '');
    const write = this.database.transaction(() => {
      this.database.prepare(`UPDATE platform_runs SET status = 'completed', completed_at = ?, error_message = NULL WHERE id = ?`).run(timestamp, platformRunId);
      const answerId = createId();
      this.database.prepare(`INSERT INTO answers
        (id, platform_run_id, content, response_url, source_panel_opened, platform_reported_count, displayed_source_link_count, captured_card_count, missing_source_indexes_json, brand_mentioned, mention_count, matched_terms_json, recommendation, analysis_confidence, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(answerId, platformRunId, result.content ?? '', result.responseUrl ?? null,
        result.sourcePanelOpened ? 1 : 0, result.platformReportedCount ?? null, result.displayedSourceLinkCount ?? null, result.capturedCardCount ?? null,
        JSON.stringify(result.missingSourceIndexes ?? []), analysis.brandMentioned ? 1 : 0, analysis.mentionCount,
        JSON.stringify(analysis.matchedTerms), analysis.recommendation, analysis.analysisConfidence, timestamp);
      const citationStatement = this.database.prepare(`INSERT INTO citations
        (id, answer_id, position, title, url, domain, citation_fragments_json, citation_occurrences, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const citation of result.citations ?? []) citationStatement.run(createId(), answerId, citation.position, citation.title ?? '', citation.url, citation.domain,
        JSON.stringify(citation.citationFragments ?? []), citation.citationOccurrences ?? 0, timestamp);
      const artifactStatement = this.database.prepare('INSERT INTO artifacts (id, platform_run_id, kind, relative_path, created_at) VALUES (?, ?, ?, ?, ?)');
      for (const artifact of result.artifacts ?? []) artifactStatement.run(createId(), platformRunId, artifact.kind, artifact.relativePath, timestamp);
    });
    write();
  }

  getBrandOverview(brandId, { days = 30 } = {}) {
    const brand = this.getBrand(brandId);
    const safeDays = Math.max(1, Math.min(Number(days) || 30, 3650));
    const since = new Date(Date.now() - safeDays * 86400000).toISOString();
    const rows = this.database.prepare(`SELECT pr.id, pr.prompt_id, pr.platform_id, pr.status, pr.error_message, pr.created_at,
      p.text AS prompt_text, p.category AS prompt_category, a.id AS answer_id, a.brand_mentioned, a.mention_count,
      a.recommendation, a.source_panel_opened, a.platform_reported_count,
      (SELECT COUNT(*) FROM citations c WHERE c.answer_id = a.id) AS citation_count,
      (SELECT COALESCE(SUM(c.citation_occurrences), 0) FROM citations c WHERE c.answer_id = a.id) AS citation_occurrences
      FROM platform_runs pr JOIN runs r ON r.id = pr.run_id JOIN prompts p ON p.id = pr.prompt_id
      LEFT JOIN answers a ON a.platform_run_id = pr.id
      WHERE r.project_id = ? AND r.created_at >= ? ORDER BY pr.created_at DESC`).all(brandId, since);
    const completed = rows.filter((row) => row.status === 'completed' && row.answer_id);
    const summarize = (items) => {
      const valid = items.filter((row) => row.status === 'completed' && row.answer_id);
      const mentioned = valid.filter((row) => toBoolean(row.brand_mentioned)).length;
      const cited = valid.filter((row) => Number(row.citation_count) > 0).length;
      return { checks: items.length, completed: valid.length, mentioned, mentionRate: valid.length ? Math.round((mentioned / valid.length) * 1000) / 10 : null,
        cited, citationRate: valid.length ? Math.round((cited / valid.length) * 1000) / 10 : null,
        citations: items.reduce((total, row) => total + Number(row.citation_occurrences || 0), 0), failures: items.filter((row) => row.status === 'failed').length };
    };
    const platformIds = [...new Set(rows.map((row) => row.platform_id))];
    const platforms = platformIds.map((platform) => ({ platform, ...summarize(rows.filter((row) => row.platform_id === platform)) }));
    const promptIds = [...new Set(rows.map((row) => row.prompt_id))];
    const questions = promptIds.map((promptId) => {
      const first = rows.find((row) => row.prompt_id === promptId);
      return { id: promptId, text: first?.prompt_text ?? '', category: first?.prompt_category ?? '', ...summarize(rows.filter((row) => row.prompt_id === promptId)) };
    });
    const byDay = new Map();
    for (const row of completed) {
      const day = row.created_at.slice(0, 10);
      if (!byDay.has(day)) byDay.set(day, []);
      byDay.get(day).push(row);
    }
    const trend = [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, items]) => ({ date, ...summarize(items) }));
    const summary = { ...summarize(rows), totalChecks: rows.length, periodDays: safeDays, platformCount: platformIds.length, questionCount: promptIds.length };
    return { brand, summary, platforms, questions, trend, recentRuns: this.listRuns({ projectId: brandId, limit: 10 }) };
  }

  getBrandSources(brandId, { days = 30, platformId = '' } = {}) {
    this.getBrand(brandId);
    const safeDays = Math.max(1, Math.min(Number(days) || 30, 3650));
    const sinceTime = Date.now() - safeDays * 86400000;
    const wherePlatform = platformId ? 'AND pr.platform_id = ?' : '';
    const params = platformId ? [brandId, platformId] : [brandId];
    const rawRows = this.database.prepare(`SELECT c.url, c.title, c.domain, c.citation_occurrences, c.created_at, pr.platform_id,
      p.id AS prompt_id, p.text AS prompt_text, a.id AS answer_id
      FROM citations c JOIN answers a ON a.id = c.answer_id JOIN platform_runs pr ON pr.id = a.platform_run_id
      JOIN runs r ON r.id = pr.run_id JOIN prompts p ON p.id = pr.prompt_id
      WHERE r.project_id = ? ${wherePlatform} ORDER BY c.created_at DESC`).all(...params);
    const rows = rawRows.filter((row) => new Date(row.created_at).getTime() >= sinceTime);
    const byUrl = new Map();
    for (const row of rows) {
      const item = byUrl.get(row.url) ?? { url: row.url, title: row.title, domain: row.domain, platforms: [], promptIds: [], prompts: [], citationCount: 0, citationOccurrences: 0, firstSeenAt: row.created_at, lastSeenAt: row.created_at };
      byUrl.set(row.url, item);
      if (row.title && !item.title) item.title = row.title;
      if (!item.platforms.includes(row.platform_id)) item.platforms.push(row.platform_id);
      if (!item.promptIds.includes(row.prompt_id)) { item.promptIds.push(row.prompt_id); item.prompts.push(row.prompt_text); }
      item.citationCount += 1;
      item.citationOccurrences += Number(row.citation_occurrences || 0);
      if (row.created_at < item.firstSeenAt) item.firstSeenAt = row.created_at;
      if (row.created_at > item.lastSeenAt) item.lastSeenAt = row.created_at;
    }
    const sources = [...byUrl.values()];
    return { summary: { uniqueUrls: sources.length, domains: new Set(sources.map((item) => item.domain)).size,
      citationCount: sources.reduce((total, item) => total + item.citationCount, 0),
      citationOccurrences: sources.reduce((total, item) => total + item.citationOccurrences, 0), periodDays: safeDays }, sources };
  }

  getPendingPlatformRunsForRun(runId) { return this.getPendingPlatformRuns(runId); }

  failPlatformRun(platformRunId, errorMessage) {
    this.database.prepare(`UPDATE platform_runs SET status = 'failed', error_message = ?, completed_at = ? WHERE id = ?`).run(errorMessage, now(), platformRunId);
  }

  cancelPlatformRun(platformRunId) {
    this.database.prepare(`UPDATE platform_runs SET status = 'cancelled', error_message = NULL, completed_at = ?
      WHERE id = ? AND status IN ('queued', 'running')`).run(now(), platformRunId);
  }

  addArtifacts(platformRunId, artifacts) {
    if (!artifacts?.length) return;
    const timestamp = now();
    const statement = this.database.prepare('INSERT INTO artifacts (id, platform_run_id, kind, relative_path, created_at) VALUES (?, ?, ?, ?, ?)');
    for (const artifact of artifacts) statement.run(createId(), platformRunId, artifact.kind, artifact.relativePath, timestamp);
  }

  finishRun(runId) {
    const statuses = this.database.prepare('SELECT status FROM platform_runs WHERE run_id = ?').all(runId).map((row) => row.status);
    const status = statuses.length && statuses.every((value) => value === 'completed') ? 'completed'
      : statuses.some((value) => value === 'cancelled') ? 'cancelled'
        : statuses.some((value) => value === 'completed') ? 'partial_failed' : 'failed';
    this.database.prepare('UPDATE runs SET status = ?, completed_at = ? WHERE id = ?').run(status, now(), runId);
    return this.getRun(runId);
  }

  requestCancellation(runId) {
    const run = this.getRun(runId);
    if (!['queued', 'running'].includes(run.status)) return run;
    this.database.prepare(`UPDATE runs SET cancel_requested_at = ?, status = CASE WHEN status = 'queued' THEN 'cancelled' ELSE status END WHERE id = ?`).run(now(), runId);
    this.database.prepare("UPDATE platform_runs SET status = 'cancelled', completed_at = ? WHERE run_id = ? AND status = 'queued'").run(now(), runId);
    return this.getRun(runId);
  }

  isCancellationRequested(runId) {
    return Boolean(this.database.prepare('SELECT cancel_requested_at FROM runs WHERE id = ?').get(runId)?.cancel_requested_at);
  }

  addEvent({ runId, platformRunId = null, level = 'info', message }) {
    const event = { id: createId(), runId, platformRunId, level, message, createdAt: now() };
    this.database.prepare(`INSERT INTO task_events (id, run_id, platform_run_id, level, message, created_at)
      VALUES (@id, @runId, @platformRunId, @level, @message, @createdAt)`).run(event);
    return event;
  }

  listEvents(runId) {
    this.getRun(runId);
    return this.database.prepare('SELECT * FROM task_events WHERE run_id = ? ORDER BY created_at ASC').all(runId).map((row) => ({
      id: row.id, runId: row.run_id, platformRunId: row.platform_run_id, level: row.level, message: row.message, createdAt: row.created_at,
    }));
  }
}
