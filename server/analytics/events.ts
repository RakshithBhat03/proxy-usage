/**
 * Raw event pages (`events_page`, `drilldown_preview`). Rows are written straight to JSON text with
 * `response_metadata_json` spliced in raw, so a 50k-row page never goes through object
 * materialization + JSON.stringify. Field presence follows CPA Manager Plus's Go `omitempty` tags.
 * Cost is not part of `EventRow`.
 */
import type { DatabaseSync } from 'node:sqlite';
import { COMPAT_CACHED, NORM_INPUT, PROJECT_ID } from './sql.ts';
import { buildWhere, type Scope } from './where.ts';

const COLUMNS = `id,
  coalesce(request_id, ''),
  event_hash,
  timestamp_ms,
  model,
  analytics_model,
  coalesce(nullif(requested_model, ''), model, ''),
  coalesce(resolved_model, ''),
  coalesce(response_model, ''),
  coalesce(session_id, ''),
  coalesce(parent_session_id, ''),
  coalesce(access_token_sha256, ''),
  generate,
  stream,
  coalesce(endpoint, ''),
  coalesce(method, ''),
  coalesce(path, ''),
  coalesce(client_ip, ''),
  coalesce(x_forwarded_for, ''),
  coalesce(user_agent, ''),
  coalesce(auth_index, ''),
  coalesce(source, ''),
  coalesce(source_hash, ''),
  coalesce(api_key_hash, ''),
  coalesce(account_snapshot, ''),
  coalesce(auth_label_snapshot, ''),
  coalesce(auth_file_snapshot, ''),
  coalesce(nullif(auth_provider_snapshot, ''), provider, ''),
  coalesce(auth_account_id_snapshot, ''),
  ${PROJECT_ID},
  coalesce(reasoning_effort, ''),
  coalesce(service_tier, ''),
  coalesce(executor_type, ''),
  ${NORM_INPUT},
  output_tokens,
  ${COMPAT_CACHED},
  cache_read_tokens,
  cache_creation_tokens,
  reasoning_tokens,
  total_tokens,
  latency_ms,
  ttft_ms,
  failed,
  fail_status_code,
  coalesce(fail_summary, ''),
  CASE WHEN response_metadata_json IS NOT NULL AND response_metadata_json NOT IN ('', '{}', 'null')
    AND json_valid(response_metadata_json) THEN response_metadata_json END,
  header_quota_recover_at_ms,
  header_quota_used_percent,
  coalesce(header_quota_plan_type, ''),
  coalesce(header_error_kind, ''),
  coalesce(header_error_code, ''),
  coalesce(header_trace_id, '')`;

const q = JSON.stringify;

function optStr(out: string[], key: string, value: unknown): void {
  if (typeof value === 'string' && value !== '') out.push(`,"${key}":${q(value)}`);
}

function optNum(out: string[], key: string, value: unknown): void {
  if (value !== null && value !== undefined) out.push(`,"${key}":${Number(value)}`);
}

function optBool(out: string[], key: string, value: unknown): void {
  if (value !== null && value !== undefined) out.push(`,"${key}":${Number(value) !== 0}`);
}

function nullableNum(value: unknown): string {
  return value === null || value === undefined ? 'null' : String(Number(value));
}

