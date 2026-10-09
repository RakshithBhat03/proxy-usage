/**
 * `POST /api/account-window-usage`: per-credential usage inside quota windows (up to 400 per call).
 * Request/response shape of CPA Manager Plus's `monitoring/account-window-usage` (MIT), with simpler
 * credential matching: events match by `auth_index` when the target has one, else by
 * `auth_file_snapshot` (else `source`). An optional `model_scope` narrows the counted models.
 */
import type { DatabaseSync } from 'node:sqlite';
import { analyticsModel } from '../../shared/model-identity.ts';
import { num, ratio, str } from './sql.ts';
import { ValidationError } from './validate.ts';

export const MAX_ACCOUNT_WINDOWS = 400;

export interface ModelScope {
  kind: string;
  key: string;
  models: string[];
  complete: boolean;
}

export interface WindowTarget {
  index: number;
  requestKey: string;
  rowKey: string;
  windowKey: string;
  providerWindowId: string;
  period: string;
  fromMs: number;
  toMs: number;
  scope: ModelScope;
  match: { column: 'auth_index' | 'auth_file_snapshot' | 'source'; value: string };
}

export interface AccountWindowUsageItem {
  request_key: string;
  row_key: string;
  window_key?: string;
  provider_window_id: string;
  period: string;
  from_ms: number;
  to_ms: number;
  matched: boolean;
  total_requests: number;
  success_calls: number;
  failure_calls: number;
  total_tokens: number;
  total_cost: number;
  success_rate: number | null;
  last_seen_ms: number | null;
  sync_status: 'ready' | 'empty';
  scope_match_status: 'complete' | 'partial' | 'unmatched';
  unmatched_requests: number;
}

export interface AccountWindowUsageResponse {
  generated_at_ms: number;
  items: AccountWindowUsageItem[];
}

type Obj = Record<string, unknown>;
const isObj = (value: unknown): value is Obj => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');

export function normalizeModelId(value: string): string {
  return analyticsModel(value.trim()).trim().toLowerCase();
}

/** CPAMP `normalizeAccountWindowModelScope`; returns null for an invalid scope. */
export function normalizeModelScope(raw: unknown): ModelScope | null {
  if (raw === undefined || raw === null) return { kind: 'all', key: '', models: [], complete: true };
  if (!isObj(raw)) return null;
  const kind = text(raw.kind).toLowerCase();
  if (!kind) return null;
  if (!['all', 'family', 'models', 'product', 'feature'].includes(kind)) return null;
  const key = text(raw.key).toLowerCase();
  const models = [...new Set((Array.isArray(raw.models) ? raw.models : []).filter((m): m is string => typeof m === 'string').map(normalizeModelId).filter(Boolean))];
  if (kind === 'models' && models.length === 0) return null;
  if ((kind === 'family' || kind === 'product' || kind === 'feature') && !key && models.length === 0) return null;
  let complete = raw.complete === true;
  if (!('complete' in raw) && (kind === 'all' || kind === 'family' || kind === 'models')) complete = true;
  return { kind, key, models, complete };
}

function classifyFamily(model: string): string {
  const id = normalizeModelId(model);
  if (!id) return 'unknown';
  if (id.includes('claude') || id.includes('gpt') || id.includes('o1') || id.includes('o3') || id.includes('o4')) return 'claude_gpt';
  if (id.includes('gemini')) return 'gemini';
  return 'unknown';
}

/** [matched, unmatched] for one (model, billing model) group under a scope. */
export function matchScope(model: string, billingModel: string, scope: ModelScope): [boolean, boolean] {
  if (!scope.complete) return [false, false];
  if (scope.kind === 'all') return [true, false];
  const modelId = normalizeModelId(billingModel) || normalizeModelId(model);
  if (scope.kind === 'family' && scope.key === 'codex_main') {
    if (!modelId) return [false, true];
    return [modelId !== 'gpt-5.3-codex-spark', false];
  }
  if (scope.models.length > 0) {
    if (!modelId) return [false, true];
    return [scope.models.includes(modelId), false];
  }
  if (scope.kind !== 'family') return [false, false];
  const rowModels = normalizeModelId(billingModel) ? [billingModel] : [model, billingModel];
  const families = new Set(rowModels.map(classifyFamily));
  if (families.has(scope.key)) return [true, false];
  return [false, families.has('unknown')];
}

function normalizePeriod(value: unknown): string {
  const period = text(value).toLowerCase();
  if (!period) return 'current';
  return ['current', 'previous', 'previous_equal_range'].includes(period) ? period : '';
}

function intOf(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) ? value : 0;
}

export function parseAccountWindowRequest(body: unknown): WindowTarget[] {
  if (!isObj(body) || !Array.isArray(body.windows) || body.windows.length === 0) {
    throw new ValidationError('invalid_request', 'windows are required');
  }
  if (body.windows.length > MAX_ACCOUNT_WINDOWS) {
    throw new ValidationError('invalid_request', `windows must be less than or equal to ${MAX_ACCOUNT_WINDOWS}`);
  }
  return body.windows.map((raw, index): WindowTarget => {
    if (!isObj(raw)) throw new ValidationError('invalid_request', 'each window must be an object');
    const rowKey = text(raw.row_key);
    if (!rowKey) throw new ValidationError('invalid_request', 'row_key is required');
    const windowKey = text(raw.window_key);
    const providerWindowId = text(raw.provider_window_id) || windowKey;
    if (!providerWindowId) throw new ValidationError('invalid_request', 'provider_window_id is required');
    const period = normalizePeriod(raw.period);
    if (!period) throw new ValidationError('invalid_request', 'period must be current, previous, or previous_equal_range');
    const scope = normalizeModelScope(raw.model_scope);
    if (!scope) throw new ValidationError('invalid_request', 'model_scope is invalid');
    const fromMs = intOf(raw.from_ms);
    const toMs = intOf(raw.to_ms);
    if (fromMs <= 0 || toMs <= 0 || fromMs >= toMs) {
      throw new ValidationError('invalid_request', 'from_ms and to_ms are required and from_ms must be less than to_ms');
    }
    const authIndex = text(raw.auth_index);
    const authFile = text(raw.auth_file_snapshot);
    const source = text(raw.source);
    const match = authIndex
      ? ({ column: 'auth_index', value: authIndex } as const)
      : authFile
        ? ({ column: 'auth_file_snapshot', value: authFile } as const)
        : source
          ? ({ column: 'source', value: source } as const)
          : null;
    if (!match) throw new ValidationError('invalid_request', 'account target credential identity is required');
    const requestKey = text(raw.request_key) || [rowKey, providerWindowId, scope.key, period].join('\u0000');
    return { index, requestKey, rowKey, windowKey, providerWindowId, period, fromMs, toMs, scope, match };
  });
}

