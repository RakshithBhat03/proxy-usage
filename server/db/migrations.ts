/**
 * Schema migrations keyed by `PRAGMA user_version`. Each migration runs in its own transaction and
 * is never edited once released: add a new entry instead.
 *
 * `events` keeps CPA Manager Plus `usage_events` column names wherever they overlap, so a one-off
 * import is a plain `INSERT OR IGNORE INTO events (...) SELECT ... FROM usage_events`. Deliberately
 * not carried over: `raw_json` and `fail_body` (may hold secrets or prompt text). Raw client API keys
 * are never stored, only `api_key_hash` (sha256 hex).
 */
import type { DatabaseSync } from 'node:sqlite';

export interface Migration {
  version: number;
  name: string;
  up(db: DatabaseSync): void;
}

/** SQL for the normalized service tier, matching `normalizeServiceTier` in shared/model-identity.ts. */
const TIER_KEY_SQL = `CASE
    WHEN lower(trim(coalesce(service_tier, ''))) IN ('', 'auto', 'default', 'standard', 'standard_only') THEN 'normal'
    WHEN lower(trim(service_tier)) IN ('priority', 'fast') THEN 'fast'
    ELSE lower(trim(service_tier))
  END`;

const V1_EVENTS = `
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  -- identity / dedupe (event_hash uses CPA Manager Plus's formula so imports dedupe too)
  request_id TEXT,
  event_hash TEXT NOT NULL UNIQUE,
  timestamp_ms INTEGER NOT NULL,          -- request time (epoch ms)
  timestamp TEXT NOT NULL,                -- original RFC 3339 timestamp from CPA
  received_at_ms INTEGER NOT NULL,        -- when this server received the record
  created_at_ms INTEGER NOT NULL,         -- row insert time
  -- routing
  provider TEXT,
  executor_type TEXT,
  model TEXT NOT NULL,
  analytics_model TEXT NOT NULL DEFAULT '',  -- analyticsModelForRequest(model, requested_model)
  requested_model TEXT,
  resolved_model TEXT,
  response_model TEXT,
  endpoint TEXT,                          -- "POST /v1/messages"
  method TEXT,
  path TEXT,
  client_ip TEXT,
  x_forwarded_for TEXT,
  user_agent TEXT,
  -- credential / client
  auth_type TEXT,
  auth_index TEXT,
  source TEXT,                            -- masked source label
  source_hash TEXT,
  api_key_hash TEXT,                      -- sha256 hex of the client API key; raw key never stored
  account_snapshot TEXT,
  auth_label_snapshot TEXT,
  auth_file_snapshot TEXT,
  auth_provider_snapshot TEXT,
  auth_account_id_snapshot TEXT,
  auth_project_id_snapshot TEXT,
  auth_snapshot_at_ms INTEGER,
  -- request options
  reasoning_effort TEXT,
  service_tier TEXT,
  request_service_tier TEXT,
  response_service_tier TEXT,
  cache_input_mode TEXT,
  session_id TEXT,
  parent_session_id TEXT,
  access_token_sha256 TEXT,
  generate INTEGER,
  stream INTEGER,
  trace_id TEXT,
  execution_id TEXT,
  node_kind TEXT,
  is_fork INTEGER,
  is_compaction INTEGER,
  -- tokens (input_tokens is the normalized total input, including cache buckets)
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0,
  cached_tokens INTEGER NOT NULL DEFAULT 0,
  cache_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
  normalized_uncached_input_tokens INTEGER,
  normalized_total_input_tokens INTEGER,
  normalized_cache_read_tokens INTEGER,
  normalized_cache_creation_tokens INTEGER,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  raw_tokens_json TEXT,                   -- CPA's token object as received
  -- outcome / timing
  latency_ms INTEGER,
  ttft_ms INTEGER,
  failed INTEGER NOT NULL DEFAULT 0,
  fail_status_code INTEGER,
  fail_summary TEXT,                      -- redacted, length-capped summary (no raw body)
  -- parsed upstream response headers
  response_metadata_json TEXT,
  header_quota_recover_at_ms INTEGER,
  header_quota_used_percent REAL,
  header_quota_plan_type TEXT,
  header_error_kind TEXT,
  header_error_code TEXT,
  header_trace_id TEXT,
  -- derived
  search_text TEXT NOT NULL DEFAULT '',   -- lower-cased haystack for search_query LIKE
  cost_usd REAL,                          -- NULL = no price for the model
  cost_revision INTEGER NOT NULL DEFAULT 0, -- pricing revision cost_usd was computed with (0 = never)
  credential_id TEXT GENERATED ALWAYS AS (
    coalesce(nullif(auth_file_snapshot, ''), nullif(auth_index, ''), nullif(source_hash, ''), nullif(source, ''), '-')
  ) VIRTUAL,
  provider_key TEXT GENERATED ALWAYS AS (
    lower(trim(coalesce(nullif(trim(provider), ''), nullif(trim(auth_provider_snapshot), ''), '')))
  ) VIRTUAL,
  tier_key TEXT GENERATED ALWAYS AS (${TIER_KEY_SQL}) VIRTUAL
)`;

