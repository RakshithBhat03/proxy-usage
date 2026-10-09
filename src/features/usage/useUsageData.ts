import { keepPreviousData, queryOptions, useQuery } from '@tanstack/react-query';
import {
  LOCAL_TIME_ZONE,
  queryAnalytics,
  type AnalyticsFilters,
  type AnalyticsRequest,
  type AnalyticsResponse,
  type CredentialStatRow,
  type FilterOptions,
  type EventRow,
} from '@/lib/api/analytics';
import { freshWindow, rangeKey, type BucketPlan, type ResolvedRange } from '@/lib/timeRange';
import { toAnalyticsFilters, type UsageFilters } from './model/filters';

/** Every query of this page lives under this prefix so refresh can target them together. */
export const USAGE_QUERY_ROOT = 'usage-page';

/**
 * Range switches should feel instant: queries are keyed by range identity (`rangeKey`), not by
 * millisecond bounds, and stay fresh for a minute, so revisiting a range renders from cache while
 * quick presets are prefetched in the background. The window is computed when the fetch runs.
 */
const FRESH_MS = 60_000;

/** Raw-event paging cap for sub-hour charts (pages are up to 50k rows each). */
const EVENT_PAGE_LIMIT = 50_000;
const MAX_EVENTS = 200_000;

interface Base {
  range: ResolvedRange;
  filters: UsageFilters;
}

function baseRequest(range: { fromMs: number; toMs: number }, filters: AnalyticsFilters, q: string): AnalyticsRequest {
  return {
    from_ms: Math.floor(range.fromMs),
    to_ms: Math.ceil(range.toMs),
    now_ms: Math.ceil(range.toMs),
    time_zone: LOCAL_TIME_ZONE,
    search_query: q.trim() || undefined,
    filters,
  };
}

export interface MainPayload {
  res: AnalyticsResponse;
  fromMs: number;
  toMs: number;
  /** The plan the payload was fetched for; placeholder data must be bucketed with it, not the new one. */
  plan: BucketPlan;
  rangeKey: string;
}

/** The page's main payload: summary + timeline + every breakdown, one round trip (~0.3s). */
export function usageMainOptions({ range, filters, plan }: Base & { plan: BucketPlan }) {
  const serverFilters = toAnalyticsFilters(filters);
  const granularity: 'hour' | 'day' = plan.source === 'day' ? 'day' : 'hour';
  const key = rangeKey(range);
  return queryOptions<MainPayload>({
    queryKey: [USAGE_QUERY_ROOT, 'main', key, granularity, plan.source === 'events', plan.size, serverFilters, filters.q, filters.compare],
    staleTime: FRESH_MS,
    queryFn: ({ signal }) => {
      const window = freshWindow(range);
      return queryAnalytics(
        {
          ...baseRequest(window, serverFilters, filters.q),
          include: {
            summary: true,
            summary_profile: 'full',
            summary_comparison: filters.compare,
            timeline: plan.source !== 'events',
            granularity,
            hourly_distribution: true,
            heatmap: true,
            anomaly_points: true,
            model_tier_stats: true,
            credential_stats: true,
            credential_timeline: true,
            api_key_stats: true,
          },
        },
        signal,
      ).then((res) => ({ res, ...window, plan, rangeKey: key }));
    },
  });
}

export function useUsageMain({ range, filters, plan, enabled = true }: Base & { plan: BucketPlan; enabled?: boolean }) {
  return useQuery({ ...usageMainOptions({ range, filters, plan }), enabled, placeholderData: keepPreviousData });
}

/**
 * The equal-length window before the range, for deltas the server's `summary_comparison` lacks
 * (latency, TTFT, TPS, cache hit).
 */
export function usePreviousPeriod({ range, filters }: Base) {
  const serverFilters = toAnalyticsFilters(filters);
  return useQuery<AnalyticsResponse>({
    queryKey: [USAGE_QUERY_ROOT, 'prev', rangeKey(range), serverFilters, filters.q],
    enabled: filters.compare,
    staleTime: FRESH_MS,
    queryFn: ({ signal }) => {
      const window = freshWindow(range);
      const span = window.toMs - window.fromMs;
      const prev = { fromMs: window.fromMs - span, toMs: window.fromMs };
      return queryAnalytics(
        {
          ...baseRequest(prev, serverFilters, filters.q),
          include: { summary: true, summary_profile: 'compact', summary_percentiles: true, model_tier_stats: true },
        },
        signal,
      );
    },
    placeholderData: keepPreviousData,
  });
}

export interface EventsResult {
  items: EventRow[];
  total: number;
  truncated: boolean;
  fromMs: number;
  toMs: number;
  plan: BucketPlan;
}

