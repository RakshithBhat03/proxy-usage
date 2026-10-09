import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useSwapAnimation } from '@/hooks/useSwapAnimation';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { PageHeader, Panel, ProviderIcon, SegmentedControl, ShowEmailsToggle, type MetaPart, type TabItem } from '@/components/kit';
import { EmptyState } from '@/components/ui/EmptyState';
import { IconDollarSign, IconRefreshCw } from '@/components/ui/icons';
import { useRevealGroup } from '@/hooks/motion';
import { useHeaderRefresh } from '@/hooks/useHeaderRefresh';
import { useNow } from '@/hooks/useNow';
import { useTimeRange } from '@/hooks/useTimeRange';
import { HistoryStartNotice } from '@/features/session/SessionBanner';
import { formatClock, formatCost, formatInt, formatTokens } from '@/lib/format';
import { MODEL_PRICES_QUERY_KEY, useModelPrices } from '@/lib/pricing';
import { normalizeProvider, providerLabel } from '@/lib/providers';
import { BUCKET_LABELS, QUICK_PRESETS, planBuckets, resolveRange, type TimeRangeValue } from '@/lib/timeRange';
import { useIdentity } from '@/stores/privacy';
import { TimelineChart } from './charts/TimelineChart';
import { AnomaliesPanel } from './components/AnomaliesPanel';
import { ApiKeysPanel } from './components/ApiKeysPanel';
import { BucketDrilldown } from './components/BucketDrilldown';
import { ChoicePill } from './components/ChoicePill';
import { CredentialsPanel, credentialProvider } from './components/CredentialsPanel';
import { HeatmapPanel } from './components/HeatmapPanel';
import { KpiGrid } from './components/KpiGrid';
import { ModelPricesSheet } from './components/ModelPricesSheet';
import { ModelSharePanel, ModelsPanel, isUnpriced } from './components/ModelsPanel';
import type { MultiOption } from './components/MultiSelect';
import { ProvidersPanel } from './components/ProvidersPanel';
import { TokenCompositionPanel } from './components/TokenCompositionPanel';
import { UsageSkeleton } from './components/UsageSkeleton';
import { UsageToolbar } from './components/UsageToolbar';
import { aggregateTiers, credentialLabel, fileProvider, modelProvider } from './model/derive';
import { countActiveFilters, type ChartMetric } from './model/filters';
import { attachAnomalies, bucketsFromEvents, bucketsFromTimeline, type ChartBucket } from './model/timeline';
import { AUTO_REFRESH_CHOICES, useAutoRefresh, type AutoRefresh } from './model/useAutoRefresh';
import { useUsageFilters } from './model/useUsageFilters';
import {
  USAGE_QUERY_ROOT,
  useBucketDrilldown,
  useDataFloor,
  useProviderFacets,
  usePreviousPeriod,
  useUsageEvents,
  useUsageMain,
  usageEventsOptions,
  usageMainOptions,
  useUsageSelectors,
} from './useUsageData';
import styles from './UsagePage.module.scss';

const METRICS: Array<{ value: ChartMetric; label: string }> = [
  { value: 'requests', label: 'Requests' },
  { value: 'tokens', label: 'Tokens' },
  { value: 'cost', label: 'Cost' },
  { value: 'latency', label: 'Latency' },
  { value: 'cache', label: 'Cache hit' },
];

/** Resolves once no usage query is in flight (header ⟳ spinner), capped so it never hangs. */
function waitForIdle(client: QueryClient, timeoutMs = 30_000): Promise<void> {
  return new Promise((resolve) => {
    const isIdle = () => client.isFetching({ queryKey: [USAGE_QUERY_ROOT] }) === 0;
    // Let the state update that changes query keys render first.
    window.setTimeout(() => {
      if (isIdle()) return resolve();
      const timer = window.setTimeout(done, timeoutMs);
      const unsubscribe = client.getQueryCache().subscribe(() => {
        if (isIdle()) done();
      });
      function done() {
        window.clearTimeout(timer);
        unsubscribe();
        resolve();
      }
    }, 60);
  });
}

