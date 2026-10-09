/**
 * The analytics query engine behind `POST /api/analytics`. Semantics ported from CPA Manager Plus
 * (MIT): every section aggregates raw events in [from_ms, to_ms) with the same filters; costs are the
 * sum of per-event `cost_usd` (priced at insert / recompute time, unpriced = 0).
 *
 * Two execution paths produce identical results:
 *  - per section: one GROUP BY query per requested section (cheap for single-section requests);
 *  - facts: when several aggregate sections are requested, ONE grouped scan at the finest grain
 *    (local hour × credential × model × tier × API key × source/auth/provider) feeds all of them,
 *    plus one narrow row pass for percentiles and sessions. Event rows are wide (JSON columns spill
 *    to overflow pages), so scans dominate the cost; this keeps a full Usage payload at ~2 scans.
 *
 * Runs synchronously on a read-only connection (inside an analytics worker) and returns the response
 * as JSON text, so large event pages are never re-serialized.
 */
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type {
  AccountModelStatRow,
  AnomalyPoint,
  ApiKeyStatRow,
  ChannelShareRow,
  CredentialStatRow,
  CredentialTimelinePoint,
  FailureSourceRow,
  FilterOptions,
  HeatmapContributor,
  HeatmapPoint,
  HourlyPoint,
  ModelStat,
  ModelTierStat,
  Summary,
  SummaryComparison,
  TimelinePoint,
} from '../../shared/analytics-types.ts';
import { eventsPage, eventsResponseJson } from './events.ts';
import {
  addTotals,
  avgLatency,
  cacheHitRate,
  emptyTotals,
  num,
  percentile95,
  PROJECT_ID,
  PROVIDER_LABEL,
  projectIdSnapshot,
  ratio,
  readTotals,
  str,
  TOTALS_SQL,
  type Totals,
} from './sql.ts';
import { HOUR_MS, TzContext } from './tz.ts';
import type { Granularity, Include, NormalizedRequest } from './validate.ts';
import { buildWhere, optionScope, type Scope, type SqlParam, type Where } from './where.ts';

const ROLLING_WINDOW_MS = 30 * 60_000;
const HEATMAP_CONTRIBUTORS = 5;
const MAX_ANOMALIES = 50;

type Row = Record<string, unknown>;

const statementCache = new WeakMap<DatabaseSync, Map<string, StatementSync>>();

function prepare(db: DatabaseSync, sql: string): StatementSync {
  let cache = statementCache.get(db);
  if (!cache) {
    cache = new Map();
    statementCache.set(db, cache);
  }
  let stmt = cache.get(sql);
  if (!stmt) {
    stmt = db.prepare(sql);
    if (cache.size >= 256) cache.delete(cache.keys().next().value as string);
    cache.set(sql, stmt);
  }
  return stmt;
}

function all(db: DatabaseSync, sql: string, params: SqlParam[]): Row[] {
  return prepare(db, sql).all(...params) as Row[];
}

function get(db: DatabaseSync, sql: string, params: SqlParam[]): Row {
  return (prepare(db, sql).get(...params) as Row | undefined) ?? {};
}

/** Removes optional string fields that are empty (Go `omitempty`). */
function omitEmpty<T extends object>(row: T, keys: readonly string[]): T {
  const record = row as Record<string, unknown>;
  for (const key of keys) {
    if (record[key] === '' || record[key] === undefined) delete record[key];
  }
  return row;
}

const nullableNum = (value: unknown) => (value === null || value === undefined ? null : num(value));

/* ------------------------------------------------------------------------------- shared metrics */

/** Extra per-group metrics beyond TOTALS_SQL (zero-token calls, speed, positive-latency average). */
const EXTRA_SQL = `coalesce(sum(total_tokens = 0 AND failed = 0), 0) AS zero_calls,
  total(CASE WHEN output_tokens > 0 AND latency_ms > 0 THEN output_tokens * 1000.0 / latency_ms END) AS tps_sum,
  coalesce(sum(output_tokens > 0 AND latency_ms > 0), 0) AS tps_n,
  total(CASE WHEN failed = 0 AND ttft_ms > 0 THEN ttft_ms END) AS ttft_sum,
  coalesce(sum(failed = 0 AND ttft_ms > 0), 0) AS ttft_n,
  total(CASE WHEN failed = 0 AND latency_ms > 0 THEN latency_ms END) AS slat_sum,
  coalesce(sum(failed = 0 AND latency_ms > 0), 0) AS slat_n,
  total(CASE WHEN latency_ms > 0 THEN latency_ms END) AS tlat_sum,
  coalesce(sum(latency_ms > 0), 0) AS tlat_n`;

const METRICS = [
  'calls',
  'success',
  'failure',
  'input_tokens',
  'output_tokens',
  'reasoning_tokens',
  'cached_tokens',
  'cache_read_tokens',
  'cache_creation_tokens',
  'total_tokens',
  'cost',
  'lat_sum',
  'lat_n',
  'zero_calls',
  'tps_sum',
  'tps_n',
  'ttft_sum',
  'ttft_n',
  'slat_sum',
  'slat_n',
  'tlat_sum',
  'tlat_n',
] as const;

/**
 * Merges rows by key: metric fields are summed, `last_seen` is the max and every other field comes
 * from the row with the latest `last_seen` (first row when absent).
 */
function mergeBy(rows: Iterable<Row>, key: (row: Row) => string): Row[] {
  const merged = new Map<string, Row>();
  for (const row of rows) {
    const k = key(row);
    const acc = merged.get(k);
    if (!acc) {
      merged.set(k, { ...row });
      continue;
    }
    for (const metric of METRICS) acc[metric] = num(acc[metric]) + num(row[metric]);
    if (num(row.last_seen) > num(acc.last_seen)) {
      for (const [field, value] of Object.entries(row)) {
        if (!(METRICS as readonly string[]).includes(field)) acc[field] = value;
      }
    }
  }
  return [...merged.values()];
}

/* ------------------------------------------------------------------------------------- facts */

const IDENTITY_SQL = `coalesce(auth_file_snapshot, '') AS auth_file_snapshot, coalesce(auth_index, '') AS auth_index,
  coalesce(source, '') AS source, coalesce(source_hash, '') AS source_hash,
  coalesce(account_snapshot, '') AS account_snapshot, coalesce(auth_label_snapshot, '') AS auth_label_snapshot,
  ${PROVIDER_LABEL} AS auth_provider_snapshot, coalesce(auth_account_id_snapshot, '') AS auth_account_id_snapshot,
  ${PROJECT_ID} AS auth_project_id_snapshot`;

/**
 * The finest-grain aggregate every multi-section request is built from. `max(timestamp_ms)` is the
 * only min/max aggregate, so SQLite takes the bare identity columns from each group's latest event.
 */