interface GroupRow {
  idx: number;
  model: string;
  billing: string;
  calls: number;
  success: number;
  failure: number;
  tokens: number;
  cost: number;
  last_seen: number;
}

/** Per window × (model, billing model) totals; one indexed range lookup per window. */
function windowGroups(db: DatabaseSync, targets: WindowTarget[]): GroupRow[] {
  const out: GroupRow[] = [];
  for (const column of ['auth_index', 'auth_file_snapshot', 'source'] as const) {
    const chosen = targets.filter((target) => target.match.column === column);
    for (let offset = 0; offset < chosen.length; offset += 200) {
      const chunk = chosen.slice(offset, offset + 200);
      const values = chunk.map(() => '(?, ?, ?, ?)').join(', ');
      const params = chunk.flatMap((target) => [target.index, target.fromMs, target.toMs, target.match.value]);
      const rows = db
        .prepare(
          `WITH w(idx, from_ms, to_ms, value) AS (VALUES ${values})
          SELECT w.idx AS idx, e.analytics_model AS model,
            coalesce(nullif(e.resolved_model, ''), e.analytics_model) AS billing,
            count(*) AS calls, coalesce(sum(e.failed = 0), 0) AS success, coalesce(sum(e.failed = 1), 0) AS failure,
            coalesce(sum(e.total_tokens), 0) AS tokens, total(e.cost_usd) AS cost, max(e.timestamp_ms) AS last_seen
          FROM w JOIN events e ON e.${column} = w.value AND e.timestamp_ms >= w.from_ms AND e.timestamp_ms < w.to_ms
          GROUP BY 1, 2, 3`,
        )
        .all(...params) as Array<Record<string, unknown>>;
      for (const row of rows) {
        out.push({
          idx: num(row.idx),
          model: str(row.model),
          billing: str(row.billing),
          calls: num(row.calls),
          success: num(row.success),
          failure: num(row.failure),
          tokens: num(row.tokens),
          cost: num(row.cost),
          last_seen: num(row.last_seen),
        });
      }
    }
  }
  return out;
}

/** Validates `body` and runs it (tests / single-threaded use). */
export function runAccountWindowUsage(db: DatabaseSync, body: unknown): AccountWindowUsageResponse {
  return runAccountWindowTargets(db, parseAccountWindowRequest(body));
}

export function runAccountWindowTargets(db: DatabaseSync, targets: WindowTarget[]): AccountWindowUsageResponse {
  const totals = new Map<number, { requests: number; success: number; failure: number; tokens: number; cost: number; lastSeen: number }>();
  const unmatched = new Map<number, number>();
  for (const row of windowGroups(db, targets)) {
    const target = targets[row.idx];
    if (!target) continue;
    const [isMatch, isUnmatched] = matchScope(row.model, row.billing, target.scope);
    if (isUnmatched) unmatched.set(row.idx, (unmatched.get(row.idx) ?? 0) + row.calls);
    if (!isMatch) continue;
    let total = totals.get(row.idx);
    if (!total) {
      total = { requests: 0, success: 0, failure: 0, tokens: 0, cost: 0, lastSeen: 0 };
      totals.set(row.idx, total);
    }
    total.requests += row.calls;
    total.success += row.success;
    total.failure += row.failure;
    total.tokens += row.tokens;
    total.cost += row.cost;
    if (row.last_seen > total.lastSeen) total.lastSeen = row.last_seen;
  }
  const items = targets.map((target): AccountWindowUsageItem => {
    const unmatchedRequests = unmatched.get(target.index) ?? 0;
    let status: AccountWindowUsageItem['scope_match_status'] = target.scope.complete ? 'complete' : 'unmatched';
    if (status === 'complete' && unmatchedRequests > 0) status = 'partial';
    const total = totals.get(target.index);
    const item: AccountWindowUsageItem = {
      request_key: target.requestKey,
      row_key: target.rowKey,
      provider_window_id: target.providerWindowId,
      period: target.period,
      from_ms: target.fromMs,
      to_ms: target.toMs,
      matched: Boolean(total),
      total_requests: total?.requests ?? 0,
      success_calls: total?.success ?? 0,
      failure_calls: total?.failure ?? 0,
      total_tokens: total?.tokens ?? 0,
      total_cost: total?.cost ?? 0,
      success_rate: total && total.requests > 0 ? ratio(total.success, total.requests) : null,
      last_seen_ms: total && total.lastSeen > 0 ? total.lastSeen : null,
      sync_status: total ? 'ready' : 'empty',
      scope_match_status: status,
      unmatched_requests: unmatchedRequests,
    };
    if (target.windowKey) item.window_key = target.windowKey;
    return item;
  });
  return { generated_at_ms: Date.now(), items };
}