const V1_EVENT_INDEXES = [
  'CREATE INDEX idx_events_ts ON events(timestamp_ms, id)',
  'CREATE INDEX idx_events_auth ON events(auth_index, timestamp_ms)',
  'CREATE INDEX idx_events_auth_file ON events(auth_file_snapshot, timestamp_ms)',
  'CREATE INDEX idx_events_model ON events(analytics_model, timestamp_ms)',
  'CREATE INDEX idx_events_credential ON events(credential_id, timestamp_ms)',
  'CREATE INDEX idx_events_api_key ON events(api_key_hash, timestamp_ms)',
  'CREATE INDEX idx_events_provider ON events(provider_key, timestamp_ms)',
  'CREATE INDEX idx_events_request_id ON events(request_id)',
  'CREATE INDEX idx_events_failed_ts ON events(timestamp_ms) WHERE failed = 1',
  'CREATE INDEX idx_events_cost_revision ON events(cost_revision)',
];

const V1_OTHER = [
  // Latest auth-file metadata from CPA, keyed by auth index; used to enrich events and labels.
  `CREATE TABLE auth_snapshots (
    auth_index TEXT PRIMARY KEY,
    file_name TEXT,
    provider TEXT,
    label TEXT,
    account TEXT,
    account_id TEXT,
    project_id TEXT,
    status TEXT,
    disabled INTEGER NOT NULL DEFAULT 0,
    metadata_json TEXT,                   -- non-secret fields only
    first_seen_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
  )`,
  'CREATE INDEX idx_auth_snapshots_file ON auth_snapshots(file_name)',
  // Price book (USD per 1M tokens). Columns match CPA Manager Plus where they overlap; tiers are
  // stored inline as JSON arrays of ContextTier / ServiceTierRule (shared/pricing-types.ts).
  `CREATE TABLE model_prices (
    model TEXT PRIMARY KEY,
    prompt_per_1m REAL NOT NULL DEFAULT 0,
    completion_per_1m REAL NOT NULL DEFAULT 0,
    cache_per_1m REAL NOT NULL DEFAULT 0,
    cache_read_per_1m REAL NOT NULL DEFAULT 0,
    cache_creation_per_1m REAL NOT NULL DEFAULT 0,
    prompt_configured INTEGER NOT NULL DEFAULT 0,
    completion_configured INTEGER NOT NULL DEFAULT 0,
    cache_configured INTEGER NOT NULL DEFAULT 0,
    cache_read_configured INTEGER NOT NULL DEFAULT 0,
    cache_creation_configured INTEGER NOT NULL DEFAULT 0,
    context_tiers_json TEXT,
    service_tiers_json TEXT,
    source TEXT,                          -- 'manual' (never overwritten by sync) or the sync source
    source_model_id TEXT,
    raw_json TEXT,
    updated_at_ms INTEGER NOT NULL,
    synced_at_ms INTEGER
  )`,
  // Small key/value store (collector cursors, last sync times, pricing revision ...).
  `CREATE TABLE meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at_ms INTEGER NOT NULL
  )`,
  // Records the collector could not normalize. Payloads must be redacted (no API keys) first.
  `CREATE TABLE dead_letters (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT,                          -- 'resp' | 'http' | 'import'
    payload TEXT NOT NULL,
    error TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL
  )`,
  'CREATE INDEX idx_dead_letters_created ON dead_letters(created_at_ms)',
];

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'initial schema',
    up(db) {
      db.exec(V1_EVENTS);
      for (const sql of [...V1_EVENT_INDEXES, ...V1_OTHER]) db.exec(sql);
    },
  },
];

export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;

export function schemaVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number } | undefined;
  return Number(row?.user_version ?? 0);
}

/** Applies pending migrations. Throws when the database is newer than this build. */
export function migrate(db: DatabaseSync, migrations: readonly Migration[] = MIGRATIONS): number {
  const current = schemaVersion(db);
  const latest = migrations.length ? migrations[migrations.length - 1].version : 0;
  if (current > latest) {
    throw new Error(`database schema version ${current} is newer than this build supports (${latest})`);
  }
  for (const migration of migrations) {
    if (migration.version <= current) continue;
    db.exec('BEGIN IMMEDIATE');
    try {
      migration.up(db);
      db.exec(`PRAGMA user_version = ${Math.trunc(migration.version)}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(`migration ${migration.version} (${migration.name}) failed: ${(err as Error).message}`, {
        cause: err,
      });
    }
  }
  return schemaVersion(db);
}