function queryFacts(db: DatabaseSync, where: Where, tz: TzContext): Row[] {
  return all(
    db,
    `SELECT ${tz.hourBucketSql} AS hb, credential_id AS id, analytics_model AS model, tier_key AS tier,
      lower(trim(coalesce(api_key_hash, ''))) AS api_key_hash, max(timestamp_ms) AS last_seen, ${IDENTITY_SQL},
      ${TOTALS_SQL}, ${EXTRA_SQL}
    FROM events ${where.sql}
    GROUP BY hb, credential_id, analytics_model, tier_key, 5, coalesce(source_hash, ''), coalesce(auth_index, ''), ${PROVIDER_LABEL}`,
    where.params,
  );
}

interface RowPass {
  /** p95 inputs per timeline bucket key. */
  buckets: Map<number, { lat: number[]; ttft: number[] }>;
  lat: number[];
  ttft: number[];
  sessions: Set<string>;
  failedSessions: Set<string>;
}

/** One narrow pass over raw rows for what cannot be pre-aggregated: percentiles and sessions. */
function rowPass(
  db: DatabaseSync,
  where: Where,
  tz: TzContext,
  bucketOf: ((hb: number) => number) | null,
  wantOverall: boolean,
  wantSessions: boolean,
): RowPass {
  const out: RowPass = { buckets: new Map(), lat: [], ttft: [], sessions: new Set(), failedSessions: new Set() };
  const columns = [`${tz.hourBucketSql}`, 'latency_ms', 'ttft_ms', wantSessions ? "nullif(trim(session_id), '')" : 'NULL', 'failed'];
  const stmt = prepare(db, `SELECT ${columns.join(', ')} FROM events ${where.sql}`);
  stmt.setReturnArrays(true);
  try {
    let lastHb = NaN;
    let lastBucket: { lat: number[]; ttft: number[] } | null = null;
    for (const row of stmt.iterate(...where.params) as Iterable<unknown[]>) {
      const latency = num(row[1]);
      const ttft = num(row[2]);
      if (bucketOf && (latency > 0 || ttft > 0)) {
        const hb = num(row[0]);
        if (hb !== lastHb) {
          const key = bucketOf(hb);
          lastBucket = out.buckets.get(key) ?? null;
          if (!lastBucket) {
            lastBucket = { lat: [], ttft: [] };
            out.buckets.set(key, lastBucket);
          }
          lastHb = hb;
        }
        if (latency > 0) lastBucket!.lat.push(latency);
        if (ttft > 0) lastBucket!.ttft.push(ttft);
      }
      if (wantOverall) {
        if (latency > 0) out.lat.push(latency);
        if (ttft > 0) out.ttft.push(ttft);
      }
      if (wantSessions && typeof row[3] === 'string') {
        out.sessions.add(row[3]);
        if (num(row[4]) === 1) out.failedSessions.add(row[3]);
      }
    }
  } finally {
    stmt.setReturnArrays(false);
  }
  return out;
}

/* ---------------------------------------------------------- model groups (summary, model stats) */

interface ModelGroup extends Totals {
  model: string;
  tier: string;
  zero_calls: number;
  tps_sum: number;
  tps_n: number;
  ttft_sum: number;
  ttft_n: number;
  slat_sum: number;
  slat_n: number;
}

function queryModelGroups(db: DatabaseSync, where: Where): Row[] {
  return all(
    db,
    `SELECT analytics_model AS model, tier_key AS tier, ${TOTALS_SQL}, ${EXTRA_SQL}
    FROM events ${where.sql}
    GROUP BY analytics_model, tier_key`,
    where.params,
  );
}

function toModelGroups(rows: Row[]): ModelGroup[] {
  return rows.map((row) => ({
    ...readTotals(row),
    model: str(row.model),
    tier: str(row.tier),
    zero_calls: num(row.zero_calls),
    tps_sum: num(row.tps_sum),
    tps_n: num(row.tps_n),
    ttft_sum: num(row.ttft_sum),
    ttft_n: num(row.ttft_n),
    slat_sum: num(row.slat_sum),
    slat_n: num(row.slat_n),
  }));
}

function modelStatFrom(model: string, t: Totals): ModelStat {
  return {
    model,
    calls: t.calls,
    success_calls: t.success,
    failure_calls: t.calls - t.success,
    success_rate: ratio(t.success, t.calls),
    input_tokens: t.input_tokens,
    output_tokens: t.output_tokens,
    cached_tokens: t.cached_tokens,
    cache_read_tokens: t.cache_read_tokens,
    cache_creation_tokens: t.cache_creation_tokens,
    cache_hit_tokens: t.cached_tokens + t.cache_read_tokens,
    cache_hit_input_tokens: t.input_tokens,
    cache_hit_rate: cacheHitRate(t),
    total_tokens: t.total_tokens,
    cost: t.cost,
  };
}

const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

const byCallsThenName = <T extends { calls: number }>(key: (row: T) => string) => (a: T, b: T) =>
  b.calls - a.calls || compareText(key(a), key(b));

export function buildModelStats(groups: ModelGroup[]): ModelStat[] {
  const byModel = new Map<string, Totals>();
  for (const group of groups) {
    const entry = byModel.get(group.model) ?? emptyTotals();
    addTotals(entry, group);
    byModel.set(group.model, entry);
  }
  return [...byModel].map(([model, t]) => modelStatFrom(model, t)).sort(byCallsThenName((row) => row.model));
}

export function buildModelTierStats(groups: ModelGroup[]): ModelTierStat[] {
  return groups
    .map((group) => ({
      ...modelStatFrom(group.model, group),
      service_tier: group.tier,
      output_tps: group.tps_n > 0 ? group.tps_sum / group.tps_n : null,
      tps_samples: group.tps_n,
      average_ttft_ms: group.ttft_n > 0 ? group.ttft_sum / group.ttft_n : null,
      average_latency_ms: group.slat_n > 0 ? group.slat_sum / group.slat_n : null,
    }))
    .sort(byCallsThenName((row) => `${row.model}\u0000${row.service_tier}`));
}

/* ------------------------------------------------------------------------------------------- summary */

interface SummaryExtras {
  p95Latency: number | null;
  p95Ttft: number | null;
  days: number;
  sessions: number;
  sessionFailures: number;
}

