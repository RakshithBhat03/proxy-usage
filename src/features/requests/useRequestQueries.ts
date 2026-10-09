import { keepPreviousData, queryOptions, useQuery, type QueryClient } from '@tanstack/react-query';
import { LOCAL_TIME_ZONE, queryAnalytics, type AnalyticsFilters, type AnalyticsResponse } from '@/lib/api/analytics';
import { freshWindow, rangeKey, type ResolvedRange } from '@/lib/timeRange';

export const REQUESTS_QUERY_ROOT = 'requests-monitor';

/**
 * Queries are keyed by range identity (`rangeKey`: rolling presets by id, fixed ranges by bounds)
 * instead of millisecond bounds, so switching back to a range renders from cache and quick presets
 * can be prefetched. The window itself is computed when the fetch runs (`freshWindow`), and live
 * polling refetches the active queries in place instead of re-keying them.
 */
const FRESH_MS = 30_000;
const SOURCES_FRESH_MS = 60_000;

interface ScopeArgs {
  range: ResolvedRange;
  filters: AnalyticsFilters;
  search: string;
}

type Timeline = 'hour' | 'day' | null;

const base = (window: { fromMs: number; toMs: number }, a: Pick<ScopeArgs, 'filters' | 'search'>) => ({
  from_ms: Math.floor(window.fromMs),
  to_ms: Math.ceil(window.toMs),
  now_ms: Math.ceil(window.toMs),
  time_zone: LOCAL_TIME_ZONE,
  search_query: a.search || undefined,
  filters: a.filters,
});

const filtersKey = (a: Pick<ScopeArgs, 'filters' | 'search'>) => JSON.stringify(a.filters) + '|' + a.search;

/** A response together with the window and scope it was fetched for. */
export interface ScopedPayload {
  res: AnalyticsResponse;
  fromMs: number;
  toMs: number;
  /** Identity of the query that produced it, so placeholder data can be told apart from current data. */
  key: string;
}

export interface AggregatesPayload extends ScopedPayload {
  /** Granularity of `res.timeline` (null when the chart buckets raw events instead). */
  timeline: Timeline;
}

export function aggregatesKey(args: ScopeArgs & { timeline: Timeline }): string {
  return `${rangeKey(args.range)}|${filtersKey(args)}|${args.timeline ?? 'none'}`;
}

/** KPIs + chart timeline + per-model speed. */
export function aggregatesOptions(args: ScopeArgs & { timeline: Timeline }) {
  const key = aggregatesKey(args);
  return queryOptions<AggregatesPayload>({
    queryKey: [REQUESTS_QUERY_ROOT, 'aggregates', key],
    staleTime: FRESH_MS,
    queryFn: ({ signal }) => {
      const window = freshWindow(args.range);
      return queryAnalytics(
        {
          ...base(window, args),
          include: {
            summary: true,
            summary_profile: 'compact',
            summary_percentiles: true,
            summary_comparison: true,
            model_tier_stats: true,
            ...(args.timeline ? { timeline: true, granularity: args.timeline } : {}),
          },
        },
        signal,
      ).then((res) => ({ res, ...window, key, timeline: args.timeline }));
    },
  });
}

export function useAggregates(args: ScopeArgs & { timeline: Timeline }) {
  return useQuery({ ...aggregatesOptions(args), placeholderData: keepPreviousData });
}

/**
 * Dropdown sources and provider-tab counts for the unfiltered window (range + search only), so
 * counts stay stable while filters change.
 */
export function sourcesOptions(args: { range: ResolvedRange; search: string }) {
  return queryOptions<AnalyticsResponse>({
    queryKey: [REQUESTS_QUERY_ROOT, 'sources', rangeKey(args.range), args.search],
    staleTime: SOURCES_FRESH_MS,
    queryFn: ({ signal }) => {
      const window = freshWindow(args.range);
      return queryAnalytics(
        {
          from_ms: Math.floor(window.fromMs),
          to_ms: Math.ceil(window.toMs),
          time_zone: LOCAL_TIME_ZONE,
          search_query: args.search || undefined,
          include: { channel_share: true, model_stats: true },
        },
        signal,
      );
    },
  });
}

export function useFilterSources(args: { range: ResolvedRange; search: string }) {
  return useQuery({ ...sourcesOptions(args), placeholderData: keepPreviousData });
}

/** Failures view: failing sources plus a page of failed events for the status-code breakdown. */
export function failuresOptions(args: ScopeArgs) {
  return queryOptions<AnalyticsResponse>({
    queryKey: [REQUESTS_QUERY_ROOT, 'failures', rangeKey(args.range), filtersKey(args)],
    staleTime: FRESH_MS,
    queryFn: ({ signal }) =>
      queryAnalytics(
        {
          ...base(freshWindow(args.range), args),
          filters: { ...args.filters, failed_only: true, include_failed: undefined },
          include: { failure_sources: true, events_page: { limit: 1000 } },
        },
        signal,
      ),
  });
}

export function useFailures(args: ScopeArgs & { enabled: boolean }) {
  return useQuery({ ...failuresOptions(args), enabled: args.enabled, placeholderData: keepPreviousData });
}

/** Credentials view: per-credential health. */
export function credentialStatsOptions(args: ScopeArgs) {
  return queryOptions<AnalyticsResponse>({
    queryKey: [REQUESTS_QUERY_ROOT, 'credentials', rangeKey(args.range), filtersKey(args)],
    staleTime: FRESH_MS,
    queryFn: ({ signal }) =>
      queryAnalytics({ ...base(freshWindow(args.range), args), include: { credential_stats: true } }, signal),
  });
}

export function useCredentialStats(args: ScopeArgs & { enabled: boolean }) {
  return useQuery({ ...credentialStatsOptions(args), enabled: args.enabled, placeholderData: keepPreviousData });
}

/**
 * One live poll for the summary side: refetch the queries currently on screen (same keys, window
 * re-anchored inside `queryFn`). In-flight fetches are kept rather than restarted, so a slow
 * aggregate on a short interval still lands. Filter sources only refresh once they are stale.
 */
export function pollActiveQueries(client: QueryClient) {
  const opts = { cancelRefetch: false } as const;
  return Promise.all([
    client.refetchQueries({ queryKey: [REQUESTS_QUERY_ROOT, 'aggregates'], type: 'active' }, opts),
    client.refetchQueries({ queryKey: [REQUESTS_QUERY_ROOT, 'failures'], type: 'active' }, opts),
    client.refetchQueries({ queryKey: [REQUESTS_QUERY_ROOT, 'credentials'], type: 'active' }, opts),
    client.refetchQueries({ queryKey: [REQUESTS_QUERY_ROOT, 'sources'], type: 'active', stale: true }, opts),
  ]);
}
