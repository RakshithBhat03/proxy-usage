/**
 * WHERE clause for analytics queries: a port of CPA Manager Plus's `analyticsWhere` (MIT) onto this
 * schema's derived columns (`analytics_model`, `credential_id`, `provider_key`, `search_text`).
 *
 * Time range is half-open [from, to). Arrays are OR within a field and AND across fields; values are
 * trimmed and de-duplicated, and empty arrays are ignored.
 */
import { analyticsModel } from '../../shared/model-identity.ts';
import { PROJECT_ID } from './sql.ts';

/** Normalized filters (see `validate.ts`). */
export interface Filters {
  models: string[];
  providers: string[];
  accounts: string[];
  credentialIds: string[];
  authFiles: string[];
  authIndices: string[];
  apiKeyHashes: string[];
  sourceHashes: string[];
  projectIds: string[];
  requestTypes: string[];
  headerErrorKinds: string[];
  headerErrorCodes: string[];
  headerQuotaPlans: string[];
  headerTraceIds: string[];
  includeFailed: boolean;
  failedOnly: boolean;
  minLatencyMs: number;
  cacheStatus: string;
}

export interface Scope {
  fromMs: number;
  toMs: number;
  searchQuery: string;
  searchApiKeyHash: string;
  filters: Filters;
}

export type SqlParam = string | number;

export interface Where {
  sql: string;
  params: SqlParam[];
}

export function emptyFilters(): Filters {
  return {
    models: [],
    providers: [],
    accounts: [],
    credentialIds: [],
    authFiles: [],
    authIndices: [],
    apiKeyHashes: [],
    sourceHashes: [],
    projectIds: [],
    requestTypes: [],
    headerErrorKinds: [],
    headerErrorCodes: [],
    headerQuotaPlans: [],
    headerTraceIds: [],
    includeFailed: true,
    failedOnly: false,
    minLatencyMs: 0,
    cacheStatus: '',
  };
}

/** Trim, drop empties, de-duplicate (first occurrence wins). */
export function normalizeValues(values: readonly string[] | undefined): string[] {
  const seen = new Set<string>();
  for (const value of values ?? []) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed) seen.add(trimmed);
  }
  return [...seen];
}

export function normalizeModelValues(values: readonly string[] | undefined): string[] {
  return normalizeValues(normalizeValues(values).map((value) => analyticsModel(value)));
}

export function normalizeLowerValues(values: readonly string[] | undefined): string[] {
  return normalizeValues(normalizeValues(values).map((value) => value.toLowerCase()));
}

/** Filters ignored by filter_options / filter_selectors: only range + search apply. */
export function optionScope(scope: Scope): Scope {
  return { ...scope, filters: emptyFilters() };
}

const CACHE_HIT = `(coalesce(cached_tokens, 0) > 0 OR coalesce(cache_tokens, 0) > 0
  OR coalesce(cache_read_tokens, 0) > 0 OR coalesce(cache_creation_tokens, 0) > 0)`;

export function buildWhere(scope: Scope, range: { fromMs: number; toMs: number } = scope): Where {
  const conditions: string[] = ['timestamp_ms >= ?', 'timestamp_ms < ?'];
  const params: SqlParam[] = [range.fromMs, range.toMs];

  const query = scope.searchQuery.trim().toLowerCase();
  const hash = scope.searchApiKeyHash.trim().toLowerCase();
  if (query) {
    if (hash) {
      conditions.push("(search_text LIKE ? OR lower(coalesce(api_key_hash, '')) = ?)");
      params.push(`%${query}%`, hash);
    } else {
      conditions.push('search_text LIKE ?');
      params.push(`%${query}%`);
    }
  } else if (hash) {
    conditions.push("lower(coalesce(api_key_hash, '')) = ?");
    params.push(hash);
  }

  const f = scope.filters;
  const inList = (column: string, values: string[]) => {
    if (values.length === 0) return;
    if (values.length === 1) {
      conditions.push(`${column} = ?`);
      params.push(values[0]);
      return;
    }
    conditions.push(`${column} IN (SELECT value FROM json_each(?))`);
    params.push(JSON.stringify(values));
  };

  inList('analytics_model', f.models);
  if (f.providers.length) {
    // provider_key = lower(provider, else auth provider snapshot); CPAMP also matches the snapshot.
    const json = JSON.stringify(f.providers);
    conditions.push(
      "(provider_key IN (SELECT value FROM json_each(?)) OR lower(trim(coalesce(auth_provider_snapshot, ''))) IN (SELECT value FROM json_each(?)))",
    );
    params.push(json, json);
  }
  if (f.accounts.length) {
    const json = JSON.stringify(f.accounts);
    conditions.push(
      `(lower(coalesce(account_snapshot, '')) IN (SELECT value FROM json_each(?))
        OR lower(coalesce(auth_label_snapshot, '')) IN (SELECT value FROM json_each(?))
        OR lower(coalesce(source, '')) IN (SELECT value FROM json_each(?))
        OR lower(coalesce(auth_index, '')) IN (SELECT value FROM json_each(?)))`,
    );
    params.push(json, json, json, json);
  }
  inList('credential_id', f.credentialIds);
  inList('auth_file_snapshot', f.authFiles);
  inList('auth_index', f.authIndices);
  inList('api_key_hash', f.apiKeyHashes);
  inList('source_hash', f.sourceHashes);
  inList(PROJECT_ID, f.projectIds);
  inList("coalesce(executor_type, '')", f.requestTypes);
  inList("coalesce(header_error_kind, '')", f.headerErrorKinds);
  inList("coalesce(header_error_code, '')", f.headerErrorCodes);
  inList("coalesce(header_quota_plan_type, '')", f.headerQuotaPlans);
  inList("coalesce(header_trace_id, '')", f.headerTraceIds);

  if (!f.includeFailed) conditions.push('failed = 0');
  if (f.failedOnly) conditions.push('failed = 1');
  if (f.minLatencyMs > 0) {
    conditions.push('latency_ms >= ?');
    params.push(f.minLatencyMs);
  }
  switch (f.cacheStatus) {
    case 'hit':
      conditions.push(CACHE_HIT);
      break;
    case 'miss':
      conditions.push(`NOT ${CACHE_HIT}`);
      break;
    case 'read':
      conditions.push('coalesce(cache_read_tokens, 0) > 0');
      break;
    case 'creation':
      conditions.push('coalesce(cache_creation_tokens, 0) > 0');
      break;
  }
  return { sql: `WHERE ${conditions.join(' AND ')}`, params };
}