function buildSummary(
  db: DatabaseSync,
  req: NormalizedRequest,
  groups: ModelGroup[],
  extras: () => SummaryExtras,
): Summary {
  const agg = emptyTotals();
  let zeroCalls = 0;
  for (const group of groups) {
    addTotals(agg, group);
    zeroCalls += group.zero_calls;
  }
  const compact = req.include.summaryCompact;
  const wantP95 = !compact || req.include.summaryPercentiles;
  const extra = wantP95 || !compact ? extras() : null;

  const summary: Summary = {
    total_calls: agg.calls,
    success_calls: agg.success,
    failure_calls: agg.failure,
    success_rate: ratio(agg.success, agg.calls),
    input_tokens: agg.input_tokens,
    output_tokens: agg.output_tokens,
    cached_tokens: agg.cached_tokens,
    cache_read_tokens: agg.cache_read_tokens,
    cache_creation_tokens: agg.cache_creation_tokens,
    cache_hit_rate: cacheHitRate(agg),
    reasoning_tokens: agg.reasoning_tokens,
    total_tokens: agg.total_tokens,
    total_cost: agg.cost,
    average_cost_per_call: ratio(agg.cost, agg.calls),
    average_latency_ms: avgLatency(agg),
    p95_latency_ms: wantP95 ? (extra?.p95Latency ?? null) : null,
    p95_ttft_ms: wantP95 ? (extra?.p95Ttft ?? null) : null,
    zero_token_calls: zeroCalls,
    rpm_30m: 0,
    tpm_30m: 0,
    avg_daily_requests: 0,
    avg_daily_tokens: 0,
    sessions: 0,
    session_failures: 0,
    session_success_rate: 0,
    zero_token_models: null as unknown as string[],
  };
  if (compact || !extra) return summary;

  const rolling = buildWhere(req, { fromMs: req.nowMs - ROLLING_WINDOW_MS, toMs: req.nowMs });
  const rollingRow = get(
    db,
    `SELECT count(*) AS calls, coalesce(sum(total_tokens), 0) AS tokens FROM events ${rolling.sql}`,
    rolling.params,
  );
  summary.rpm_30m = num(rollingRow.calls) / 30;
  summary.tpm_30m = num(rollingRow.tokens) / 30;
  const days = Math.max(1, extra.days);
  summary.avg_daily_requests = agg.calls / days;
  summary.avg_daily_tokens = agg.total_tokens / days;
  summary.sessions = extra.sessions;
  summary.session_failures = extra.sessionFailures;
  summary.session_success_rate = ratio(extra.sessions - extra.sessionFailures, extra.sessions);
  summary.zero_token_models = [
    ...new Set(groups.filter((group) => group.zero_calls > 0 && group.model.trim() !== '').map((group) => group.model)),
  ].sort();
  return summary;
}

/** Percentiles, active days and sessions with dedicated queries (per-section path). */
function querySummaryExtras(db: DatabaseSync, req: NormalizedRequest, where: Where, tz: TzContext): SummaryExtras {
  const p95 = get(db, `SELECT p95(latency_ms) AS lat, p95(ttft_ms) AS ttft FROM events ${where.sql}`, where.params);
  const extras: SummaryExtras = { p95Latency: nullableNum(p95.lat), p95Ttft: nullableNum(p95.ttft), days: 0, sessions: 0, sessionFailures: 0 };
  if (!req.include.summaryCompact) {
    const row = get(
      db,
      `SELECT count(DISTINCT ${tz.dayKeySql}) AS days,
        count(DISTINCT nullif(trim(session_id), '')) AS sessions,
        count(DISTINCT CASE WHEN failed = 1 THEN nullif(trim(session_id), '') END) AS session_failures
      FROM events ${where.sql}`,
      where.params,
    );
    extras.days = num(row.days);
    extras.sessions = num(row.sessions);
    extras.sessionFailures = num(row.session_failures);
  }
  return extras;
}

function buildComparison(db: DatabaseSync, req: NormalizedRequest): SummaryComparison | undefined {
  const span = req.toMs - req.fromMs;
  const prevFrom = req.fromMs - span;
  if (span <= 0 || prevFrom <= 0) return undefined;
  const where = buildWhere(req, { fromMs: prevFrom, toMs: req.fromMs });
  const row = get(
    db,
    `SELECT count(*) AS calls, coalesce(sum(failed = 0), 0) AS success, coalesce(sum(failed = 1), 0) AS failure,
      coalesce(sum(total_tokens), 0) AS tokens, total(cost_usd) AS cost
    FROM events ${where.sql}`,
    where.params,
  );
  const calls = num(row.calls);
  const success = num(row.success);
  return {
    from_ms: prevFrom,
    to_ms: req.fromMs,
    total_calls: calls,
    success_calls: success,
    failure_calls: num(row.failure),
    success_rate: ratio(success, calls),
    total_tokens: num(row.tokens),
    total_cost: num(row.cost),
  };
}

/* ------------------------------------------------------------------------------------------ timeline */

function bucketSql(tz: TzContext, granularity: Granularity): string {
  return granularity === 'day' ? tz.dayKeySql : tz.hourBucketSql;
}

function bucketMs(tz: TzContext, granularity: Granularity, key: number): number {
  return granularity === 'day' ? tz.dayStart(key) : key;
}

/** Bucket key (as `bucketSql` yields it) of an hour bucket. */
function bucketKeyOfHour(tz: TzContext, granularity: Granularity): (hb: number) => number {
  return granularity === 'day' ? (hb) => tz.dayKeyOf(hb) : (hb) => hb;
}

function queryTimeline(db: DatabaseSync, where: Where, tz: TzContext, granularity: Granularity): Row[] {
  return all(
    db,
    `SELECT ${bucketSql(tz, granularity)} AS b, ${TOTALS_SQL}, ${EXTRA_SQL},
      p95(latency_ms) AS p95_lat, p95(ttft_ms) AS p95_ttft
    FROM events ${where.sql}
    GROUP BY b`,
    where.params,
  );
}

function toTimeline(rows: Row[], tz: TzContext, granularity: Granularity): TimelinePoint[] {
  return rows
    .map((row) => {
      const t = readTotals(row);
      const ms = bucketMs(tz, granularity, num(row.b));
      const latN = num(row.tlat_n);
      return {
        bucket_ms: ms,
        label: tz.label(ms, granularity),
        calls: t.calls,
        tokens: t.total_tokens,
        success: t.success,
        failure: t.failure,
        input_tokens: t.input_tokens,
        output_tokens: t.output_tokens,
        cached_tokens: t.cached_tokens,
        cache_read_tokens: t.cache_read_tokens,
        cache_creation_tokens: t.cache_creation_tokens,
        cache_hit_rate: cacheHitRate(t),
        reasoning_tokens: t.reasoning_tokens,
        total_tokens: t.total_tokens,
        cost: t.cost,
        average_latency_ms: latN > 0 ? num(row.tlat_sum) / latN : null,
        p95_latency_ms: nullableNum(row.p95_lat),
        p95_ttft_ms: nullableNum(row.p95_ttft),
        success_rate: ratio(t.success, t.calls),
        failure_rate: ratio(t.failure, t.calls),
      };
    })
    .sort((a, b) => a.bucket_ms - b.bucket_ms);
}

/* --------------------------------------------------------------------------------------- anomalies */

export function percentChange(current: number, previous: number): number {
  if (previous <= 0) return current > 0 ? 1 : 0;
  return (current - previous) / previous;
}

