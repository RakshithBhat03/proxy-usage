/**
 * SQL building blocks shared by the analytics sections. Token columns are stored normalized (by the
 * collector, and by the CPA Manager Plus import), so aggregates read them directly:
 *  - `input_tokens` is the normalized total input (fresh + cached + cache read + cache creation);
 *  - `cached_tokens` is the legacy/OpenAI-style remainder after removing the fine-grained buckets.
 * Semantics ported from CPA Manager Plus (MIT).
 */
import type { DatabaseSync } from 'node:sqlite';

export const NORM_INPUT = 'input_tokens';
export const COMPAT_CACHED = 'cached_tokens';
/** Display provider of an event (auth snapshot first), not lower-cased. */
export const PROVIDER_LABEL = "coalesce(nullif(auth_provider_snapshot, ''), provider, '')";

const CODEX_ACCOUNT_MARKER = 'codex-account-id:v1:';
/** Project id snapshot with historical Codex account markers removed (not a project id). */
export const PROJECT_ID = `(CASE WHEN lower(replace(trim(coalesce(nullif(auth_provider_snapshot, ''), provider, '')), '_', '-')) = 'codex'
  AND substr(trim(coalesce(auth_project_id_snapshot, '')), 1, ${CODEX_ACCOUNT_MARKER.length}) = '${CODEX_ACCOUNT_MARKER}'
  THEN '' ELSE trim(coalesce(auth_project_id_snapshot, '')) END)`;

export function projectIdSnapshot(provider: string, projectId: string): string {
  const value = projectId.trim();
  if (provider.trim().toLowerCase().replaceAll('_', '-') === 'codex' && value.startsWith(CODEX_ACCOUNT_MARKER)) return '';
  return value;
}

/**
 * Per-group totals used by most sections. Column aliases are read by `readTotals`.
 * `lat_sum`/`lat_n` follow CPAMP's `avg(nullif(latency_ms, 0))`.
 */
export const TOTALS_SQL = `count(*) AS calls,
  coalesce(sum(failed = 0), 0) AS success,
  coalesce(sum(failed = 1), 0) AS failure,
  coalesce(sum(${NORM_INPUT}), 0) AS input_tokens,
  coalesce(sum(output_tokens), 0) AS output_tokens,
  coalesce(sum(reasoning_tokens), 0) AS reasoning_tokens,
  coalesce(sum(${COMPAT_CACHED}), 0) AS cached_tokens,
  coalesce(sum(cache_read_tokens), 0) AS cache_read_tokens,
  coalesce(sum(cache_creation_tokens), 0) AS cache_creation_tokens,
  coalesce(sum(total_tokens), 0) AS total_tokens,
  total(cost_usd) AS cost,
  total(CASE WHEN latency_ms <> 0 THEN latency_ms END) AS lat_sum,
  count(nullif(latency_ms, 0)) AS lat_n`;

export interface Totals {
  calls: number;
  success: number;
  failure: number;
  input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  cached_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  total_tokens: number;
  cost: number;
  lat_sum: number;
  lat_n: number;
}

export function emptyTotals(): Totals {
  return {
    calls: 0,
    success: 0,
    failure: 0,
    input_tokens: 0,
    output_tokens: 0,
    reasoning_tokens: 0,
    cached_tokens: 0,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    total_tokens: 0,
    cost: 0,
    lat_sum: 0,
    lat_n: 0,
  };
}

type Row = Record<string, unknown>;

export function num(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  if (value === null || value === undefined) return 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

export function str(value: unknown): string {
  return typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value);
}

export function readTotals(row: Row): Totals {
  return {
    calls: num(row.calls),
    success: num(row.success),
    failure: num(row.failure),
    input_tokens: num(row.input_tokens),
    output_tokens: num(row.output_tokens),
    reasoning_tokens: num(row.reasoning_tokens),
    cached_tokens: num(row.cached_tokens),
    cache_read_tokens: num(row.cache_read_tokens),
    cache_creation_tokens: num(row.cache_creation_tokens),
    total_tokens: num(row.total_tokens),
    cost: num(row.cost),
    lat_sum: num(row.lat_sum),
    lat_n: num(row.lat_n),
  };
}

export function addTotals(target: Totals, source: Totals): Totals {
  target.calls += source.calls;
  target.success += source.success;
  target.failure += source.failure;
  target.input_tokens += source.input_tokens;
  target.output_tokens += source.output_tokens;
  target.reasoning_tokens += source.reasoning_tokens;
  target.cached_tokens += source.cached_tokens;
  target.cache_read_tokens += source.cache_read_tokens;
  target.cache_creation_tokens += source.cache_creation_tokens;
  target.total_tokens += source.total_tokens;
  target.cost += source.cost;
  target.lat_sum += source.lat_sum;
  target.lat_n += source.lat_n;
  return target;
}

export function ratio(part: number, total: number): number {
  return total > 0 ? part / total : 0;
}

/** (cached + cache read) / normalized input, capped at 1. */
export function cacheHitRate(t: Pick<Totals, 'input_tokens' | 'cached_tokens' | 'cache_read_tokens'>): number {
  if (t.input_tokens <= 0) return 0;
  return Math.min(1, Math.max(t.cached_tokens + t.cache_read_tokens, 0) / t.input_tokens);
}

export function avgLatency(t: Pick<Totals, 'lat_sum' | 'lat_n'>): number | null {
  return t.lat_n > 0 ? t.lat_sum / t.lat_n : null;
}

/** Nearest-rank 95th percentile: sorted[ceil(n * 0.95) - 1]. Null for no samples. */
export function percentile95(values: number[]): number | null {
  if (values.length === 0) return null;
  values.sort((a, b) => a - b);
  const index = Math.min(values.length - 1, Math.max(0, Math.ceil(values.length * 0.95) - 1));
  return values[index];
}

/**
 * Registers `p95(x)`: nearest-rank 95th percentile over the positive values of x (NULL when none),
 * matching CPA Manager Plus's latency / TTFT percentiles.
 */
export function registerAnalyticsFunctions(db: DatabaseSync): void {
  db.aggregate('p95', {
    start: () => [] as number[],
    step: (acc: number[], value: unknown) => {
      const n = typeof value === 'number' ? value : typeof value === 'bigint' ? Number(value) : NaN;
      if (n > 0) acc.push(n);
      return acc;
    },
    result: (acc: number[]) => percentile95(acc),
    deterministic: true,
  } as unknown as Parameters<DatabaseSync['aggregate']>[1]);
}
