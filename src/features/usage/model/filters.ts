import type { AnalyticsFilters } from '@/lib/api/analytics';

/**
 * Usage filter state. Lives in the URL next to the shared range keys (`range`, `from`, `to`,
 * `bucket`) so a filtered view can be bookmarked; keys are kept short.
 */
export type StatusFilter = 'all' | 'ok' | 'fail';
export type CacheFilter = '' | 'hit' | 'miss' | 'read' | 'creation';
export type ChartMetric = 'requests' | 'tokens' | 'cost' | 'latency' | 'cache';

export interface UsageFilters {
  provider: string;
  models: string[];
  creds: string[];
  status: StatusFilter;
  /** Normalized service tier; the server cannot filter by tier, so it only scopes model-tier figures. */
  tier: string;
  cache: CacheFilter;
  minLatency: number;
  q: string;
  compare: boolean;
}

export const KEYS = {
  provider: 'p',
  models: 'm',
  creds: 'c',
  status: 'st',
  tier: 'tier',
  cache: 'cache',
  minLatency: 'lat',
  q: 'q',
  compare: 'cmp',
  metric: 'mt',
} as const;

const STATUS = new Set<StatusFilter>(['all', 'ok', 'fail']);
const CACHE = new Set<CacheFilter>(['', 'hit', 'miss', 'read', 'creation']);
const METRICS = new Set<ChartMetric>(['requests', 'tokens', 'cost', 'latency', 'cache']);

const uniq = (values: string[]) => Array.from(new Set(values.map((v) => v.trim()).filter(Boolean)));

export function readFilters(params: URLSearchParams): UsageFilters {
  const status = params.get(KEYS.status) as StatusFilter | null;
  const cache = (params.get(KEYS.cache) ?? '') as CacheFilter;
  const lat = Number(params.get(KEYS.minLatency));
  return {
    provider: params.get(KEYS.provider)?.toLowerCase() || 'all',
    models: uniq(params.getAll(KEYS.models)),
    creds: uniq(params.getAll(KEYS.creds)),
    status: status && STATUS.has(status) ? status : 'all',
    tier: params.get(KEYS.tier)?.toLowerCase() ?? '',
    cache: CACHE.has(cache) ? cache : '',
    minLatency: Number.isFinite(lat) && lat > 0 ? Math.round(lat) : 0,
    q: params.get(KEYS.q) ?? '',
    compare: params.get(KEYS.compare) === '1',
  };
}

export function readMetric(params: URLSearchParams): ChartMetric {
  const metric = params.get(KEYS.metric) as ChartMetric | null;
  return metric && METRICS.has(metric) ? metric : 'requests';
}

/** Writes only non-default values; leaves every other key (range, bucket…) untouched. */
export function writeFilters(params: URLSearchParams, filters: UsageFilters): URLSearchParams {
  const next = new URLSearchParams(params);
  const setOrDelete = (key: string, value: string | null) => {
    if (value) next.set(key, value);
    else next.delete(key);
  };
  setOrDelete(KEYS.provider, filters.provider !== 'all' ? filters.provider : null);
  next.delete(KEYS.models);
  filters.models.forEach((m) => next.append(KEYS.models, m));
  next.delete(KEYS.creds);
  filters.creds.forEach((c) => next.append(KEYS.creds, c));
  setOrDelete(KEYS.status, filters.status !== 'all' ? filters.status : null);
  setOrDelete(KEYS.tier, filters.tier || null);
  setOrDelete(KEYS.cache, filters.cache || null);
  setOrDelete(KEYS.minLatency, filters.minLatency > 0 ? String(filters.minLatency) : null);
  setOrDelete(KEYS.q, filters.q.trim() || null);
  setOrDelete(KEYS.compare, filters.compare ? '1' : null);
  return next;
}

/** The server-side part of the filters. `withProvider: false` is used for provider tab counts. */
export function toAnalyticsFilters(filters: UsageFilters, withProvider = true): AnalyticsFilters {
  const out: AnalyticsFilters = {};
  if (withProvider && filters.provider !== 'all') out.providers = [filters.provider];
  if (filters.models.length) out.models = filters.models;
  if (filters.creds.length) out.credential_ids = filters.creds;
  if (filters.status === 'ok') out.include_failed = false;
  if (filters.status === 'fail') out.failed_only = true;
  if (filters.minLatency > 0) out.min_latency_ms = filters.minLatency;
  if (filters.cache) out.cache_status = filters.cache;
  return out;
}

export const CACHE_LABELS: Record<Exclude<CacheFilter, ''>, string> = {
  hit: 'Cache hit',
  miss: 'Cache miss',
  read: 'Cache read',
  creation: 'Cache write',
};

export const LATENCY_OPTIONS = [0, 1000, 3000, 10_000, 30_000, 60_000];

export const latencyLabel = (ms: number) => (ms <= 0 ? 'Any latency' : `≥ ${ms >= 1000 ? `${ms / 1000}s` : `${ms}ms`}`);

export const tierLabel = (tier: string) => (tier === 'normal' ? 'Standard' : tier.charAt(0).toUpperCase() + tier.slice(1));

export function countActiveFilters(filters: UsageFilters): number {
  return (
    filters.models.length +
    filters.creds.length +
    (filters.provider !== 'all' ? 1 : 0) +
    (filters.status !== 'all' ? 1 : 0) +
    (filters.tier ? 1 : 0) +
    (filters.cache ? 1 : 0) +
    (filters.minLatency > 0 ? 1 : 0) +
    (filters.q.trim() ? 1 : 0)
  );
}

export const EMPTY_FILTERS: Omit<UsageFilters, 'compare'> = {
  provider: 'all',
  models: [],
  creds: [],
  status: 'all',
  tier: '',
  cache: '',
  minLatency: 0,
  q: '',
};