const positive = (value: number) => (value < 0 ? 0 : value);

/** Bucket-over-bucket spikes, compared with the previous non-empty bucket; top 50 by score. */
export function buildAnomalyPoints(timeline: TimelinePoint[], granularity: Granularity): AnomalyPoint[] {
  if (timeline.length < 2) return [];
  const size = granularity === 'day' ? 24 * HOUR_MS : HOUR_MS;
  const tokensPerRequest = (p: TimelinePoint) => (p.calls > 0 ? p.total_tokens / p.calls : 0);
  const hitRate = (p: TimelinePoint) => {
    let rate = p.cache_hit_rate;
    if (rate <= 0) rate = cacheHitRate(p);
    return Math.min(rate, 1);
  };
  const result: AnomalyPoint[] = [];
  for (let i = 1; i < timeline.length; i++) {
    const prev = timeline[i - 1];
    const cur = timeline[i];
    const requestChange = percentChange(cur.calls, prev.calls);
    const costChange = percentChange(cur.cost, prev.cost);
    const tokensPerRequestChange = percentChange(tokensPerRequest(cur), tokensPerRequest(prev));
    const cacheHitRateChange = hitRate(cur) - hitRate(prev);
    const failureRateChange = cur.failure_rate - prev.failure_rate;
    const latencyP95Change = percentChange(cur.p95_latency_ms ?? 0, prev.p95_latency_ms ?? 0);
    const keys: AnomalyPoint['metric_keys'] = [];
    if (requestChange > 1) keys.push('request_spike');
    if (costChange > 1) keys.push('cost_spike');
    if (tokensPerRequestChange > 0.5) keys.push('tokens_per_request_spike');
    if (cacheHitRateChange < -0.2) keys.push('cache_hit_drop');
    if (failureRateChange > 0.2) keys.push('failure_rate_spike');
    if (latencyP95Change > 0.5) keys.push('latency_spike');
    if (keys.length === 0) continue;
    result.push({
      bucket_ms: cur.bucket_ms,
      bucket_end_ms: cur.bucket_ms + size,
      label: cur.label,
      severity: keys.length >= 3 ? 'high' : keys.length >= 2 ? 'medium' : 'low',
      metric_keys: keys,
      calls: cur.calls,
      total_tokens: cur.total_tokens,
      cost: cur.cost,
      failure_rate: cur.failure_rate,
      request_change: requestChange,
      cost_change: costChange,
      tokens_per_request_change: tokensPerRequestChange,
      cache_hit_rate_change: cacheHitRateChange,
      failure_rate_change: failureRateChange,
      latency_p95_change: latencyP95Change,
    });
  }
  const score = (p: AnomalyPoint) =>
    p.metric_keys.length * 10 +
    positive(p.request_change) +
    positive(p.cost_change) +
    positive(p.tokens_per_request_change) +
    positive(-p.cache_hit_rate_change) +
    positive(p.failure_rate_change) +
    positive(p.latency_p95_change);
  result.sort((a, b) => score(b) - score(a) || b.bucket_ms - a.bucket_ms);
  return result.slice(0, MAX_ANOMALIES);
}

/* --------------------------------------------------------------------------- hourly + heatmap */

function queryHourly(db: DatabaseSync, where: Where, tz: TzContext): Row[] {
  return all(
    db,
    `SELECT ${tz.hourOfDaySql} AS h, count(*) AS calls, coalesce(sum(total_tokens), 0) AS total_tokens
    FROM events ${where.sql} GROUP BY h`,
    where.params,
  );
}

function toHourly(rows: Row[]): HourlyPoint[] {
  return rows
    .map((row) => ({ hour: num(row.h), calls: num(row.calls), tokens: num(row.total_tokens) }))
    .sort((a, b) => a.hour - b.hour);
}

function queryHeatmap(db: DatabaseSync, where: Where, tz: TzContext): Row[] {
  return all(
    db,
    `SELECT ${tz.weekdaySql} AS wd, ${tz.hourOfDaySql} AS h, analytics_model AS model,
      lower(trim(coalesce(api_key_hash, ''))) AS api_key_hash, ${PROVIDER_LABEL} AS auth_provider_snapshot,
      count(*) AS calls, coalesce(sum(failed = 0), 0) AS success, coalesce(sum(failed = 1), 0) AS failure,
      coalesce(sum(total_tokens), 0) AS total_tokens, total(cost_usd) AS cost
    FROM events ${where.sql}
    GROUP BY 1, 2, 3, 4, 5`,
    where.params,
  );
}

function toHeatmap(rows: Row[]): HeatmapPoint[] {
  type Group = Map<string, HeatmapContributor>;
  const cells = new Map<number, { point: HeatmapPoint; models: Group; keys: Group; providers: Group }>();
  const add = (group: Group, rawKey: string, rawLabel: string, row: Row) => {
    const key = rawKey.trim();
    if (!key) return;
    const label = rawLabel.trim() || key;
    let entry = group.get(key);
    if (!entry) {
      entry = { key, label, calls: 0, success: 0, failure: 0, tokens: 0, cost: 0, failure_rate: 0, share: 0 };
      group.set(key, entry);
    }
    entry.calls += num(row.calls);
    entry.success += num(row.success);
    entry.failure += num(row.failure);
    entry.tokens += num(row.total_tokens);
    entry.cost += num(row.cost);
  };
  for (const row of rows) {
    const weekday = num(row.wd);
    const hour = num(row.h);
    const cellKey = weekday * 24 + hour;
    let cell = cells.get(cellKey);
    if (!cell) {
      cell = {
        point: { weekday, hour, calls: 0, success: 0, failure: 0, tokens: 0, cost: 0, failure_rate: 0 },
        models: new Map(),
        keys: new Map(),
        providers: new Map(),
      };
      cells.set(cellKey, cell);
    }
    const p = cell.point;
    p.calls += num(row.calls);
    p.success += num(row.success);
    p.failure += num(row.failure);
    p.tokens += num(row.total_tokens);
    p.cost += num(row.cost);
    const model = str(row.model);
    const provider = str(row.auth_provider_snapshot);
    add(cell.models, model.trim() || 'Unknown', model, row);
    add(cell.keys, str(row.api_key_hash), str(row.api_key_hash), row);
    add(cell.providers, provider.trim() || 'Unknown', provider, row);
  }
  const top = (group: Group, total: number): HeatmapContributor[] =>
    [...group.values()]
      .map((c) => ({ ...c, failure_rate: ratio(c.failure, c.calls), share: ratio(c.calls, total) }))
      .sort((a, b) => b.calls - a.calls || b.cost - a.cost || compareText(a.key, b.key))
      .slice(0, HEATMAP_CONTRIBUTORS);
  return [...cells.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, cell]) => {
      const p = cell.point;
      p.failure_rate = ratio(p.failure, p.calls);
      const models = top(cell.models, p.calls);
      const keys = top(cell.keys, p.calls);
      const providers = top(cell.providers, p.calls);
      if (models.length) p.model_contributors = models;
      if (keys.length) p.api_key_contributors = keys;
      if (providers.length) p.provider_contributors = providers;
      return p;
    });
}