export default function UsagePage() {
  const [params] = useSearchParams();
  const allTime = params.get('range') === 'all';
  const floor = useDataFloor(allTime);
  const time = useTimeRange('today', floor.data ?? undefined);
  const waitingForFloor = allTime && floor.isPending;
  const filterState = useUsageFilters();
  const { filters, metric, setMetric, update, toggleIn } = filterState;
  const { range, plan, tick } = time;
  const queryClient = useQueryClient();
  const identity = useIdentity();
  const now = useNow(30_000);
  const headerRef = useRevealGroup<HTMLDivElement>();

  const main = useUsageMain({ range, filters, plan, enabled: !waitingForFloor });
  const previous = usePreviousPeriod({ range, filters });
  const events = useUsageEvents({ range, filters, plan, enabled: plan.source === 'events' && !waitingForFloor });
  const selectors = useUsageSelectors({ range, q: filters.q });
  const facets = useProviderFacets({ range, filters });
  const prices = useModelPrices();

  /* ---------- Prefetch ---------- */
  // The server computes these stats from raw rows (0.3–0.6s per range), so ranges are warmed
  // ahead of the click: on hover/focus of a preset, and for every quick preset once the page is
  // idle. A click then renders straight from cache.
  const floorMs = floor.data ?? undefined;
  const prefetchRange = useCallback(
    (value: TimeRangeValue) => {
      const r = resolveRange(value, Date.now(), floorMs);
      const p = planBuckets(r, time.bucket);
      void queryClient.prefetchQuery(usageMainOptions({ range: r, filters, plan: p }));
      if (p.source === 'events') void queryClient.prefetchQuery(usageEventsOptions({ range: r, filters, plan: p }));
    },
    [queryClient, filters, time.bucket, floorMs],
  );
  const settled = main.isSuccess && !main.isFetching;
  useEffect(() => {
    if (!settled) return;
    const id = window.setTimeout(() => QUICK_PRESETS.forEach((preset) => prefetchRange({ preset })), 700);
    return () => window.clearTimeout(id);
  }, [settled, prefetchRange]);

  const [pricesOpen, setPricesOpen] = useState(false);
  const navigate = useNavigate();

  const refresh = useCallback(() => {
    // Keys are per range identity, so a refresh refetches in place (rolling windows re-anchor
    // inside the query); tick() only updates the range labels.
    if (range.live) tick();
    void queryClient.invalidateQueries({ queryKey: [USAGE_QUERY_ROOT] });
  }, [range.live, tick, queryClient]);
  const [autoRefresh, setAutoRefresh] = useAutoRefresh(refresh);

  const headerRefresh = useCallback(async () => {
    refresh();
    void queryClient.invalidateQueries({ queryKey: MODEL_PRICES_QUERY_KEY });
    await waitForIdle(queryClient);
  }, [refresh, queryClient]);
  useHeaderRefresh(headerRefresh);

  const res = main.data?.res;
  const dataFrom = main.data?.fromMs ?? range.fromMs;
  const dataTo = main.data?.toMs ?? range.toMs;
  const summary = res?.summary;

  /* ---------- Timeline ---------- */
  // The chart always shows the newest data it actually has, bucketed with the plan that data was
  // fetched for. While a new range loads the previous chart stays (never re-bucketed into the
  // new plan, which made it change shape twice), then the new one enters.
  const display = useMemo(() => {
    const ev = events.data;
    const md = main.data;
    if (plan.source === 'events' && ev) return { kind: 'events' as const, plan: ev.plan, ev, md };
    if (md && md.plan.source !== 'events') return { kind: 'timeline' as const, plan: md.plan, md };
    if (ev) return { kind: 'events' as const, plan: ev.plan, ev, md };
    return null;
  }, [plan.source, events.data, main.data]);
  const chartPlan = display?.plan ?? plan;

  const buckets = useMemo<ChartBucket[]>(() => {
    if (!display) return [];
    const list =
      display.kind === 'events'
        ? bucketsFromEvents(display.ev.items, display.ev.fromMs, display.ev.toMs, display.plan, prices.data ?? {})
        : bucketsFromTimeline(display.md.res.timeline ?? [], display.md.fromMs, display.md.toMs, display.plan);
    return attachAnomalies(list, display.md?.res.anomaly_points ?? []);
  }, [display, prices.data]);

  /* ---------- Drilldown ---------- */
  const [selected, setSelected] = useState<ChartBucket | null>(null);
  const selectionScope = `${time.value.preset}|${time.value.fromMs}|${time.value.toMs}|${plan.size}|${JSON.stringify(filters)}`;
  useEffect(() => setSelected(null), [selectionScope]);
  const selectedBucket = selected ? (buckets.find((b) => b.start === selected.start) ?? selected) : null;
  const drill = useBucketDrilldown({ range, filters, bucket: selectedBucket ? { start: selectedBucket.start, end: selectedBucket.end } : null });

  /* ---------- Derived rows ---------- */
  const tierRows = useMemo(() => {
    const rows = res?.model_tier_stats ?? [];
    return filters.tier ? rows.filter((r) => r.service_tier === filters.tier) : rows;
  }, [res, filters.tier]);
  const tiers = useMemo(() => aggregateTiers(tierRows), [tierRows]);
  const previousTiers = useMemo(() => {
    const rows = previous.data?.model_tier_stats ?? [];
    return aggregateTiers(filters.tier ? rows.filter((r) => r.service_tier === filters.tier) : rows);
  }, [previous.data, filters.tier]);

  const credentialRows = useMemo(() => res?.credential_stats ?? [], [res]);
  const credLabels = useMemo(() => {
    const map = new Map<string, string>();
    credentialRows.forEach((r) => map.set(r.id, credentialLabel(r)));
    return map;
  }, [credentialRows]);

  /* ---------- Toolbar options ---------- */
  const providerItems = useMemo<TabItem[]>(() => {
    const source = filters.provider === 'all' ? credentialRows : (facets.data ?? []);
    const counts = new Map<string, number>();
    source.forEach((r) => {
      const p = normalizeProvider(credentialProvider(r));
      if (p) counts.set(p, (counts.get(p) ?? 0) + r.calls);
    });
    (selectors.data?.providers ?? []).forEach((p) => {
      const key = normalizeProvider(p);
      if (!counts.has(key)) counts.set(key, 0);
    });
    if (filters.provider !== 'all' && !counts.has(filters.provider)) counts.set(filters.provider, 0);
    const total = Array.from(counts.values()).reduce((s, v) => s + v, 0);
    const items: TabItem[] = Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([id, count]) => ({ id, label: providerLabel(id), count }));
    return [{ id: 'all', label: 'All', count: total }, ...items];
  }, [filters.provider, credentialRows, facets.data, selectors.data]);

  const modelOptions = useMemo<MultiOption[]>(() => {
    const calls = new Map<string, number>();
    (res?.model_tier_stats ?? []).forEach((r) => calls.set(r.model, (calls.get(r.model) ?? 0) + r.calls));
    const names = Array.from(new Set([...(selectors.data?.models ?? []), ...calls.keys()]));
    return names
      .sort((a, b) => (calls.get(b) ?? 0) - (calls.get(a) ?? 0) || a.localeCompare(b))
      .map((m) => ({
        value: m,
        label: m,
        hint: calls.has(m) ? formatInt(calls.get(m)) : undefined,
        icon: modelProvider(m) ? <ProviderIcon provider={modelProvider(m)} size={12} /> : undefined,
      }));
  }, [res, selectors.data]);

  const credOptions = useMemo<MultiOption[]>(() => {
    const ids = Array.from(new Set([...credentialRows.map((r) => r.id), ...(selectors.data?.auth_files ?? [])]));
    return ids.map((id) => {
      const row = credentialRows.find((r) => r.id === id);
      const provider = row ? credentialProvider(row) : fileProvider(id);
      return {
        value: id,
        label: identity(credLabels.get(id) ?? id),
        hint: row ? formatInt(row.calls) : providerLabel(provider),
        icon: <ProviderIcon provider={provider} size={12} />,
      };
    });
  }, [credentialRows, selectors.data, identity, credLabels]);

  const tierOptions = useMemo(() => {
    const set = new Set((res?.model_tier_stats ?? []).map((r) => r.service_tier).filter(Boolean));
    if (filters.tier) set.add(filters.tier);
    return Array.from(set).sort((a, b) => (a === 'normal' ? -1 : b === 'normal' ? 1 : a.localeCompare(b)));
  }, [res, filters.tier]);

  /* ---------- Header ---------- */
  const meta: MetaPart[] = summary
    ? [
        { text: `${formatInt(summary.total_calls)} requests` },
        { text: `${formatTokens(summary.total_tokens)} tokens` },
        { text: formatCost(summary.total_cost), tone: 'live' },
        ...(summary.failure_calls > 0 ? [{ text: `${formatInt(summary.failure_calls)} failed`, tone: 'attention' as const }] : []),
        { text: `updated ${formatClock(res?.generated_at_ms, false)}`, tone: 'muted' as const },
      ]
    : [{ text: main.isError ? 'unavailable' : 'loading…', tone: 'muted' }];

  const rangeModels = useMemo(() => Array.from(new Set((res?.model_tier_stats ?? []).map((r) => r.model))), [res]);
  const unpricedInRange = new Set(tierRows.filter(isUnpriced).map((r) => r.model)).size;
  const fetching = main.isFetching || (plan.source === 'events' && events.isFetching);
  const empty = summary !== undefined && summary.total_calls === 0;
  const error = main.error ?? (plan.source === 'events' ? events.error : null);

  return (
    <div className={`kit-page ${styles.page}`}>
      <div ref={headerRef} className={styles.top}>
        <PageHeader
          title="Usage"
          meta={meta}
          actions={
            <>
              <ChoicePill<AutoRefresh>
                label="Auto refresh"
                icon={<IconRefreshCw size={13} className={fetching ? 'kit-spin' : undefined} />}
                value={autoRefresh}
                align="right"
                neutral="off"
                choices={AUTO_REFRESH_CHOICES}
                onChange={setAutoRefresh}
              />
              <button type="button" className="kit-pill-button kit-pill-button--lg" onClick={() => setPricesOpen(true)}>
                <span className="kit-pill-button__icon">
                  <IconDollarSign size={14} />
                </span>
                Model prices
                {unpricedInRange > 0 && <span className={styles.attentionDot} aria-label={`${unpricedInRange} unpriced`} />}
              </button>
              <ShowEmailsToggle />
            </>
          }
        />
        <UsageToolbar
          time={time}
          state={filterState}
          providers={providerItems}
          modelOptions={modelOptions}
          credOptions={credOptions}
          tiers={tierOptions}
          credLabel={(id) => identity(credLabels.get(id) ?? id)}
          onPreviewRange={prefetchRange}
        />
      </div>

      {error && (
        <div className="kit-error-banner" role="alert">
          Could not load usage: {error.message}{' '}
          <button type="button" className={styles.retry} onClick={() => void main.refetch()}>
            Retry
          </button>
        </div>
      )}

      {!res ? (
        main.isError ? null : <UsageSkeleton />
      ) : (
        <UsageBody
          swapKey={display ? `${display.md?.rangeKey ?? ''}|${display.plan.size}|${JSON.stringify(filters)}` : null}
          pending={
            // Only when what's on screen belongs to another scope; background refreshes of the
            // visible range never dim.
            plan.source === 'events'
              ? events.isFetching && (events.isPlaceholderData || !events.data)
              : main.isFetching && main.isPlaceholderData
          }
        >
          <HistoryStartNotice fromMs={allTime ? null : range.fromMs} />

          {summary && (
            <KpiGrid
              summary={summary}
              comparison={res.summary_comparison}
              previous={previous.data?.summary}
              tiers={tiers}
              previousTiers={filters.compare ? previousTiers : undefined}
              rangeMinutes={(dataTo - dataFrom) / 60_000}
              compare={filters.compare}
            />
          )}

          {empty ? (
            <>
              <div data-reveal>
                <EmptyState
                  title="No requests in this range"
                  description={countActiveFilters(filters) > 0 ? 'Nothing matches the current filters.' : 'Try a longer time range.'}
                  action={
                    countActiveFilters(filters) > 0 ? (
                      <button type="button" className="kit-pill-button kit-pill-button--lg" onClick={filterState.clearAll}>
                        Clear filters
                      </button>
                    ) : (
                      <button type="button" className="kit-pill-button kit-pill-button--lg" onClick={() => time.setValue({ preset: 'last_7d' })}>
                        Show last 7 days
                      </button>
                    )
                  }
                />
              </div>
            </>
          ) : (
            <>
              <Panel
                title="Activity"
                subtitle={
                  <>
                    {BUCKET_LABELS[chartPlan.size]} buckets
                    {chartPlan.source === 'events'
                      ? ` · from ${formatInt(events.data?.items.length ?? 0)} raw requests${events.data?.truncated ? ' (newest only)' : ''}, cost estimated in browser`
                      : chartPlan.bucketMs > (chartPlan.source === 'day' ? 86_400_000 : 3_600_000)
                        ? ` · merged from ${chartPlan.source === 'day' ? 'daily' : 'hourly'} data`
                        : ''}
                    {buckets.some((b) => b.anomalies.length) ? ' · dots mark anomalies' : ''}
                  </>
                }
                actions={<SegmentedControl size="sm" value={metric} options={METRICS} onChange={setMetric} ariaLabel="Chart metric" />}
                data-reveal
              >
                {!display ? (
                  <div className={styles.chartLoading}>Loading raw requests…</div>
                ) : (
                  <TimelineChart
                    buckets={buckets}
                    metric={metric}
                    size={chartPlan.size}
                    selected={selectedBucket?.start ?? null}
                    onSelect={setSelected}
                    dimmed={false}
                    footnote="Includes requests without a model price; cost is a lower bound."
                  />
                )}
                {selectedBucket && (
                  <BucketDrilldown
                    bucket={selectedBucket}
                    size={chartPlan.size}
                    data={drill.data}
                    loading={drill.isFetching}
                    error={drill.error}
                    prices={prices.data ?? {}}
                    onClose={() => setSelected(null)}
                    onZoom={() => time.setValue({ preset: 'custom', fromMs: selectedBucket.start, toMs: Math.min(selectedBucket.end, Date.now()) })}
                    requestsHref={`/requests?range=custom&from=${selectedBucket.start}&to=${Math.min(selectedBucket.end, Date.now())}`}
                  />
                )}
              </Panel>

              <ModelsPanel
                rows={tierRows}
                selected={filters.models}
                onToggleModel={(m) => toggleIn('models', m)}
                onOpenPrices={() => setPricesOpen(true)}
                tierScoped={!!filters.tier}
              />

              <div className={styles.twoCol}>
                <ModelSharePanel rows={tierRows} />
                {summary && <TokenCompositionPanel summary={summary} />}
              </div>

              <CredentialsPanel
                rows={credentialRows}
                timeline={res.credential_timeline ?? []}
                fromMs={dataFrom}
                toMs={dataTo}
                granularity={res.granularity}
                selected={filters.creds}
                onToggle={(id) => toggleIn('creds', id)}
                now={now}
                onOpenQuota={(r) => navigate(`/quota-history?cred=${encodeURIComponent(r.auth_file_snapshot || r.id)}`)}
              />

              <HeatmapPanel points={res.heatmap ?? []} hourly={res.hourly_distribution ?? []} />

              {/* Full width: the providers table has too many columns to share a row. */}
              {providerItems.length > 2 && filters.provider === 'all' && (
                <ProvidersPanel rows={credentialRows} onPick={(provider) => update({ provider })} />
              )}

              <AnomaliesPanel
                points={res.anomaly_points ?? []}
                onZoom={(from, to) => time.setValue({ preset: 'custom', fromMs: from, toMs: Math.min(to, Date.now()) })}
              />

              {(res.api_key_stats ?? []).some((r) => r.api_key_hash) && <ApiKeysPanel rows={res.api_key_stats ?? []} now={now} />}
            </>
          )}
        </UsageBody>
      )}

      <ModelPricesSheet open={pricesOpen} onClose={() => setPricesOpen(false)} rangeModels={rangeModels} />
    </div>
  );
}

/**
 * Mounted when the first payload lands so its sections cascade in once. After that, every change of
 * range/bucket/filters replays a short page-style enter on arrival, and a slow fetch rests the
 * content at reduced opacity so the click is acknowledged without a blink on fast ones.
 */
function UsageBody({ children, swapKey, pending }: { children: ReactNode; swapKey: string | null; pending: boolean }) {
  const ref = useRevealGroup<HTMLDivElement>();
  const swapRef = useSwapAnimation<HTMLDivElement>(swapKey);
  return (
    <div ref={ref} className={styles.bodyOuter}>
      <div ref={swapRef} className={`${styles.body} ${pending ? styles.pending : ''}`} aria-busy={pending}>
        {children}
      </div>
    </div>
  );
}
