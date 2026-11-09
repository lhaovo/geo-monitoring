import { createId, now } from '../shared/ids.js';
import { NotFoundError, ValidationError } from '../shared/errors.js';
import { normalizeAccountIdentity, normalizeProfileId, profileIdFromAccount } from '../profiles/account-identity.js';
import { analyzeBrandMentions, analyzeCitationMentions, analyzeMentionSupport, analyzeOwnedDomainCitations } from '../analysis/brand-analysis.js';

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

// 品牌口径统一走共享模块，保证与 skill 版本一致。
function brandProfile(brand) {
  return {
    name: brand?.name,
    aliases: parseJson(brand?.aliases_json, []),
    products: parseJson(brand?.products_json, []),
    ownedDomains: parseJson(brand?.owned_domains_json, []),
  };
}

function analyzeBrand(brand, content) {
  const analysis = analyzeBrandMentions(content, brandProfile(brand));
  return {
    brandMentioned: analysis.mentioned,
    mentionCount: analysis.occurrences,
    matchedTerms: analysis.matches.map((match) => match.term),
    recommendation: 'unknown',
    analysisConfidence: analysis.matches.length ? 1 : 0,
  };
}

// 引用源提及分析：基于已抓取的引用标题（平台渲染的来源卡片标题通常带摘要片段），
// 判断来源本身是否提到品牌，不需要额外网络请求。
function analyzeSourceMentions(brand, citations, answerAnalysis = {}) {
  const source = analyzeCitationMentions(citations, brandProfile(brand));
  const support = analyzeMentionSupport(answerAnalysis, { mentioned: source.mentioned });
  return {
    sourceMentioned: source.mentioned,
    sourceMentionCount: source.count,
    sourceMatchedTerms: source.matchedTerms,
    mentionBackedBySource: support.mentionBackedBySource,
    mentionWithoutSource: support.mentionWithoutSource,
    rows: source.citations,
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

function mapProfile(row) {
  if (!row) return null;
  return {
    id: row.id,
    platformId: row.platform_id,
    profileId: row.profile_id,
    account: row.account ?? '',
    label: row.label ?? '',
    health: row.health,
    restrictedUntil: row.restricted_until ?? null,
    lastLoginAt: row.last_login_at ?? null,
    lastUsedAt: row.last_used_at ?? null,
    lastError: row.last_error ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
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
    profileId: row.profile_id ?? '',
    shareStatus: row.share_status ?? 'unavailable',
    shareUrl: row.share_url ?? null,
    restrictedUntil: row.restricted_until ?? null,
    attempts: Number(row.attempts ?? 0),
    errorMessage: row.error_message,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    prompt: row.prompt_text === undefined ? undefined : {
      id: row.prompt_id,
      text: row.prompt_text,
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
    // 品牌名、别名或产品词变化后，历史回答的命中口径需要跟着回算。
    const signature = (parts) => JSON.stringify(parts);
    if (signature([next.name, next.aliases, next.products]) !== signature([current.name, current.aliases, current.products])) {
      this.recomputeBrandAnalysis(brandId);
    }
    return this.getBrand(brandId);
  }

  // 重新计算某个品牌下全部回答的提及分析与来源提及分析。
  // 完全基于已抓取的引用标题，不需要重新访问平台。
  recomputeBrandAnalysis(brandId) {
    const brand = this.getBrand(brandId);
    const rows = this.database.prepare(`SELECT a.id AS answer_id, a.content, c.id AS citation_id, c.position, c.title, c.url, c.domain
      FROM answers a JOIN platform_runs pr ON pr.id = a.platform_run_id JOIN runs r ON r.id = pr.run_id
      LEFT JOIN citations c ON c.answer_id = a.id
      WHERE r.project_id = ? ORDER BY a.created_at ASC`).all(brandId);

    const answers = new Map();
    for (const row of rows) {
      if (!answers.has(row.answer_id)) {
        answers.set(row.answer_id, { id: row.answer_id, content: row.content ?? '', citations: [] });
      }
      if (row.citation_id) {
        answers.get(row.answer_id).citations.push({
          id: row.citation_id, position: row.position, title: row.title ?? '', url: row.url, domain: row.domain,
        });
      }
    }

    const updateAnswer = this.database.prepare(`UPDATE answers SET brand_mentioned = ?, mention_count = ?, matched_terms_json = ?,
      source_mentioned = ?, source_mention_count = ?, source_matched_terms_json = ?, mention_backed_by_source = ?, mention_without_source = ?
      WHERE id = ?`);
    const updateCitation = this.database.prepare('UPDATE citations SET brand_mentioned = ?, matched_terms_json = ? WHERE id = ?');

    const write = this.database.transaction(() => {
      for (const entry of answers.values()) {
        const analysis = analyzeBrand(brand, entry.content);
        const sourceAnalysis = analyzeSourceMentions(brand, entry.citations, analysis);
        updateAnswer.run(analysis.brandMentioned ? 1 : 0, analysis.mentionCount, JSON.stringify(analysis.matchedTerms),
          sourceAnalysis.sourceMentioned ? 1 : 0, sourceAnalysis.sourceMentionCount,
          JSON.stringify(sourceAnalysis.sourceMatchedTerms), sourceAnalysis.mentionBackedBySource ? 1 : 0,
          sourceAnalysis.mentionWithoutSource ? 1 : 0, entry.id);
        const rowsByUrl = new Map(sourceAnalysis.rows.map((row) => [row.url, row]));
        for (const citation of entry.citations) {
          const row = rowsByUrl.get(citation.url);
          updateCitation.run(row?.mentioned ? 1 : 0, JSON.stringify(row?.matchedTerms ?? []), citation.id);
        }
      }
    });
    write();
    return { brandId, answers: answers.size };
  }

  updateProject(projectId, values) { return this.updateBrand(projectId, values); }

  listPrompts(brandId) {
    this.getBrand(brandId);
    const prompts = this.database.prepare('SELECT * FROM prompts WHERE project_id = ? ORDER BY created_at ASC')
      .all(brandId).map(mapPrompt);
    // 附带近30 天的品牌命中率，列表里可以直接看出每个问题的表现。
    const since = new Date(Date.now() - 30 * 86400000).toISOString();
    const rows = this.database.prepare(`SELECT pr.prompt_id, a.brand_mentioned
      FROM platform_runs pr JOIN runs r ON r.id = pr.run_id
      LEFT JOIN answers a ON a.platform_run_id = pr.id
      WHERE r.project_id = ? AND r.created_at >= ? AND pr.status = 'completed' AND a.id IS NOT NULL`).all(brandId, since);
    const stats = new Map();
    for (const row of rows) {
      const item = stats.get(row.prompt_id) ?? { completed: 0, mentioned: 0 };
      item.completed += 1;
      if (toBoolean(row.brand_mentioned)) item.mentioned += 1;
      stats.set(row.prompt_id, item);
    }
    return prompts.map((prompt) => {
      const stat = stats.get(prompt.id);
      return {
        ...prompt,
        checks: stat?.completed ?? 0,
        mentioned: stat?.mentioned ?? 0,
        mentionRate: stat?.completed ? Math.round((stat.mentioned / stat.completed) * 1000) / 10 : null,
      };
    });
  }

  getPrompt(promptId) {
    const prompt = mapPrompt(this.database.prepare('SELECT * FROM prompts WHERE id = ?').get(promptId));
    if (!prompt) throw new NotFoundError('未找到该监控问题。');
    return prompt;
  }

  createPrompt(brandId, { text, enabled = true }) {
    this.getBrand(brandId);
    if (!text?.trim()) throw new ValidationError('监控问题不能为空。');
    const timestamp = now();
    const prompt = { id: createId(), brandId, text: text.trim(), enabled: enabled ? 1 : 0, timestamp };
    this.database.prepare(`INSERT INTO prompts (id, project_id, text, enabled, created_at, updated_at)
      VALUES (@id, @brandId, @text, @enabled, @timestamp, @timestamp)`).run(prompt);
    return this.getPrompt(prompt.id);
  }

  updatePrompt(promptId, values = {}) {
    const current = this.getPrompt(promptId);
    const text = values.text === undefined ? current.text : String(values.text).trim();
    if (!text) throw new ValidationError('监控问题不能为空。');
    const enabled = values.enabled === undefined ? current.enabled : Boolean(values.enabled);
    this.database.prepare('UPDATE prompts SET text = ?, enabled = ?, updated_at = ? WHERE id = ?')
      .run(text, enabled ? 1 : 0, now(), promptId);
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
    const platformRuns = this.database.prepare(`SELECT pr.*, p.text AS prompt_text
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
      sourceMentioned: toBoolean(answerRow.source_mentioned),
      sourceMentionCount: Number(answerRow.source_mention_count ?? 0),
      sourceMatchedTerms: parseJson(answerRow.source_matched_terms_json, []),
      mentionBackedBySource: toBoolean(answerRow.mention_backed_by_source),
      mentionWithoutSource: toBoolean(answerRow.mention_without_source),
      createdAt: answerRow.created_at,
      citations: [], artifacts: [],
    });
    const citationRows = this.database.prepare(`SELECT c.* FROM citations c JOIN answers a ON a.id = c.answer_id
      JOIN platform_runs pr ON pr.id = a.platform_run_id WHERE pr.run_id = ? ORDER BY c.position ASC`).all(runId);
    for (const row of citationRows) {
      const answer = [...answerByPlatformRunId.values()].find((candidate) => candidate.id === row.answer_id);
      if (answer) answer.citations.push({ id: row.id, position: row.position, title: row.title, url: row.url, domain: row.domain,
        citationFragments: parseJson(row.citation_fragments_json), citationOccurrences: row.citation_occurrences,
        brandMentioned: toBoolean(row.brand_mentioned), matchedTerms: parseJson(row.matched_terms_json, []) });
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
      pr.status AS platform_run_status, p.text AS prompt_text
      FROM answers a JOIN platform_runs pr ON pr.id = a.platform_run_id JOIN prompts p ON p.id = pr.prompt_id WHERE a.id = ?`).get(answerId);
    if (!row) throw new NotFoundError('未找到该平台回答。');
    const citations = this.database.prepare('SELECT * FROM citations WHERE answer_id = ? ORDER BY position ASC').all(answerId).map((citation) => ({
      id: citation.id, position: citation.position, title: citation.title, url: citation.url, domain: citation.domain,
      citationFragments: parseJson(citation.citation_fragments_json), citationOccurrences: citation.citation_occurrences,
      brandMentioned: toBoolean(citation.brand_mentioned), matchedTerms: parseJson(citation.matched_terms_json, []),
    }));
    const artifacts = this.database.prepare('SELECT * FROM artifacts WHERE platform_run_id = ? ORDER BY created_at ASC').all(row.platform_run_id).map((artifact) => ({
      id: artifact.id, kind: artifact.kind, relativePath: artifact.relative_path, createdAt: artifact.created_at,
    }));
    return { id: row.id, platformRunId: row.platform_run_id, runId: row.run_id, platformId: row.platform_id, mode: row.platform_run_mode,
      platformRunStatus: row.platform_run_status, prompt: { id: row.prompt_id, text: row.prompt_text },
      content: row.content, responseUrl: row.response_url, sourcePanelOpened: toBoolean(row.source_panel_opened), platformReportedCount: row.platform_reported_count,
      displayedSourceLinkCount: row.displayed_source_link_count, capturedCardCount: row.captured_card_count,
      missingSourceIndexes: parseJson(row.missing_source_indexes_json, []),
      brandMentioned: toBoolean(row.brand_mentioned), mentionCount: Number(row.mention_count ?? 0), matchedTerms: parseJson(row.matched_terms_json, []),
      recommendation: row.recommendation ?? 'unknown', analysisConfidence: Number(row.analysis_confidence ?? 0),
      sourceMentioned: toBoolean(row.source_mentioned), sourceMentionCount: Number(row.source_mention_count ?? 0),
      sourceMatchedTerms: parseJson(row.source_matched_terms_json, []),
      mentionBackedBySource: toBoolean(row.mention_backed_by_source), mentionWithoutSource: toBoolean(row.mention_without_source),
      createdAt: row.created_at, citations, artifacts };
  }

  getCitation(citationId) {
    const row = this.database.prepare(`SELECT c.*, a.platform_run_id FROM citations c JOIN answers a ON a.id = c.answer_id WHERE c.id = ?`).get(citationId);
    if (!row) throw new NotFoundError('未找到该引用网页。');
    return { id: row.id, answerId: row.answer_id, platformRunId: row.platform_run_id, position: row.position, title: row.title, url: row.url,
      domain: row.domain, citationFragments: parseJson(row.citation_fragments_json), citationOccurrences: row.citation_occurrences,
      brandMentioned: toBoolean(row.brand_mentioned), matchedTerms: parseJson(row.matched_terms_json, []), createdAt: row.created_at };
  }

  getPendingPlatformRuns(runId) {
    this.getRun(runId);
    return this.database.prepare(`SELECT pr.*, p.text AS prompt_text, r.cancel_requested_at
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
    const sourceAnalysis = analyzeSourceMentions(brand, result.citations ?? [], analysis);
    const sourceRowsByUrl = new Map(sourceAnalysis.rows.map((row) => [row.url, row]));
    const write = this.database.transaction(() => {
      this.database.prepare(`UPDATE platform_runs SET status = 'completed', completed_at = ?, error_message = NULL, lease_id = NULL, lease_expires_at = NULL, share_status = ?, share_url = ? WHERE id = ?`).run(timestamp, result.shareStatus ?? 'unavailable', result.shareUrl ?? null, platformRunId);
      const answerId = createId();
      this.database.prepare(`INSERT INTO answers
        (id, platform_run_id, content, response_url, source_panel_opened, platform_reported_count, displayed_source_link_count, captured_card_count, missing_source_indexes_json, brand_mentioned, mention_count, matched_terms_json, recommendation, analysis_confidence, source_mentioned, source_mention_count, source_matched_terms_json, mention_backed_by_source, mention_without_source, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(answerId, platformRunId, result.content ?? '', result.responseUrl ?? null,
        result.sourcePanelOpened ? 1 : 0, result.platformReportedCount ?? null, result.displayedSourceLinkCount ?? null, result.capturedCardCount ?? null,
        JSON.stringify(result.missingSourceIndexes ?? []), analysis.brandMentioned ? 1 : 0, analysis.mentionCount,
        JSON.stringify(analysis.matchedTerms), analysis.recommendation, analysis.analysisConfidence,
        sourceAnalysis.sourceMentioned ? 1 : 0, sourceAnalysis.sourceMentionCount,
        JSON.stringify(sourceAnalysis.sourceMatchedTerms), sourceAnalysis.mentionBackedBySource ? 1 : 0,
        sourceAnalysis.mentionWithoutSource ? 1 : 0, timestamp);
      const citationStatement = this.database.prepare(`INSERT INTO citations
        (id, answer_id, position, title, url, domain, citation_fragments_json, citation_occurrences, brand_mentioned, matched_terms_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const citation of result.citations ?? []) {
        const sourceRow = sourceRowsByUrl.get(citation.url);
        citationStatement.run(createId(), answerId, citation.position, citation.title ?? '', citation.url, citation.domain,
          JSON.stringify(citation.citationFragments ?? []), citation.citationOccurrences ?? 0,
          sourceRow?.mentioned ? 1 : 0, JSON.stringify(sourceRow?.matchedTerms ?? []), timestamp);
      }
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
      p.text AS prompt_text, a.id AS answer_id, a.brand_mentioned, a.mention_count,
      a.recommendation, a.source_panel_opened, a.platform_reported_count,
      a.source_mentioned, a.source_mention_count, a.mention_backed_by_source, a.mention_without_source,
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
      const sourceMentioned = valid.filter((row) => toBoolean(row.source_mentioned)).length;
      const mentionBacked = valid.filter((row) => toBoolean(row.mention_backed_by_source)).length;
      const mentionUnsupported = valid.filter((row) => toBoolean(row.mention_without_source)).length;
      return { checks: items.length, completed: valid.length, mentioned, mentionRate: valid.length ? Math.round((mentioned / valid.length) * 1000) / 10 : null,
        cited, citationRate: valid.length ? Math.round((cited / valid.length) * 1000) / 10 : null,
        citations: items.reduce((total, row) => total + Number(row.citation_occurrences || 0), 0), failures: items.filter((row) => row.status === 'failed').length,
        sourceMentioned, sourceMentionRate: valid.length ? Math.round((sourceMentioned / valid.length) * 1000) / 10 : null,
        mentionBacked, mentionUnsupported,
        sourceBackedRate: valid.length ? Math.round((mentionBacked / valid.length) * 1000) / 10 : null };
    };
    const platformIds = [...new Set(rows.map((row) => row.platform_id))];
    const platforms = platformIds.map((platform) => ({ platform, ...summarize(rows.filter((row) => row.platform_id === platform)) }));
    const promptIds = [...new Set(rows.map((row) => row.prompt_id))];
    const questions = promptIds.map((promptId) => {
      const first = rows.find((row) => row.prompt_id === promptId);
      return { id: promptId, text: first?.prompt_text ?? '', ...summarize(rows.filter((row) => row.prompt_id === promptId)) };
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
      c.brand_mentioned, c.matched_terms_json,
      p.id AS prompt_id, p.text AS prompt_text, a.id AS answer_id
      FROM citations c JOIN answers a ON a.id = c.answer_id JOIN platform_runs pr ON pr.id = a.platform_run_id
      JOIN runs r ON r.id = pr.run_id JOIN prompts p ON p.id = pr.prompt_id
      WHERE r.project_id = ? ${wherePlatform} ORDER BY c.created_at DESC`).all(...params);
    const rows = rawRows.filter((row) => new Date(row.created_at).getTime() >= sinceTime);
    const byUrl = new Map();
    for (const row of rows) {
      const item = byUrl.get(row.url) ?? { url: row.url, title: row.title, domain: row.domain, platforms: [], promptIds: [], prompts: [], citationCount: 0, citationOccurrences: 0, brandMentioned: false, matchedTerms: [], firstSeenAt: row.created_at, lastSeenAt: row.created_at };
      byUrl.set(row.url, item);
      if (row.title && !item.title) item.title = row.title;
      if (!item.platforms.includes(row.platform_id)) item.platforms.push(row.platform_id);
      if (!item.promptIds.includes(row.prompt_id)) { item.promptIds.push(row.prompt_id); item.prompts.push(row.prompt_text); }
      item.citationCount += 1;
      item.citationOccurrences += Number(row.citation_occurrences || 0);
      if (toBoolean(row.brand_mentioned)) item.brandMentioned = true;
      for (const term of parseJson(row.matched_terms_json, [])) {
        if (!item.matchedTerms.includes(term)) item.matchedTerms.push(term);
      }
      if (row.created_at < item.firstSeenAt) item.firstSeenAt = row.created_at;
      if (row.created_at > item.lastSeenAt) item.lastSeenAt = row.created_at;
    }
    const sources = [...byUrl.values()];
    // 自有域名引用：衡量 AI 回答是否引用了品牌自己的站点。
    const owned = analyzeOwnedDomainCitations(sources, { ownedDomains: this.getBrand(brandId).ownedDomains });
    return {
      summary: {
        uniqueUrls: sources.length,
        domains: new Set(sources.map((item) => item.domain)).size,
        citationCount: sources.reduce((total, item) => total + item.citationCount, 0),
        citationOccurrences: sources.reduce((total, item) => total + item.citationOccurrences, 0),
        ownedDomainCitations: owned.count,
        ownedDomainCited: owned.cited,
        sourceMentionedUrls: sources.filter((item) => item.brandMentioned).length,
        sourceMentionedRate: sources.length
          ? Math.round((sources.filter((item) => item.brandMentioned).length / sources.length) * 1000) / 10
          : null,
        periodDays: safeDays,
      },
      ownedDomains: { cited: owned.cited, count: owned.count, citations: owned.citations },
      sources,
    };
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

  // ---- 登录态 Profile ----
  // Profile 是「平台 + 账号」的登录态载体，账号决定 Profile 标识，浏览器数据
  // 目录按平台与 Profile 隔离，互不共享 Cookie。

  listProfiles({ platformId } = {}) {
    const where = platformId ? 'WHERE platform_id = ?' : '';
    const params = platformId ? [platformId] : [];
    return this.database.prepare(`SELECT * FROM profiles ${where} ORDER BY platform_id ASC, created_at ASC`).all(...params).map(mapProfile);
  }

  getProfile(profileId) {
    const profile = mapProfile(this.database.prepare('SELECT * FROM profiles WHERE id = ?').get(profileId));
    if (!profile) throw new NotFoundError('未找到该登录态 Profile。');
    return profile;
  }

  getProfileByBinding(platformId, profileKey) {
    if (!profileKey) return null;
    const row = this.database.prepare('SELECT * FROM profiles WHERE platform_id = ? AND profile_id = ?').get(platformId, profileKey);
    return row ? mapProfile(row) : null;
  }

  findProfileByAccount(platformId, account) {
    if (!account) return null;
    const rows = this.database.prepare('SELECT * FROM profiles WHERE platform_id = ?').all(platformId);
    return rows.map(mapProfile).find((profile) => profile.account && profile.account === account) ?? null;
  }

  createProfile({ platformId, profileKey, account, label = '' }) {
    if (!platformId) throw new ValidationError('platformId 不能为空。');
    const normalizedAccount = normalizeAccountIdentity(account);
    const key = normalizeProfileId(profileKey ?? (normalizedAccount ? profileIdFromAccount(normalizedAccount) : ''));
    if (this.getProfileByBinding(platformId, key)) {
      throw new ValidationError(`${platformId}:${key} 登录态已存在。`);
    }
    const timestamp = now();
    const id = createId();
    this.database.prepare(`INSERT INTO profiles
      (id, platform_id, profile_id, account, label, health, created_at, updated_at)
      VALUES (@id, @platformId, @profileId, @account, @label, 'new', @timestamp, @timestamp)`).run({
      id, platformId, profileId: key, account: normalizedAccount, label: String(label ?? '').trim(),
      timestamp,
    });
    return this.getProfile(id);
  }

  updateProfile(profileId, values = {}) {
    const current = this.getProfile(profileId);
    const health = values.health === undefined ? current.health : String(values.health);
    if (!['new', 'ready', 'expired', 'error', 'restricted', 'disabled'].includes(health)) {
      throw new ValidationError(`未知的登录态状态：${health}。`);
    }
    this.database.prepare(`UPDATE profiles SET account = ?, label = ?, health = ?,
      restricted_until = ?, last_login_at = ?, last_used_at = ?, last_error = ?, updated_at = ? WHERE id = ?`).run(
      values.account === undefined ? current.account : normalizeAccountIdentity(values.account),
      values.label === undefined ? current.label : String(values.label ?? '').trim(),
      health,
      values.restrictedUntil === undefined ? current.restrictedUntil : (values.restrictedUntil || null),
      values.lastLoginAt === undefined ? current.lastLoginAt : (values.lastLoginAt || null),
      values.lastUsedAt === undefined ? current.lastUsedAt : (values.lastUsedAt || null),
      values.lastError === undefined ? current.lastError : (values.lastError || null),
      now(), profileId,
    );
    return this.getProfile(profileId);
  }

  updateProfileByBinding(platformId, profileKey, values = {}) {
    const profile = this.getProfileByBinding(platformId, profileKey);
    if (!profile) return null;
    return this.updateProfile(profile.id, values);
  }

  markProfileUsed(profileId, { health = 'ready', restrictedUntil = null, error = null } = {}) {
    const timestamp = now();
    this.database.prepare(`UPDATE profiles SET health = ?, restricted_until = ?, last_used_at = ?, last_error = ?, updated_at = ?
      WHERE id = ?`).run(health, restrictedUntil, timestamp, error, timestamp, profileId);
    return this.getProfile(profileId);
  }

  // 按「平台 + Profile 标识」更新使用状态，任务侧只持有 Profile 标识。
  markProfileUsedByBinding(platformId, profileKey, { health = 'ready' } = {}) {
    const profile = this.getProfileByBinding(platformId, profileKey);
    if (!profile) return null;
    return this.markProfileUsed(profile.id, { health });
  }

  disableProfile(profileId, reason = '') {
    return this.updateProfile(profileId, { health: 'disabled', lastError: reason || null });
  }

  // 挑选一个可用的登录态：只有已经完成登录并复验通过的 ready Profile 会被自动选中。
  // 未登录、已过期、异常、受限与已停用的 Profile 都不会被自动使用，
  // 需要人工重新登录并把状态改回 ready。
  pickAvailableProfile(platformId, { exclude = [] } = {}) {
    const excluded = new Set(exclude);
    return this.listProfiles({ platformId })
      .filter((profile) => !excluded.has(profile.profileId))
      .filter((profile) => profile.health === 'ready')
      .sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)))[0] ?? null;
  }

  // ---- 平台级冷却（验证码风控） ----

  // 读取平台的冷却状态。冷却中的平台不应再被调度，
  // 否则会持续撞验证码，把账号和整批监测数据一起搭进去。
  getPlatformCooldown(platformId) {
    const row = this.database.prepare('SELECT * FROM platform_cooldowns WHERE platform_id = ?').get(platformId);
    if (!row) return null;
    const cooldownUntil = row.cooldown_until ?? null;
    return {
      platformId: row.platform_id,
      kind: row.kind ?? 'challenge',
      cooldownUntil,
      reason: row.reason ?? '',
      strikeCount: Number(row.strike_count ?? 0),
      coolingDown: Boolean(cooldownUntil && Date.parse(cooldownUntil) > Date.now()),
      updatedAt: row.updated_at,
    };
  }

  // 记录一次验证码拦截。连续命中达到阈值时给平台加冷却，
  // 冷却结束后重新计数；已经处于冷却中时不重复累计。
  recordPlatformChallenge(platformId, { threshold = 3, cooldownMs = 30 * 60_000, reason = '' } = {}) {
    return this.recordPlatformStrike(platformId, { kind: 'challenge', threshold, cooldownMs, reason });
  }

  // 平台繁忙（排队）同样需要熔断：繁忙时提交的问题不会得到回答，
  // 继续跑只会白白消耗配额并骚扰平台。
  recordPlatformBusy(platformId, { threshold = 1, cooldownMs = 10 * 60_000, reason = '' } = {}) {
    return this.recordPlatformStrike(platformId, { kind: 'busy', threshold, cooldownMs, reason });
  }

  // 记录一次平台级熔断。验证码与繁忙是两个维度，各自独立计数：
  // 切换维度时重新开始累计，冷却期间不再累加。
  recordPlatformStrike(platformId, { kind = 'challenge', threshold = 3, cooldownMs = 30 * 60_000, reason = '' } = {}) {
    const timestamp = now();
    const current = this.getPlatformCooldown(platformId);
    if (current?.coolingDown) return { ...current, coolingDown: true };
    const sameKind = current?.kind === kind;
    const strikeCount = sameKind ? (current?.strikeCount ?? 0) + 1 : 1;
    if (strikeCount < threshold) {
      this.database.prepare(`INSERT INTO platform_cooldowns (platform_id, kind, cooldown_until, reason, strike_count, updated_at)
        VALUES (?, ?, NULL, ?, ?, ?) ON CONFLICT(platform_id) DO UPDATE SET kind = excluded.kind, reason = excluded.reason,
        strike_count = excluded.strike_count, updated_at = excluded.updated_at`)
        .run(platformId, kind, reason, strikeCount, timestamp);
      return { platformId, kind, cooldownUntil: null, reason, strikeCount, coolingDown: false, updatedAt: timestamp };
    }
    const cooldownUntil = new Date(Date.now() + cooldownMs).toISOString();
    this.database.prepare(`INSERT INTO platform_cooldowns (platform_id, kind, cooldown_until, reason, strike_count, updated_at)
      VALUES (?, ?, ?, ?, 0, ?) ON CONFLICT(platform_id) DO UPDATE SET kind = excluded.kind, cooldown_until = excluded.cooldown_until,
      reason = excluded.reason, strike_count = 0, updated_at = excluded.updated_at`)
      .run(platformId, kind, cooldownUntil, reason, timestamp);
    return { platformId, kind, cooldownUntil, reason, strikeCount: 0, coolingDown: true, updatedAt: timestamp };
  }

  // 手动解除平台冷却。
  clearPlatformCooldown(platformId) {
    this.database.prepare('DELETE FROM platform_cooldowns WHERE platform_id = ?').run(platformId);
    return this.getPlatformCooldown(platformId);
  }

  // ---- 动态共享队列（租约 / 心跳） ----

  claimNextPlatformRun(runId, platformId, { leaseId, leaseExpiresAt }) {
    const claim = this.database.transaction(() => {
      const row = this.database.prepare(`SELECT pr.*, p.text AS prompt_text
        FROM platform_runs pr JOIN prompts p ON p.id = pr.prompt_id
        WHERE pr.run_id = ? AND pr.platform_id = ? AND pr.status = 'queued' ORDER BY pr.created_at ASC LIMIT 1`).get(runId, platformId);
      if (!row) return null;
      const updated = this.database.prepare(`UPDATE platform_runs
        SET status = 'running', lease_id = ?, lease_expires_at = ?, attempts = attempts + 1,
            started_at = COALESCE(started_at, ?), error_message = NULL
        WHERE id = ? AND status = 'queued'`).run(leaseId, leaseExpiresAt, now(), row.id);
      if (!updated.changes) return null;
      return this.database.prepare(`SELECT pr.*, p.text AS prompt_text
        FROM platform_runs pr JOIN prompts p ON p.id = pr.prompt_id WHERE pr.id = ?`).get(row.id);
    })();
    return claim ? mapPlatformRun(claim) : null;
  }

  heartbeatPlatformRun(platformRunId, { leaseId, leaseExpiresAt }) {
    const result = this.database.prepare(`UPDATE platform_runs SET lease_expires_at = ?
      WHERE id = ? AND lease_id = ? AND status = 'running'`).run(leaseExpiresAt, platformRunId, leaseId);
    return result.changes > 0;
  }

  completePlatformRunClaim(platformRunId, leaseId) {
    const result = this.database.prepare(`UPDATE platform_runs
      SET status = 'completed', lease_id = NULL, lease_expires_at = NULL, completed_at = ?
      WHERE id = ? AND lease_id = ?`).run(now(), platformRunId, leaseId);
    return result.changes > 0;
  }

  // 失败后回到队列等待重试；超过最大尝试次数则标记为最终失败。
  failPlatformRunClaim(platformRunId, leaseId, errorMessage, { maxAttempts = 3 } = {}) {
    const row = this.database.prepare('SELECT attempts FROM platform_runs WHERE id = ?').get(platformRunId);
    const attempts = Number(row?.attempts ?? 0);
    if (attempts >= maxAttempts) {
      this.database.prepare(`UPDATE platform_runs SET status = 'failed', error_message = ?, lease_id = NULL,
        lease_expires_at = NULL, completed_at = ? WHERE id = ?`).run(errorMessage, now(), platformRunId);
      return { requeued: false, status: 'failed', attempts };
    }
    this.database.prepare(`UPDATE platform_runs SET status = 'queued', error_message = ?, lease_id = NULL,
      lease_expires_at = NULL WHERE id = ?`).run(errorMessage, platformRunId);
    return { requeued: true, status: 'queued', attempts };
  }

  // 租约过期的任务重新入队，用于恢复崩溃 Worker 遗留的工作。
  expirePlatformRunClaims(timestamp = now()) {
    const result = this.database.prepare(`UPDATE platform_runs SET status = 'queued', lease_id = NULL,
      lease_expires_at = NULL, error_message = '上一次执行中断，已重新排队。'
      WHERE status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at < ?`).run(timestamp);
    return result.changes;
  }

  requeuePlatformRunsForProfile(platformId, profileId, reason) {
    const result = this.database.prepare(`UPDATE platform_runs SET status = 'queued', profile_id = '',
      lease_id = NULL, lease_expires_at = NULL, error_message = ?
      WHERE platform_id = ? AND profile_id = ? AND status IN ('queued', 'running')`).run(reason, platformId, profileId);
    return result.changes;
  }

  assignPlatformRunProfile(platformRunId, profileId) {
    this.database.prepare('UPDATE platform_runs SET profile_id = ? WHERE id = ?').run(profileId, platformRunId);
  }

  setPlatformRunShare(platformRunId, { status, url = null }) {
    this.database.prepare('UPDATE platform_runs SET share_status = ?, share_url = ? WHERE id = ?')
      .run(status, url, platformRunId);
  }

  setPlatformRunRestricted(platformRunId, restrictedUntil) {
    this.database.prepare('UPDATE platform_runs SET restricted_until = ? WHERE id = ?').run(restrictedUntil, platformRunId);
  }

  summarizeRunQueue(runId) {
    const rows = this.database.prepare(`SELECT platform_id, status, COUNT(*) AS total
      FROM platform_runs WHERE run_id = ? GROUP BY platform_id, status`).all(runId);
    const platforms = new Map();
    for (const row of rows) {
      const entry = platforms.get(row.platform_id) ?? { platformId: row.platform_id, queued: 0, running: 0, completed: 0, failed: 0, cancelled: 0 };
      entry[row.status] = row.total;
      platforms.set(row.platform_id, entry);
    }
    return [...platforms.values()];
  }
}