/* -------------------------------------------------------------------------- channels + failures */

function buildChannelShare(db: DatabaseSync, where: Where): ChannelShareRow[] {
  const rows = all(
    db,
    `SELECT coalesce(auth_index, '') AS auth_index,
      coalesce(max(source), '') AS source, coalesce(max(account_snapshot), '') AS account_snapshot,
      coalesce(max(auth_label_snapshot), '') AS auth_label_snapshot,
      coalesce(nullif(max(auth_provider_snapshot), ''), max(provider), '') AS auth_provider_snapshot,
      coalesce(max(auth_account_id_snapshot), '') AS auth_account_id_snapshot,
      ${TOTALS_SQL}
    FROM events ${where.sql}
    GROUP BY coalesce(auth_index, '')`,
    where.params,
  );
  return rows
    .map((row) => {
      const t = readTotals(row);
      return omitEmpty(
        {
          auth_index: str(row.auth_index) || '-',
          source: str(row.source),
          account_snapshot: str(row.account_snapshot),
          auth_label_snapshot: str(row.auth_label_snapshot),
          auth_provider_snapshot: str(row.auth_provider_snapshot),
          auth_account_id_snapshot: str(row.auth_account_id_snapshot),
          calls: t.calls,
          success: t.success,
          failure: t.failure,
          tokens: t.total_tokens,
          cost: t.cost,
          average_latency_ms: avgLatency(t),
        } as ChannelShareRow,
        ['source', 'account_snapshot', 'auth_label_snapshot', 'auth_provider_snapshot', 'auth_account_id_snapshot'],
      );
    })
    .sort(byCallsThenName((row) => row.auth_index));
}

function buildFailureSources(db: DatabaseSync, where: Where): FailureSourceRow[] {
  const rows = all(
    db,
    `SELECT coalesce(max(source), '') AS source, coalesce(source_hash, '') AS source_hash,
      coalesce(auth_index, '') AS auth_index, coalesce(max(account_snapshot), '') AS account_snapshot,
      coalesce(max(auth_label_snapshot), '') AS auth_label_snapshot,
      coalesce(nullif(max(auth_provider_snapshot), ''), max(provider), '') AS auth_provider_snapshot,
      count(*) AS calls, coalesce(sum(failed = 1), 0) AS failure, max(timestamp_ms) AS last_seen,
      avg(nullif(latency_ms, 0)) AS avg_latency
    FROM events ${where.sql}
    GROUP BY 2, 3
    HAVING sum(failed = 1) > 0
    ORDER BY failure DESC, last_seen DESC`,
    where.params,
  );
  return rows.map((row) =>
    omitEmpty(
      {
        source: str(row.source),
        source_hash: str(row.source_hash),
        auth_index: str(row.auth_index),
        account_snapshot: str(row.account_snapshot),
        auth_label_snapshot: str(row.auth_label_snapshot),
        auth_provider_snapshot: str(row.auth_provider_snapshot),
        calls: num(row.calls),
        failure: num(row.failure),
        last_seen_ms: num(row.last_seen),
        average_latency_ms: nullableNum(row.avg_latency),
      } as FailureSourceRow,
      ['source', 'account_snapshot', 'auth_label_snapshot', 'auth_provider_snapshot'],
    ),
  );
}

/* ---------------------------------------------------------------------------------- credentials */

const IDENTITY_KEYS = [
  'auth_file_snapshot',
  'auth_index',
  'source',
  'source_hash',
  'account_snapshot',
  'auth_label_snapshot',
  'auth_provider_snapshot',
  'auth_account_id_snapshot',
  'auth_project_id_snapshot',
] as const;

type Identity = Record<(typeof IDENTITY_KEYS)[number], string>;

/** Fills empty identity fields of `target` from `row` (apply most recent rows first). */
function fillIdentity(target: Identity, row: Row): void {
  for (const key of IDENTITY_KEYS) {
    if (!target[key]) target[key] = str(row[key]);
  }
  target.auth_project_id_snapshot = projectIdSnapshot(target.auth_provider_snapshot, target.auth_project_id_snapshot);
}

function emptyIdentity(): Identity {
  return {
    auth_file_snapshot: '',
    auth_index: '',
    source: '',
    source_hash: '',
    account_snapshot: '',
    auth_label_snapshot: '',
    auth_provider_snapshot: '',
    auth_account_id_snapshot: '',
    auth_project_id_snapshot: '',
  };
}

const byCostCallsSeen = <T extends { cost: number; calls: number; last_seen_ms: number }>(a: T, b: T) =>
  b.cost - a.cost || b.calls - a.calls || b.last_seen_ms - a.last_seen_ms;

interface ModelAcc {
  totals: Totals;
  lastSeen: number;
}

function addModel(models: Map<string, ModelAcc>, model: string, t: Totals, lastSeen: number): void {
  const key = model.trim() ? model : '-';
  let entry = models.get(key);
  if (!entry) {
    entry = { totals: emptyTotals(), lastSeen: 0 };
    models.set(key, entry);
  }
  addTotals(entry.totals, t);
  if (lastSeen > entry.lastSeen) entry.lastSeen = lastSeen;
}

function modelRows(models: Map<string, ModelAcc>): AccountModelStatRow[] {
  return [...models]
    .map(([model, acc]) => ({ ...modelStatFrom(model, acc.totals), last_seen_ms: acc.lastSeen }))
    .sort((a, b) => byCostCallsSeen(a, b) || compareText(a.model, b.model));
}

const byLastSeenDesc = (a: Row, b: Row) => num(b.last_seen) - num(a.last_seen);

function queryCredentialStats(db: DatabaseSync, where: Where): Row[] {
  // max(timestamp_ms) is the only min/max aggregate, so the bare identity columns come from each
  // group's most recent event.
  return all(
    db,
    `SELECT credential_id AS id, analytics_model AS model, max(timestamp_ms) AS last_seen, ${IDENTITY_SQL}, ${TOTALS_SQL}
    FROM events ${where.sql}
    GROUP BY credential_id, analytics_model`,
    where.params,
  );
}

