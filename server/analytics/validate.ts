/**
 * Validation of `POST /api/analytics` bodies into a normalized internal request. Failures throw
 * `ValidationError` (mapped to HTTP 400). Unknown fields are ignored, like CPA Manager Plus.
 */
import type { AnalyticsRequest } from '../../shared/analytics-types.ts';
import { isValidTimeZone } from './tz.ts';
import { emptyFilters, normalizeLowerValues, normalizeModelValues, normalizeValues, type Filters, type Scope } from './where.ts';

export const DEFAULT_EVENTS_LIMIT = 100;
export const MAX_EVENTS_LIMIT = 50_000;
export const DEFAULT_DRILLDOWN_LIMIT = 20;
export const MAX_DRILLDOWN_LIMIT = 100;

export class ValidationError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'ValidationError';
    this.code = code;
  }
}

export type Granularity = 'hour' | 'day';

export interface Include {
  summary: boolean;
  summaryCompact: boolean;
  summaryPercentiles: boolean;
  summaryComparison: boolean;
  timeline: boolean;
  hourlyDistribution: boolean;
  heatmap: boolean;
  anomalyPoints: boolean;
  modelStats: boolean;
  modelTierStats: boolean;
  channelShare: boolean;
  failureSources: boolean;
  credentialStats: boolean;
  credentialTimeline: boolean;
  apiKeyStats: boolean;
  filterOptions: boolean;
  filterSelectors: boolean;
  eventsPage: { limit: number; beforeMs: number; beforeId: number } | null;
  drilldown: { fromMs: number; toMs: number; limit: number } | null;
}

export interface NormalizedRequest extends Scope {
  nowMs: number;
  timeZone: string;
  granularity: Granularity;
  include: Include;
}

type Obj = Record<string, unknown>;

const isObj = (value: unknown): value is Obj => typeof value === 'object' && value !== null && !Array.isArray(value);

function intField(value: unknown, name: string, { required = false, min = 0 } = {}): number {
  if (value === undefined || value === null) {
    if (required) throw new ValidationError('invalid_request', `${name} is required`);
    return 0;
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
    throw new ValidationError('invalid_request', `${name} must be an integer`);
  }
  if (value < min) throw new ValidationError('invalid_request', `${name} must be >= ${min}`);
  return value;
}

function strings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

const bool = (value: unknown) => value === true;

export function normalizeGranularity(input: unknown, fromMs: number, toMs: number): Granularity {
  if (input === 'hour' || input === 'day') return input;
  return toMs - fromMs <= 86_400_000 ? 'hour' : 'day';
}

export function parseFilters(value: unknown): Filters {
  const filters = emptyFilters();
  if (!isObj(value)) return filters;
  filters.models = normalizeModelValues(strings(value.models));
  filters.providers = normalizeLowerValues(strings(value.providers));
  filters.accounts = normalizeLowerValues(strings(value.accounts));
  filters.credentialIds = normalizeValues(strings(value.credential_ids));
  filters.authFiles = normalizeValues(strings(value.auth_files));
  filters.authIndices = normalizeValues(strings(value.auth_indices));
  filters.apiKeyHashes = normalizeValues(strings(value.api_key_hashes));
  filters.sourceHashes = normalizeValues(strings(value.source_hashes));
  filters.projectIds = normalizeValues(strings(value.project_ids));
  filters.requestTypes = normalizeValues(strings(value.request_types));
  filters.headerErrorKinds = normalizeValues(strings(value.header_error_kinds));
  filters.headerErrorCodes = normalizeValues(strings(value.header_error_codes));
  filters.headerQuotaPlans = normalizeValues(strings(value.header_quota_plans));
  filters.headerTraceIds = normalizeValues(strings(value.header_trace_ids));
  filters.includeFailed = value.include_failed === false ? false : true;
  filters.failedOnly = bool(value.failed_only);
  if (value.min_latency_ms !== undefined && value.min_latency_ms !== null) {
    filters.minLatencyMs = intField(value.min_latency_ms, 'filters.min_latency_ms', { min: 0 });
  }
  filters.cacheStatus = typeof value.cache_status === 'string' ? value.cache_status.trim().toLowerCase() : '';
  return filters;
}

