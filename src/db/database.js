import { mkdirSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const SCHEMA = `
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    aliases_json TEXT NOT NULL DEFAULT '[]',
    products_json TEXT NOT NULL DEFAULT '[]',
    website TEXT NOT NULL DEFAULT '',
    owned_domains_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS prompts (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_prompts_project_id ON prompts(project_id);

  CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    status TEXT NOT NULL,
    mode TEXT NOT NULL,
    concurrency INTEGER NOT NULL DEFAULT 3,
    append_search_prompt INTEGER NOT NULL DEFAULT 0,
    target_platforms_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    started_at TEXT,
    completed_at TEXT,
    cancel_requested_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_runs_project_id_created_at ON runs(project_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS run_items (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    prompt_id TEXT NOT NULL REFERENCES prompts(id) ON DELETE RESTRICT,
    created_at TEXT NOT NULL,
    UNIQUE(run_id, prompt_id)
  );

  CREATE TABLE IF NOT EXISTS platform_runs (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    prompt_id TEXT NOT NULL REFERENCES prompts(id) ON DELETE RESTRICT,
    platform_id TEXT NOT NULL,
    mode TEXT NOT NULL DEFAULT 'headless',
    status TEXT NOT NULL,
    error_message TEXT,
    started_at TEXT,
    completed_at TEXT,
    created_at TEXT NOT NULL,
    UNIQUE(run_id, prompt_id, platform_id)
  );
  CREATE INDEX IF NOT EXISTS idx_platform_runs_run_id ON platform_runs(run_id);

  CREATE TABLE IF NOT EXISTS answers (
    id TEXT PRIMARY KEY,
    platform_run_id TEXT NOT NULL UNIQUE REFERENCES platform_runs(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    response_url TEXT,
    source_panel_opened INTEGER NOT NULL DEFAULT 0,
    platform_reported_count INTEGER,
    displayed_source_link_count INTEGER,
    captured_card_count INTEGER,
    missing_source_indexes_json TEXT NOT NULL DEFAULT '[]',
    brand_mentioned INTEGER NOT NULL DEFAULT 0,
    mention_count INTEGER NOT NULL DEFAULT 0,
    matched_terms_json TEXT NOT NULL DEFAULT '[]',
    recommendation TEXT NOT NULL DEFAULT 'unknown',
    analysis_confidence REAL NOT NULL DEFAULT 0,
    source_mentioned INTEGER NOT NULL DEFAULT 0,
    source_mention_count INTEGER NOT NULL DEFAULT 0,
    source_matched_terms_json TEXT NOT NULL DEFAULT '[]',
    mention_backed_by_source INTEGER NOT NULL DEFAULT 0,
    mention_without_source INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS citations (
    id TEXT PRIMARY KEY,
    answer_id TEXT NOT NULL REFERENCES answers(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    url TEXT NOT NULL,
    domain TEXT NOT NULL,
    citation_fragments_json TEXT NOT NULL DEFAULT '[]',
    citation_occurrences INTEGER NOT NULL DEFAULT 0,
    brand_mentioned INTEGER NOT NULL DEFAULT 0,
    matched_terms_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    UNIQUE(answer_id, url)
  );
  CREATE INDEX IF NOT EXISTS idx_citations_answer_id ON citations(answer_id);

  CREATE TABLE IF NOT EXISTS artifacts (
    id TEXT PRIMARY KEY,
    platform_run_id TEXT NOT NULL REFERENCES platform_runs(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    relative_path TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_artifacts_platform_run_id ON artifacts(platform_run_id);

  CREATE TABLE IF NOT EXISTS profiles (
    id TEXT PRIMARY KEY,
    platform_id TEXT NOT NULL,
    profile_id TEXT NOT NULL,
    account TEXT NOT NULL DEFAULT '',
    label TEXT NOT NULL DEFAULT '',
    login_method TEXT NOT NULL DEFAULT 'sms_code',
    health TEXT NOT NULL DEFAULT 'new',
    restricted_until TEXT,
    last_login_at TEXT,
    last_used_at TEXT,
    last_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(platform_id, profile_id)
  );
  CREATE INDEX IF NOT EXISTS idx_profiles_platform_id ON profiles(platform_id);

  -- 平台级冷却：连续撞上验证码时先让平台歇一会儿，
  -- 避免继续硬刷把账号搞进风控（DeepSeek 就是这样被禁言的）。
  CREATE TABLE IF NOT EXISTS platform_cooldowns (
    platform_id TEXT PRIMARY KEY,
    kind TEXT NOT NULL DEFAULT 'challenge',
    cooldown_until TEXT,
    reason TEXT NOT NULL DEFAULT '',
    strike_count INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS task_events (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    platform_run_id TEXT REFERENCES platform_runs(id) ON DELETE CASCADE,
    level TEXT NOT NULL,
    message TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_task_events_run_id_created_at ON task_events(run_id, created_at);
`;

function ensureColumn(database, tableName, columnName, definition) {
  const columns = database.pragma(`table_info(${tableName})`);
  if (!columns.some((column) => column.name === columnName)) {
    database.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
  }
}

// 删除已经废弃的列；旧版 SQLite 不支持 DROP COLUMN 时保留旧列，但应用层不再读写它。
function dropColumn(database, tableName, columnName) {
  const columns = database.pragma(`table_info(${tableName})`);
  if (!columns.some((column) => column.name === columnName)) return;
  try {
    database.exec(`ALTER TABLE ${tableName} DROP COLUMN ${columnName}`);
  } catch {
    // 忽略：保留旧列不影响功能。
  }
}

export function openDatabase(databasePath) {
  mkdirSync(path.dirname(databasePath), { recursive: true });
  const database = new Database(databasePath);
  database.pragma('journal_mode = WAL');
  database.pragma('foreign_keys = ON');
  database.exec(SCHEMA);
  // The local database is intentionally disposable, but these additions keep
  // an already-open development database usable while the UI is migrated.
  ensureColumn(database, 'projects', 'aliases_json', "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(database, 'projects', 'products_json', "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(database, 'projects', 'website', "TEXT NOT NULL DEFAULT ''");
  ensureColumn(database, 'projects', 'owned_domains_json', "TEXT NOT NULL DEFAULT '[]'");
  dropColumn(database, 'prompts', 'category');
  ensureColumn(database, 'platform_cooldowns', 'kind', "TEXT NOT NULL DEFAULT 'challenge'");
  ensureColumn(database, 'platform_runs', 'mode', "TEXT NOT NULL DEFAULT 'headless'");
  ensureColumn(database, 'runs', 'concurrency', 'INTEGER NOT NULL DEFAULT 3');
  ensureColumn(database, 'runs', 'append_search_prompt', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(database, 'answers', 'brand_mentioned', "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(database, 'answers', 'captured_card_count', 'INTEGER');
  ensureColumn(database, 'answers', 'displayed_source_link_count', 'INTEGER');
  ensureColumn(database, 'answers', 'missing_source_indexes_json', "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(database, 'answers', 'mention_count', "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(database, 'answers', 'matched_terms_json', "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(database, 'answers', 'recommendation', "TEXT NOT NULL DEFAULT 'unknown'");
  ensureColumn(database, 'answers', 'analysis_confidence', "REAL NOT NULL DEFAULT 0");
  ensureColumn(database, 'answers', 'source_mentioned', "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(database, 'answers', 'source_mention_count', "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(database, 'answers', 'source_matched_terms_json', "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(database, 'answers', 'mention_backed_by_source', "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(database, 'answers', 'mention_without_source', "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(database, 'citations', 'brand_mentioned', "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(database, 'citations', 'matched_terms_json', "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(database, 'platform_runs', 'profile_id', "TEXT NOT NULL DEFAULT ''");
  ensureColumn(database, 'platform_runs', 'share_status', "TEXT NOT NULL DEFAULT 'unavailable'");
  ensureColumn(database, 'platform_runs', 'share_url', 'TEXT');
  ensureColumn(database, 'platform_runs', 'restricted_until', 'TEXT');
  ensureColumn(database, 'platform_runs', 'attempts', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(database, 'platform_runs', 'lease_id', 'TEXT');
  ensureColumn(database, 'platform_runs', 'lease_expires_at', 'TEXT');
  return database;
}