function toCredentialStats(input: Row[]): CredentialStatRow[] {
  const rows = [...input].sort(byLastSeenDesc);
  const groups = new Map<string, { identity: Identity; totals: Totals; lastSeen: number; models: Map<string, ModelAcc> }>();
  for (const row of rows) {
    const id = str(row.id).trim() || '-';
    let entry = groups.get(id);
    if (!entry) {
      entry = { identity: emptyIdentity(), totals: emptyTotals(), lastSeen: 0, models: new Map() };
      groups.set(id, entry);
    }
    fillIdentity(entry.identity, row);
    const t = readTotals(row);
    const lastSeen = num(row.last_seen);
    addTotals(entry.totals, t);
    if (lastSeen > entry.lastSeen) entry.lastSeen = lastSeen;
    addModel(entry.models, str(row.model), t, lastSeen);
  }
  return [...groups]
    .map(([id, entry]) => {
      const t = entry.totals;
      const models = modelRows(entry.models);
      const row = omitEmpty(
        {
          id,
          ...entry.identity,
          calls: t.calls,
          success_calls: t.success,
          failure_calls: t.failure,
          success_rate: ratio(t.success, t.calls),
          input_tokens: t.input_tokens,
          output_tokens: t.output_tokens,
          cached_tokens: t.cached_tokens,
          cache_read_tokens: t.cache_read_tokens,
          cache_creation_tokens: t.cache_creation_tokens,
          total_tokens: t.total_tokens,
          cost: t.cost,
          average_latency_ms: avgLatency(t),
          last_seen_ms: entry.lastSeen,
        } as CredentialStatRow,
        IDENTITY_KEYS,
      );
      if (models.length) row.models = models;
      return row;
    })
    .sort((a, b) => byCostCallsSeen(a, b) || compareText(a.id, b.id));
}