/** One event row as JSON (an `EventRow`). */
function rowJson(r: unknown[]): string {
  const out: string[] = [];
  out.push('{');
  out.push(r[1] !== '' ? `"request_id":${q(r[1])},` : '');
  out.push(`"event_hash":${q(r[2])},"timestamp_ms":${Number(r[3])},"model":${q(r[4] ?? '')}`);
  optStr(out, 'analytics_model', r[5]);
  optStr(out, 'requested_model', r[6]);
  optStr(out, 'resolved_model', r[7]);
  optStr(out, 'response_model', r[8]);
  optStr(out, 'session_id', r[9]);
  optStr(out, 'parent_session_id', r[10]);
  optStr(out, 'access_token_sha256', r[11]);
  optBool(out, 'generate', r[12]);
  optBool(out, 'stream', r[13]);
  out.push(`,"endpoint":${q(r[14])},"method":${q(r[15])},"path":${q(r[16])}`);
  optStr(out, 'client_ip', r[17]);
  optStr(out, 'x_forwarded_for', r[18]);
  optStr(out, 'user_agent', r[19]);
  out.push(
    `,"auth_index":${q(r[20])},"source":${q(r[21])},"source_hash":${q(r[22])},"api_key_hash":${q(r[23])}` +
      `,"account_snapshot":${q(r[24])},"auth_label_snapshot":${q(r[25])}`,
  );
  optStr(out, 'auth_file_snapshot', r[26]);
  out.push(`,"auth_provider_snapshot":${q(r[27])}`);
  optStr(out, 'auth_account_id_snapshot', r[28]);
  optStr(out, 'auth_project_id_snapshot', r[29]);
  optStr(out, 'reasoning_effort', r[30]);
  optStr(out, 'service_tier', r[31]);
  optStr(out, 'executor_type', r[32]);
  out.push(
    `,"input_tokens":${Number(r[33])},"output_tokens":${Number(r[34])},"cached_tokens":${Number(r[35])}` +
      `,"cache_read_tokens":${Number(r[36])},"cache_creation_tokens":${Number(r[37])}` +
      `,"reasoning_tokens":${Number(r[38])},"total_tokens":${Number(r[39])}` +
      `,"latency_ms":${nullableNum(r[40])},"ttft_ms":${nullableNum(r[41])},"failed":${Number(r[42]) !== 0}`,
  );
  optNum(out, 'fail_status_code', r[43]);
  optStr(out, 'fail_summary', r[44]);
  if (typeof r[45] === 'string') out.push(`,"response_metadata":${r[45]}`);
  optNum(out, 'header_quota_recover_at_ms', r[46]);
  optNum(out, 'header_quota_used_percent', r[47]);
  optStr(out, 'header_quota_plan_type', r[48]);
  optStr(out, 'header_error_kind', r[49]);
  optStr(out, 'header_error_code', r[50]);
  optStr(out, 'header_trace_id', r[51]);
  out.push('}');
  return out.join('');
}

export interface EventsPageResult {
  /** JSON text of the `items` array. */
  itemsJson: string;
  count: number;
  nextBeforeMs: number;
  nextBeforeId: number;
  hasMore: boolean;
}

/**
 * Newest-first page (ORDER BY timestamp_ms DESC, id DESC) with a keyset cursor: rows strictly before
 * (beforeMs, beforeId). `beforeId <= 0` falls back to a timestamp-only cursor.
 */
export function eventsPage(
  db: DatabaseSync,
  scope: Scope,
  range: { fromMs: number; toMs: number },
  cursor: { beforeMs: number; beforeId: number },
  limit: number,
): EventsPageResult {
  const where = buildWhere(scope, range);
  let sql = where.sql;
  const params = [...where.params];
  if (cursor.beforeMs > 0) {
    if (cursor.beforeId > 0) {
      sql += ' AND (timestamp_ms < ? OR (timestamp_ms = ? AND id < ?))';
      params.push(cursor.beforeMs, cursor.beforeMs, cursor.beforeId);
    } else {
      sql += ' AND timestamp_ms < ?';
      params.push(cursor.beforeMs);
    }
  }
  params.push(limit + 1);
  const stmt = db.prepare(`SELECT ${COLUMNS} FROM events ${sql} ORDER BY timestamp_ms DESC, id DESC LIMIT ?`);
  stmt.setReturnArrays(true);
  const parts: string[] = [];
  let lastMs = 0;
  let lastId = 0;
  let hasMore = false;
  for (const row of stmt.iterate(...params) as Iterable<unknown[]>) {
    if (parts.length === limit) {
      hasMore = true;
      break;
    }
    parts.push(rowJson(row));
    lastId = Number(row[0]);
    lastMs = Number(row[3]);
  }
  return {
    itemsJson: `[${parts.join(',')}]`,
    count: parts.length,
    nextBeforeMs: hasMore ? lastMs : 0,
    nextBeforeId: hasMore ? lastId : 0,
    hasMore,
  };
}

export function eventsResponseJson(page: EventsPageResult, totalCount: number): string {
  return (
    `{"items":${page.itemsJson},"next_before_ms":${page.nextBeforeMs},"next_before_id":${page.nextBeforeId},` +
    `"has_more":${page.hasMore},"total_count":${totalCount}}`
  );
}