/** Raw events for sub-hour buckets, paged newest-first until exhausted or capped. */
export function usageEventsOptions({ range, filters, plan }: Base & { plan: BucketPlan }) {
  const serverFilters = toAnalyticsFilters(filters);
  return queryOptions<EventsResult>({
    queryKey: [USAGE_QUERY_ROOT, 'events', rangeKey(range), plan.size, serverFilters, filters.q],
    staleTime: FRESH_MS,
    queryFn: async ({ signal }): Promise<EventsResult> => {
      const window = freshWindow(range);
      const items: EventRow[] = [];
      let before: { ms: number; id: number } | null = null;
      let total = 0;
      let hasMore = true;
      while (hasMore && items.length < MAX_EVENTS) {
        const response = await queryAnalytics(
          {
            ...baseRequest(window, serverFilters, filters.q),
            include: {
              events_page: {
                limit: Math.min(EVENT_PAGE_LIMIT, MAX_EVENTS - items.length),
                before_ms: before?.ms ?? null,
                before_id: before?.id ?? null,
              },
            },
          },
          signal,
        );
        const page = response.events;
        if (!page) break;
        items.push(...(page.items ?? []));
        total = page.total_count;
        hasMore = page.has_more && (page.items?.length ?? 0) > 0;
        before = { ms: page.next_before_ms, id: page.next_before_id };
      }
      return { items, total, truncated: hasMore, ...window, plan };
    },
  });
}

export function useUsageEvents({ range, filters, plan, enabled }: Base & { plan: BucketPlan; enabled: boolean }) {
  return useQuery({ ...usageEventsOptions({ range, filters, plan }), enabled, placeholderData: keepPreviousData });
}

/** Light selector lists for the filter dropdowns (option values ignore filters server-side). */
export function useUsageSelectors({ range, q }: { range: ResolvedRange; q: string }) {
  return useQuery<FilterOptions>({
    queryKey: [USAGE_QUERY_ROOT, 'selectors', rangeKey(range), q],
    queryFn: ({ signal }) =>
      queryAnalytics(
        { ...baseRequest(freshWindow(range), {}, q), include: { filter_options: true, filter_selectors: true } },
        signal,
      ).then((r) => r.filter_options ?? {}),
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });
}

/** Provider tab counts ignore the provider filter itself; only needed while one is selected. */
export function useProviderFacets({ range, filters }: Base) {
  const serverFilters = toAnalyticsFilters(filters, false);
  return useQuery<CredentialStatRow[]>({
    queryKey: [USAGE_QUERY_ROOT, 'facets', rangeKey(range), serverFilters, filters.q],
    enabled: filters.provider !== 'all',
    staleTime: FRESH_MS,
    queryFn: ({ signal }) =>
      queryAnalytics({ ...baseRequest(freshWindow(range), serverFilters, filters.q), include: { credential_stats: true } }, signal).then(
        (r) => r.credential_stats ?? [],
      ),
    placeholderData: keepPreviousData,
  });
}

/** Up to 20 events of one chart bucket. */
export function useBucketDrilldown({
  range,
  filters,
  bucket,
}: Base & { bucket: { start: number; end: number } | null }) {
  const serverFilters = toAnalyticsFilters(filters);
  return useQuery({
    queryKey: [USAGE_QUERY_ROOT, 'drill', bucket?.start, bucket?.end, serverFilters, filters.q],
    enabled: bucket !== null,
    queryFn: ({ signal }) => {
      const from = Math.max(bucket!.start, range.fromMs);
      const to = Math.min(bucket!.end, range.toMs);
      return queryAnalytics(
        {
          ...baseRequest({ ...range, fromMs: from, toMs: to }, serverFilters, filters.q),
          include: { summary: true, summary_profile: 'compact', drilldown_preview: { from_ms: from, to_ms: to, limit: 20 } },
        },
        signal,
      );
    },
  });
}

const ALL_TIME_FROM = Date.UTC(2020, 0, 1);

/**
 * First day with traffic, so "All time" starts at the data instead of an arbitrary floor (which
 * would otherwise pick weekly buckets for years of empty history).
 */
export function useDataFloor(enabled: boolean) {
  return useQuery<number | null>({
    queryKey: [USAGE_QUERY_ROOT, 'floor'],
    enabled,
    staleTime: 10 * 60_000,
    queryFn: ({ signal }) =>
      queryAnalytics(
        { from_ms: ALL_TIME_FROM, to_ms: Date.now(), time_zone: LOCAL_TIME_ZONE, include: { timeline: true, granularity: 'day' } },
        signal,
      ).then((r) => {
        const first = (r.timeline ?? []).reduce<number | null>((min, p) => (p.calls > 0 && (min === null || p.bucket_ms < min) ? p.bucket_ms : min), null);
        return first;
      }),
  });
}

/** Every model ever seen, for the price-book sync list and "unpriced" highlighting. */
export function useAllTimeModels(enabled: boolean) {
  return useQuery({
    queryKey: [USAGE_QUERY_ROOT, 'models-all'],
    enabled,
    staleTime: 5 * 60_000,
    queryFn: ({ signal }) =>
      queryAnalytics(
        {
          from_ms: ALL_TIME_FROM,
          to_ms: Date.now(),
          time_zone: LOCAL_TIME_ZONE,
          include: { filter_options: true, filter_selectors: true, model_tier_stats: true },
        },
        signal,
      ),
  });
}