function credentialLabel(id: string, identity: Identity): string {
  for (const value of [
    identity.auth_label_snapshot,
    identity.account_snapshot,
    identity.auth_file_snapshot,
    identity.source,
    identity.auth_index,
    id,
  ]) {
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return '-';
}

function queryCredentialTimeline(db: DatabaseSync, where: Where, tz: TzContext, granularity: Granularity): Row[] {
  return all(
    db,
    `SELECT credential_id AS id, ${bucketSql(tz, granularity)} AS b, max(timestamp_ms) AS last_seen, ${IDENTITY_SQL},
      ${TOTALS_SQL}, ${EXTRA_SQL}
    FROM events ${where.sql}
    GROUP BY credential_id, b`,
    where.params,
  );
}

function toCredentialTimeline(rows: Row[], tz: TzContext, granularity: Granularity): CredentialTimelinePoint[] {
  // One identity per credential (from its most recent rows) keeps labels stable across buckets.
  const identities = new Map<string, Identity>();
  for (const row of [...rows].sort(byLastSeenDesc)) {
    const id = str(row.id).trim() || '-';
    let identity = identities.get(id);
    if (!identity) {
      identity = emptyIdentity();
      identities.set(id, identity);
    }
    fillIdentity(identity, row);
  }
  return rows
    .map((row) => {
      const id = str(row.id).trim() || '-';
      const identity = identities.get(id) ?? emptyIdentity();
      const t = readTotals(row);
      const ms = bucketMs(tz, granularity, num(row.b));
      const latN = num(row.tlat_n);
      return omitEmpty(
        {
          id,
          label: credentialLabel(id, identity),
          ...identity,
          bucket_ms: ms,
          bucket_label: tz.label(ms, granularity),
          calls: t.calls,
          tokens: t.total_tokens,
          success: t.success,
          failure: t.failure,
          input_tokens: t.input_tokens,
          output_tokens: t.output_tokens,
          cached_tokens: t.cached_tokens,
          cache_read_tokens: t.cache_read_tokens,
          cache_creation_tokens: t.cache_creation_tokens,
          reasoning_tokens: t.reasoning_tokens,
          total_tokens: t.total_tokens,
          cost: t.cost,
          average_latency_ms: latN > 0 ? num(row.tlat_sum) / latN : null,
          success_rate: ratio(t.success, t.calls),
          failure_rate: ratio(t.failure, t.calls),
        } as CredentialTimelinePoint,
        IDENTITY_KEYS,
      );
    })
    .sort((a, b) => a.bucket_ms - b.bucket_ms || compareText(a.id, b.id));
}

/* ------------------------------------------------------------------------------------- API keys */

/** The api_key_hash, or a stable id for events without one (CPAMP `apiKeyGroupKey`). */
export function apiKeyGroupKey(apiKeyHash: string, sourceHash: string, authIndex: string, source: string, provider: string): string {
  const hash = apiKeyHash.trim().toLowerCase();
  if (hash) return hash;
  return ['unknown-client-api-key', ...[sourceHash, authIndex, source, provider].map((value) => value.trim() || '-')].join(':');
}

function queryApiKeyStats(db: DatabaseSync, where: Where): Row[] {
  return all(
    db,
    `SELECT lower(trim(coalesce(api_key_hash, ''))) AS api_key_hash, coalesce(source_hash, '') AS source_hash,
      coalesce(auth_index, '') AS auth_index, ${PROVIDER_LABEL} AS auth_provider_snapshot, analytics_model AS model,
      max(timestamp_ms) AS last_seen, coalesce(source, '') AS source,
      coalesce(account_snapshot, '') AS account_snapshot, coalesce(auth_label_snapshot, '') AS auth_label_snapshot,
      ${TOTALS_SQL}
    FROM events ${where.sql}
    GROUP BY 1, 2, 3, 4, 5`,
    where.params,
  );
}

function toApiKeyStats(input: Row[]): ApiKeyStatRow[] {
  const rows = [...input].sort(byLastSeenDesc);
  interface Acc {
    row: { api_key_hash: string; account_snapshot: string; auth_label_snapshot: string; auth_provider_snapshot: string };
    authIndices: Set<string>;
    sources: Set<string>;
    sourceHashes: Set<string>;
    totals: Totals;
    lastSeen: number;
    models: Map<string, ModelAcc>;
  }
  const groups = new Map<string, Acc>();
  for (const row of rows) {
    const hash = str(row.api_key_hash);
    const source = str(row.source);
    const provider = str(row.auth_provider_snapshot);
    const id = apiKeyGroupKey(hash, str(row.source_hash), str(row.auth_index), source, provider);
    let acc = groups.get(id);
    if (!acc) {
      acc = {
        row: { api_key_hash: '', account_snapshot: '', auth_label_snapshot: '', auth_provider_snapshot: '' },
        authIndices: new Set(),
        sources: new Set(),
        sourceHashes: new Set(),
        totals: emptyTotals(),
        lastSeen: 0,
        models: new Map(),
      };
      groups.set(id, acc);
    }
    if (!acc.row.api_key_hash) acc.row.api_key_hash = hash;
    if (!acc.row.account_snapshot) acc.row.account_snapshot = str(row.account_snapshot);
    if (!acc.row.auth_label_snapshot) acc.row.auth_label_snapshot = str(row.auth_label_snapshot);
    if (!acc.row.auth_provider_snapshot) acc.row.auth_provider_snapshot = provider;
    for (const [set, value] of [
      [acc.authIndices, str(row.auth_index)],
      [acc.sources, source],
      [acc.sourceHashes, str(row.source_hash)],
    ] as const) {
      if (value.trim()) set.add(value.trim());
    }
    const t = readTotals(row);
    const lastSeen = num(row.last_seen);
    addTotals(acc.totals, t);
    if (lastSeen > acc.lastSeen) acc.lastSeen = lastSeen;
    addModel(acc.models, str(row.model), t, lastSeen);
  }
  const sorted = (set: Set<string>) => [...set].sort();
  return [...groups]
    .map(([id, acc]) => {
      const t = acc.totals;
      const out = omitEmpty(
        {
          id,
          api_key_hash: acc.row.api_key_hash,
          account_snapshot: acc.row.account_snapshot,
          auth_label_snapshot: acc.row.auth_label_snapshot,
          auth_provider_snapshot: acc.row.auth_provider_snapshot,
          calls: t.calls,
          success_calls: t.success,
          failure_calls: t.failure,
          success_rate: ratio(t.success, t.calls),
          input_tokens: t.input_tokens,
          output_tokens: t.output_tokens,
          cached_tokens: t.cached_tokens,
          cache_read_tokens: t.cache_read_tokens,
          cache_creation_tokens: t.cache_creation_tokens,
          total_tokens: t.total_tokens,
          cost: t.cost,
          average_latency_ms: avgLatency(t),
          last_seen_ms: acc.lastSeen,
        } as ApiKeyStatRow,
        ['account_snapshot', 'auth_label_snapshot', 'auth_provider_snapshot'],
      );
      if (acc.authIndices.size) out.auth_indices = sorted(acc.authIndices);
      if (acc.sources.size) out.sources = sorted(acc.sources);
      if (acc.sourceHashes.size) out.source_hashes = sorted(acc.sourceHashes);
      const models = modelRows(acc.models);
      if (models.length) out.models = models;
      return out;
    })
    .sort((a, b) => b.last_seen_ms - a.last_seen_ms || b.calls - a.calls || b.cost - a.cost || compareText(a.id, b.id));
}

/* ------------------------------------------------------------------------------- filter options */

function accountIdentityKey(provider: string, values: Array<[string, string]>): string {
  for (const [kind, value] of values) {
    const trimmed = value.trim();
    if (trimmed) return `${provider.trim().toLowerCase()}\u0000${kind}\u0000${trimmed}`;
  }
  return '-';
}

function distinctSorted(values: Iterable<string>): string[] {
  const set = new Set<string>();
  for (const value of values) if (value !== '') set.add(value);
  return [...set].sort();
}

function buildFilterSelectors(db: DatabaseSync, scope: Scope): FilterOptions {
  const where = buildWhere(optionScope(scope));
  const rows = all(
    db,
    `SELECT analytics_model AS model, coalesce(api_key_hash, '') AS api_key_hash,
      coalesce(nullif(auth_provider_snapshot, ''), nullif(provider, ''), '') AS provider,
      coalesce(auth_index, '') AS auth_index, coalesce(source_hash, '') AS source_hash,
      coalesce(auth_file_snapshot, '') AS auth_file, coalesce(account_snapshot, '') AS account,
      coalesce(auth_label_snapshot, '') AS label, coalesce(max(source), '') AS source
    FROM events ${where.sql}
    GROUP BY 1, 2, 3, 4, 5, 6, 7, 8`,
    where.params,
  );
  const accountKeys = new Set<string>();
  const apiKeyGroups = new Set<string>();
  for (const row of rows) {
    const provider = str(row.provider);
    apiKeyGroups.add(apiKeyGroupKey(str(row.api_key_hash), str(row.source_hash), str(row.auth_index), str(row.source), provider));
    const key = accountIdentityKey(provider, [
      ['account', str(row.account)],
      ['label', str(row.label)],
      ['source', str(row.source)],
      ['auth', str(row.auth_index)],
      ['source-hash', str(row.source_hash)],
    ]);
    if (key !== '-') accountKeys.add(key);
  }
  return {
    models: distinctSorted(rows.map((row) => str(row.model))),
    api_key_hashes: distinctSorted(rows.map((row) => str(row.api_key_hash).trim().toLowerCase())),
    providers: distinctSorted(rows.map((row) => str(row.provider))),
    auth_files: distinctSorted(rows.map((row) => str(row.auth_file))),
    accounts: distinctSorted(rows.map((row) => str(row.account).trim())),
    account_count: accountKeys.size,
    api_key_count: apiKeyGroups.size,
  };
}

function buildFilterOptions(db: DatabaseSync, scope: Scope): FilterOptions {
  const optionWhere = buildWhere(optionScope(scope));
  const distinct = (expression: string) =>
    all(
      db,
      `SELECT DISTINCT ${expression} AS value FROM events ${optionWhere.sql} AND ${expression} <> '' ORDER BY value`,
      optionWhere.params,
    ).map((row) => str(row.value));
  const options: FilterOptions = {
    api_key_stats: toApiKeyStats(queryApiKeyStats(db, optionWhere)),
    channel_share: buildChannelShare(db, optionWhere),
    model_stats: buildModelStats(toModelGroups(queryModelGroups(db, optionWhere))),
    providers: distinct("coalesce(nullif(auth_provider_snapshot, ''), nullif(provider, ''), '')"),
    auth_files: distinct("coalesce(auth_file_snapshot, '')"),
    project_ids: distinct(PROJECT_ID),
    request_types: distinct("coalesce(executor_type, '')"),
    header_error_kinds: distinct("coalesce(header_error_kind, '')"),
    header_error_codes: distinct("coalesce(header_error_code, '')"),
    header_quota_plans: distinct("coalesce(header_quota_plan_type, '')"),
    header_trace_ids: distinct("coalesce(header_trace_id, '')"),
  };
  for (const key of Object.keys(options) as Array<keyof FilterOptions>) {
    const value = options[key];
    if (Array.isArray(value) && value.length === 0) delete options[key];
  }
  return options;
}

/* ---------------------------------------------------------------------------------------- entry */

export type ExecutionMode = 'auto' | 'sections' | 'facts';

/** Number of requested sections the facts scan can serve. */
function factSections(inc: Include): number {
  return [
    inc.summary,
    inc.timeline || inc.anomalyPoints,
    inc.hourlyDistribution,
    inc.heatmap,
    inc.modelStats || inc.modelTierStats,
    inc.credentialStats,
    inc.credentialTimeline,
    inc.apiKeyStats,
  ].filter(Boolean).length;
}

interface Aggregates {
  groups: ModelGroup[];
  summaryExtras: () => SummaryExtras;
  timeline: () => TimelinePoint[];
  hourly: () => HourlyPoint[];
  heatmap: () => HeatmapPoint[];
  credentialStats: () => CredentialStatRow[];
  credentialTimeline: () => CredentialTimelinePoint[];
  apiKeyStats: () => ApiKeyStatRow[];
}

function sectionAggregates(db: DatabaseSync, req: NormalizedRequest, where: Where, tz: TzContext): Aggregates {
  const inc = req.include;
  const g = req.granularity;
  return {
    groups: inc.summary || inc.modelStats || inc.modelTierStats ? toModelGroups(queryModelGroups(db, where)) : [],
    summaryExtras: () => querySummaryExtras(db, req, where, tz),
    timeline: () => toTimeline(queryTimeline(db, where, tz, g), tz, g),
    hourly: () => toHourly(queryHourly(db, where, tz)),
    heatmap: () => toHeatmap(queryHeatmap(db, where, tz)),
    credentialStats: () => toCredentialStats(queryCredentialStats(db, where)),
    credentialTimeline: () => toCredentialTimeline(queryCredentialTimeline(db, where, tz, g), tz, g),
    apiKeyStats: () => toApiKeyStats(queryApiKeyStats(db, where)),
  };
}

function factAggregates(db: DatabaseSync, req: NormalizedRequest, where: Where, tz: TzContext): Aggregates {
  const inc = req.include;
  const g = req.granularity;
  const facts = queryFacts(db, where, tz);
  const bucketOf = bucketKeyOfHour(tz, g);
  const wantTimeline = inc.timeline || inc.anomalyPoints;
  const wantOverallP95 = inc.summary && (!inc.summaryCompact || inc.summaryPercentiles);
  const wantSessions = inc.summary && !inc.summaryCompact;
  let pass: RowPass | null = null;
  const rows = () =>
    (pass ??= rowPass(db, where, tz, wantTimeline ? bucketOf : null, wantOverallP95, wantSessions));
  const withBucket = () => facts.map((fact) => ({ ...fact, b: bucketOf(num(fact.hb)) }));
  return {
    groups: inc.summary || inc.modelStats || inc.modelTierStats ? toModelGroups(mergeBy(facts, (f) => `${str(f.model)}\u0000${str(f.tier)}`)) : [],
    summaryExtras: () => {
      const pass = rows();
      return {
        p95Latency: percentile95(pass.lat),
        p95Ttft: percentile95(pass.ttft),
        days: new Set(facts.map((fact) => tz.dayKeyOf(num(fact.hb)))).size,
        sessions: pass.sessions.size,
        sessionFailures: pass.failedSessions.size,
      };
    },
    timeline: () => {
      const pass = rows();
      const merged = mergeBy(withBucket(), (f) => String(f.b));
      for (const row of merged) {
        const samples = pass.buckets.get(num(row.b));
        row.p95_lat = samples ? percentile95(samples.lat) : null;
        row.p95_ttft = samples ? percentile95(samples.ttft) : null;
      }
      return toTimeline(merged, tz, g);
    },
    hourly: () => toHourly(mergeBy(facts.map((fact) => ({ ...fact, h: tz.hourOfDayOf(num(fact.hb)) })), (f) => String(f.h))),
    heatmap: () =>
      toHeatmap(facts.map((fact) => ({ ...fact, wd: tz.weekdayOf(num(fact.hb)), h: tz.hourOfDayOf(num(fact.hb)) }))),
    credentialStats: () => toCredentialStats(mergeBy(facts, (f) => `${str(f.id)}\u0000${str(f.model)}`)),
    credentialTimeline: () => toCredentialTimeline(mergeBy(withBucket(), (f) => `${str(f.id)}\u0000${String(f.b)}`), tz, g),
    apiKeyStats: () =>
      toApiKeyStats(
        mergeBy(facts, (f) =>
          [f.api_key_hash, f.source_hash, f.auth_index, f.auth_provider_snapshot, f.model].map(str).join('\u0000'),
        ),
      ),
  };
}

/** Runs one analytics request and returns the `AnalyticsResponse` as JSON text. */
export function runAnalytics(db: DatabaseSync, req: NormalizedRequest, mode: ExecutionMode = 'auto'): string {
  const inc = req.include;
  const tz = new TzContext(req.timeZone, req.fromMs, req.toMs);
  const where = buildWhere(req);
  const parts: string[] = [`"generated_at_ms":${Date.now()}`, `"granularity":"${req.granularity}"`];
  const put = (key: string, value: unknown) => {
    if (value === undefined) return;
    if (Array.isArray(value) && value.length === 0) return;
    parts.push(`${JSON.stringify(key)}:${JSON.stringify(value)}`);
  };

  const useFacts = mode === 'facts' || (mode === 'auto' && factSections(inc) >= 2);
  const agg = useFacts ? factAggregates(db, req, where, tz) : sectionAggregates(db, req, where, tz);

  let summaryCalls: number | null = null;
  if (inc.summary) {
    const summary = buildSummary(db, req, agg.groups, agg.summaryExtras);
    summaryCalls = summary.total_calls;
    put('summary', summary);
    if (inc.summaryComparison) put('summary_comparison', buildComparison(db, req));
  }
  if (inc.timeline || inc.anomalyPoints) {
    const timeline = agg.timeline();
    if (inc.timeline) put('timeline', timeline);
    if (inc.anomalyPoints) put('anomaly_points', buildAnomalyPoints(timeline, req.granularity));
  }
  if (inc.hourlyDistribution) put('hourly_distribution', agg.hourly());
  if (inc.heatmap) put('heatmap', agg.heatmap());
  if (inc.modelStats) put('model_stats', buildModelStats(agg.groups));
  if (inc.modelTierStats) put('model_tier_stats', buildModelTierStats(agg.groups));
  if (inc.channelShare) put('channel_share', buildChannelShare(db, where));
  if (inc.failureSources) put('failure_sources', buildFailureSources(db, where));
  if (inc.credentialStats) put('credential_stats', agg.credentialStats());
  if (inc.credentialTimeline) put('credential_timeline', agg.credentialTimeline());
  if (inc.apiKeyStats) put('api_key_stats', agg.apiKeyStats());
  if (inc.filterSelectors) put('filter_options', buildFilterSelectors(db, req));
  else if (inc.filterOptions) put('filter_options', buildFilterOptions(db, req));

  if (inc.eventsPage) {
    const page = eventsPage(db, req, req, { beforeMs: inc.eventsPage.beforeMs, beforeId: inc.eventsPage.beforeId }, inc.eventsPage.limit);
    const total = summaryCalls ?? num(get(db, `SELECT count(*) AS n FROM events ${where.sql}`, where.params).n);
    parts.push(`"events":${eventsResponseJson(page, total)}`);
  }
  if (inc.drilldown) {
    const page = eventsPage(db, req, inc.drilldown, { beforeMs: 0, beforeId: 0 }, inc.drilldown.limit);
    parts.push(`"drilldown_preview":${eventsResponseJson(page, page.count)}`);
  }
  return `{${parts.join(',')}}`;
}
