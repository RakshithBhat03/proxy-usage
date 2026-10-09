import type { AnalyticsFilters, EventRow } from '@/lib/api/analytics';
import { normalizeServiceTier, statusCodeOf } from './events';

/**
 * Request Monitor filter state. Everything lives in the URL so a filtered view can be shared.
 * The server only understands a subset (`AnalyticsFilters` in shared/analytics-types.ts), so status
 * classes, max latency, stream and service tier are refined on the client over loaded rows.
 */
export type StatusFilter = 'all' | 'success' | 'failed' | '4xx' | '5xx' | '429' | '499';
export type StreamFilter = 'all' | 'stream' | 'sync';
export type CacheFilter = '' | 'hit' | 'miss' | 'read' | 'creation';

export interface RequestFilters {
  search: string;
  provider: string;
  status: StatusFilter;
  model: string;
  credential: string;
  minLatencyMs: number | null;
  maxLatencyMs: number | null;
  cache: CacheFilter;
  stream: StreamFilter;
  tier: string;
}

export const STATUS_OPTIONS: Array<{ value: StatusFilter; label: string; title: string }> = [
  { value: 'all', label: 'All', title: 'Every request' },
  { value: 'success', label: 'Success', title: 'Successful requests' },
  { value: 'failed', label: 'Failed', title: 'Any failure' },
  { value: '4xx', label: '4xx', title: 'Client-side / request errors (400–499)' },
  { value: '5xx', label: '5xx', title: 'Upstream / transport errors (500+)' },
  { value: '429', label: '429', title: 'Rate limited' },
  { value: '499', label: '499', title: 'Client cancelled (context canceled)' },
];

export const CACHE_OPTIONS: Array<{ value: CacheFilter; label: string }> = [
  { value: '', label: 'Any' },
  { value: 'hit', label: 'Cache hit' },
  { value: 'miss', label: 'Cache miss' },
  { value: 'read', label: 'Cache read' },
  { value: 'creation', label: 'Cache write' },
];

export const STREAM_OPTIONS: Array<{ value: StreamFilter; label: string }> = [
  { value: 'all', label: 'Any' },
  { value: 'stream', label: 'Streaming' },
  { value: 'sync', label: 'Non-stream' },
];

const STATUS_VALUES = new Set<string>(STATUS_OPTIONS.map((o) => o.value));
const CACHE_VALUES = new Set<string>(CACHE_OPTIONS.map((o) => o.value));
const STREAM_VALUES = new Set<string>(STREAM_OPTIONS.map((o) => o.value));

const positiveOrNull = (raw: string | null) => {
  const value = Number(raw);
  return raw !== null && raw !== '' && Number.isFinite(value) && value > 0 ? value : null;
};

export function readFilters(params: URLSearchParams): RequestFilters {
  const status = params.get('status') ?? 'all';
  const cache = params.get('cache') ?? '';
  const stream = params.get('stream') ?? 'all';
  return {
    search: params.get('q') ?? '',
    provider: params.get('provider') || 'all',
    status: (STATUS_VALUES.has(status) ? status : 'all') as StatusFilter,
    model: params.get('model') ?? '',
    credential: params.get('cred') ?? '',
    minLatencyMs: positiveOrNull(params.get('minlat')),
    maxLatencyMs: positiveOrNull(params.get('maxlat')),
    cache: (CACHE_VALUES.has(cache) ? cache : '') as CacheFilter,
    stream: (STREAM_VALUES.has(stream) ? stream : 'all') as StreamFilter,
    tier: params.get('tier') ?? '',
  };
}

const PARAM_KEYS: Record<keyof RequestFilters, string> = {
  search: 'q',
  provider: 'provider',
  status: 'status',
  model: 'model',
  credential: 'cred',
  minLatencyMs: 'minlat',
  maxLatencyMs: 'maxlat',
  cache: 'cache',
  stream: 'stream',
  tier: 'tier',
};

const DEFAULTS: RequestFilters = {
  search: '',
  provider: 'all',
  status: 'all',
  model: '',
  credential: '',
  minLatencyMs: null,
  maxLatencyMs: null,
  cache: '',
  stream: 'all',
  tier: '',
};

export function writeFilters(params: URLSearchParams, patch: Partial<RequestFilters>): URLSearchParams {
  const next = new URLSearchParams(params);
  (Object.keys(patch) as Array<keyof RequestFilters>).forEach((key) => {
    const value = patch[key];
    const param = PARAM_KEYS[key];
    if (value === undefined || value === null || value === '' || value === DEFAULTS[key]) next.delete(param);
    else next.set(param, String(value));
  });
  return next;
}

export const CLEARED_FILTERS: Omit<RequestFilters, 'search'> = {
  provider: 'all',
  status: 'all',
  model: '',
  credential: '',
  minLatencyMs: null,
  maxLatencyMs: null,
  cache: '',
  stream: 'all',
  tier: '',
};

/** The part of the filter set the analytics endpoint can apply. */
export function toServerFilters(f: RequestFilters): AnalyticsFilters {
  const filters: AnalyticsFilters = {};
  if (f.provider && f.provider !== 'all') filters.providers = [f.provider];
  if (f.model) filters.models = [f.model];
  if (f.credential) filters.auth_indices = [f.credential];
  if (f.minLatencyMs) filters.min_latency_ms = Math.round(f.minLatencyMs);
  if (f.cache) filters.cache_status = f.cache;
  if (f.status === 'success') filters.include_failed = false;
  else if (f.status !== 'all') filters.failed_only = true;
  return filters;
}

/** True when some rows the server returns may be hidden by client-only refinements. */
export function hasClientRefinement(f: RequestFilters): boolean {
  return (
    !['all', 'success', 'failed'].includes(f.status) || f.maxLatencyMs !== null || f.stream !== 'all' || f.tier !== ''
  );
}

export function matchesStatus(event: Pick<EventRow, 'failed' | 'fail_status_code' | 'fail_summary'>, status: StatusFilter) {
  if (status === 'all') return true;
  if (status === 'success') return !event.failed;
  if (!event.failed) return false;
  const code = statusCodeOf(event);
  switch (status) {
    case 'failed':
      return true;
    case '4xx':
      return code >= 400 && code < 500;
    case '5xx':
      return code >= 500;
    case '429':
      return code === 429;
    case '499':
      return code === 499 || /context canceled/i.test(event.fail_summary ?? '');
    default:
      return true;
  }
}

export function matchesClient(event: EventRow, f: RequestFilters): boolean {
  if (!matchesStatus(event, f.status)) return false;
  if (f.maxLatencyMs !== null && (event.latency_ms ?? 0) > f.maxLatencyMs) return false;
  if (f.stream === 'stream' && !event.stream) return false;
  if (f.stream === 'sync' && event.stream) return false;
  if (f.tier && normalizeServiceTier(event.service_tier) !== f.tier) return false;
  return true;
}

/** Stable key of everything that changes which rows the server returns. */
export function serverScopeKey(f: RequestFilters): string {
  return JSON.stringify(toServerFilters(f)) + '|' + f.search.trim();
}