export function validateAnalyticsRequest(body: unknown, serverNowMs = Date.now()): NormalizedRequest {
  if (!isObj(body)) throw new ValidationError('invalid_request', 'request body must be a JSON object');
  const req = body as Partial<AnalyticsRequest> & Obj;
  const fromMs = intField(req.from_ms, 'from_ms', { required: true, min: 1 });
  const toMs = intField(req.to_ms, 'to_ms', { required: true, min: 1 });
  if (toMs <= fromMs) throw new ValidationError('invalid_request', 'to_ms must be greater than from_ms');

  let nowMs = req.now_ms === undefined || req.now_ms === null ? 0 : intField(req.now_ms, 'now_ms', { min: 0 });
  if (nowMs <= 0) nowMs = serverNowMs;

  const timeZone = typeof req.time_zone === 'string' && req.time_zone.trim() ? req.time_zone.trim() : 'UTC';
  if (!isValidTimeZone(timeZone)) throw new ValidationError('invalid_time_zone', `invalid time zone: ${timeZone}`);

  const raw = isObj(req.include) ? req.include : {};
  const summary = bool(raw.summary);
  const include: Include = {
    summary,
    summaryCompact: summary && raw.summary_profile === 'compact',
    summaryPercentiles: bool(raw.summary_percentiles),
    summaryComparison: summary && bool(raw.summary_comparison),
    timeline: bool(raw.timeline),
    hourlyDistribution: bool(raw.hourly_distribution),
    heatmap: bool(raw.heatmap),
    anomalyPoints: bool(raw.anomaly_points),
    modelStats: bool(raw.model_stats),
    modelTierStats: bool(raw.model_tier_stats),
    channelShare: bool(raw.channel_share),
    failureSources: bool(raw.failure_sources),
    credentialStats: bool(raw.credential_stats),
    credentialTimeline: bool(raw.credential_timeline),
    apiKeyStats: bool(raw.api_key_stats),
    filterOptions: bool(raw.filter_options),
    filterSelectors: bool(raw.filter_selectors),
    eventsPage: null,
    drilldown: null,
  };

  if (isObj(raw.events_page)) {
    const page = raw.events_page;
    let limit = page.limit === undefined || page.limit === null ? 0 : intField(page.limit, 'include.events_page.limit');
    if (limit > MAX_EVENTS_LIMIT) {
      throw new ValidationError('invalid_request', `events_page.limit must be less than or equal to ${MAX_EVENTS_LIMIT}`);
    }
    if (limit <= 0) limit = DEFAULT_EVENTS_LIMIT;
    const beforeMs = page.before_ms === undefined || page.before_ms === null ? 0 : intField(page.before_ms, 'include.events_page.before_ms');
    const beforeId = page.before_id === undefined || page.before_id === null ? 0 : intField(page.before_id, 'include.events_page.before_id');
    include.eventsPage = { limit, beforeMs, beforeId };
  }
  if (isObj(raw.drilldown_preview)) {
    const preview = raw.drilldown_preview;
    const previewFrom = preview.from_ms === undefined || preview.from_ms === null ? 0 : intField(preview.from_ms, 'include.drilldown_preview.from_ms');
    const previewTo = preview.to_ms === undefined || preview.to_ms === null ? 0 : intField(preview.to_ms, 'include.drilldown_preview.to_ms');
    let limit = preview.limit === undefined || preview.limit === null ? 0 : intField(preview.limit, 'include.drilldown_preview.limit');
    if (limit <= 0) limit = DEFAULT_DRILLDOWN_LIMIT;
    if (limit > MAX_DRILLDOWN_LIMIT) limit = MAX_DRILLDOWN_LIMIT;
    if (previewFrom > 0 && previewTo > previewFrom) include.drilldown = { fromMs: previewFrom, toMs: previewTo, limit };
  }

  return {
    fromMs,
    toMs,
    nowMs,
    timeZone,
    granularity: normalizeGranularity(raw.granularity, fromMs, toMs),
    searchQuery: typeof req.search_query === 'string' ? req.search_query : '',
    searchApiKeyHash: typeof req.search_api_key_hash === 'string' ? req.search_api_key_hash : '',
    filters: parseFilters(req.filters),
    include,
  };
}
