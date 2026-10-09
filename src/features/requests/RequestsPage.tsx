import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  PageHeader,
  ProviderTabs,
  SearchField,
  SegmentedControl,
  ShowEmailsToggle,
  TimeRangePicker,
  type MetaPart,
  type TabItem,
} from '@/components/kit';
import { EmptyState } from '@/components/ui/EmptyState';
import { useRevealGroup } from '@/hooks/motion';
import { useHeaderRefresh } from '@/hooks/useHeaderRefresh';
import { useSwapAnimation } from '@/hooks/useSwapAnimation';
import { useTimeRange } from '@/hooks/useTimeRange';
import type { EventRow } from '@/lib/api/analytics';
import { useAuthFiles } from '@/lib/api/authFiles';
import { formatCompact, formatDuration, formatInt, formatRatio, maskIdentifier } from '@/lib/format';
import { estimateEventCost, useModelPrices } from '@/lib/pricing';
import { normalizeProvider } from '@/lib/providers';
import {
  BUCKET_LABELS,
  QUICK_PRESETS,
  planBuckets,
  resolveRange,
  type BucketPlan,
  type ResolvedRange,
  type TimeRangeValue,
} from '@/lib/timeRange';
import { useIdentity, usePrivacyStore } from '@/stores/privacy';
import { ActivityChart } from './components/ActivityChart';
import { CredentialsView } from './components/CredentialsView';
import { FailuresView } from './components/FailuresView';
import { FilterBar, type Option } from './components/FilterBar';
import { KpiStrip } from './components/KpiStrip';
import { LiveControls } from './components/LiveControls';
import { ModelsView } from './components/ModelsView';
import { RequestDetailSheet } from './components/RequestDetailSheet';
import { RequestTable, type Density, type RowDecor } from './components/RequestTable';
import { buildAuthMap, credentialLabel, eventKey, eventProvider, maskIps } from './model/events';
import { hasClientRefinement, matchesClient, serverScopeKey, toServerFilters } from './model/filters';
import { bucketPoints, bucketTimeline } from './model/series';
import { DEFAULT_SORT, nextSort, sortRows, type SortKey, type SortState } from './model/sort';
import { useLiveSettings, usePollingLoop } from './useLivePolling';
import { useRequestFilters } from './useRequestFilters';
import {
  REQUESTS_QUERY_ROOT,
  aggregatesKey,
  aggregatesOptions,
  pollActiveQueries,
  sourcesOptions,
  useAggregates,
  useCredentialStats,
  useFailures,
  useFilterSources,
  type AggregatesPayload,
} from './useRequestQueries';
import { prefetchStream, streamScopeKey, useRequestStream, type RequestStream } from './useRequestStream';
import styles from './RequestsPage.module.scss';

type View = 'stream' | 'failures' | 'credentials' | 'models';
const VIEWS: View[] = ['stream', 'failures', 'credentials', 'models'];
const DENSITY_KEY = 'proxy-usage.requests.density';

const TIER_LABELS: Record<string, string> = { normal: 'Normal', fast: 'Fast (priority)', flex: 'Flex' };

const errorText = (error: unknown) => (error instanceof Error ? error.message : error ? String(error) : null);

/** Everything the body renders, captured together so a scope switch swaps it in one piece. */
interface Presented {
  key: string;
  agg: AggregatesPayload | undefined;
  snap: RequestStream['snapshot'];
  plan: BucketPlan;
  range: ResolvedRange;
}

export default function RequestsPage() {
  const time = useTimeRange('today');
  const { range, plan } = time;
  const { filters, update, searchDraft, setSearchDraft, clearAll, view: rawView, setView } = useRequestFilters();
  const view: View = VIEWS.includes(rawView as View) ? (rawView as View) : 'stream';
  const live = useLiveSettings();
  const showEmails = usePrivacyStore((state) => state.showEmails);
  const mask = useIdentity();
  const queryClient = useQueryClient();
  const revealRef = useRevealGroup<HTMLDivElement>();

  const authFiles = useAuthFiles();
  const authMap = useMemo(() => buildAuthMap(authFiles.data), [authFiles.data]);
  const prices = useModelPrices();

  const [density, setDensity] = useState<Density>(() =>
    localStorage.getItem(DENSITY_KEY) === 'compact' ? 'compact' : 'comfortable',
  );
  useEffect(() => localStorage.setItem(DENSITY_KEY, density), [density]);
  const [sort, setSort] = useState<SortState>(DEFAULT_SORT);

  /* ---------- Data ---------- */

  const serverFilters = useMemo(() => toServerFilters(filters), [filters]);
  const serverScope = serverScopeKey(filters);
  const seriesEnabled = plan.source === 'events';
  const scopeKey = streamScopeKey(serverScope, range, seriesEnabled);

  const stream = useRequestStream({
    fromMs: range.fromMs,
    toMs: range.toMs,
    live: range.live,
    scopeKey,
    filters: serverFilters,
    search: filters.search,
    seriesEnabled,
    // Land each poll's batch over most of the interval, so the next poll does not catch it mid-way.
    trickleMs: Math.min(live.intervalMs * 0.8, 4_000),
  });

  const scope = { range, filters: serverFilters, search: filters.search };
  const timeline = seriesEnabled ? null : plan.source === 'day' ? 'day' : 'hour';
  const aggregates = useAggregates({ ...scope, timeline });
  const aggKey = aggregatesKey({ ...scope, timeline });
  const sources = useFilterSources({ range, search: filters.search });
  const failures = useFailures({ ...scope, enabled: view === 'failures' });
  const credentialStats = useCredentialStats({ ...scope, enabled: view === 'credentials' });

  /* ---------- Presentation ---------- */
  // KPIs, chart and table come from two sources (aggregates query, request stream) that land at
  // different moments. The body keeps showing the last complete pair until both belong to the new
  // scope, then swaps in one piece with a page-style enter; switches served from cache are ready
  // on the first render. Each piece always renders with its own range/plan, never re-bucketed.
  const aggReady = (aggregates.data?.key === aggKey && !aggregates.isPlaceholderData) || aggregates.isError;
  const streamReady = (stream.scopeKey === scopeKey && stream.status === 'ready') || stream.status === 'error';
  const ready = aggReady && streamReady;
  const current: Presented = {
    key: `${scopeKey}|${aggKey}|${plan.size}|${JSON.stringify(filters)}`,
    agg: aggregates.data,
    snap: stream.snapshot,
    plan,
    range,
  };
  const [held, setHeld] = useState<Presented | null>(null);
  if (
    ready &&
    (held === null ||
      held.key !== current.key ||
      held.agg !== current.agg ||
      held.snap !== current.snap ||
      held.plan !== current.plan ||
      held.range !== current.range)
  ) {
    setHeld(current);
  }
  const presented = ready || held === null ? current : held;
  const switching = !ready && held !== null;
  const shown = presented.snap;
  const shownAgg = presented.agg?.res;

  /* ---------- Prefetch ---------- */
  // The Manager aggregates raw rows per query (0.1–0.6s), so likely next ranges are warmed ahead of
  // the click: on hover/focus of a preset, and every quick preset once the page is idle.
  const { bucket } = time;
  const prefetchRange = useCallback(
    (next: TimeRangeValue) => {
      const r = resolveRange(next, Date.now());
      const p = planBuckets(r, bucket);
      const series = p.source === 'events';
      const tl = series ? null : p.source === 'day' ? 'day' : 'hour';
      void queryClient.prefetchQuery(aggregatesOptions({ range: r, filters: serverFilters, search: filters.search, timeline: tl }));
      void queryClient.prefetchQuery(sourcesOptions({ range: r, search: filters.search }));
      prefetchStream({
        fromMs: r.fromMs,
        toMs: r.toMs,
        live: r.live,
        scopeKey: streamScopeKey(serverScope, r, series),
        filters: serverFilters,
        search: filters.search,
        seriesEnabled: series,
      });
    },
    [queryClient, bucket, serverFilters, filters.search, serverScope],
  );
  const idle = ready && !aggregates.isFetching && stream.status === 'ready' && !stream.reloading;
  const warmFor = `${serverScope}|${bucket}`;
  const warmedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!idle || warmedRef.current === warmFor) return;
    const id = window.setTimeout(() => {
      warmedRef.current = warmFor;
      QUICK_PRESETS.forEach((preset) => prefetchRange({ preset }));
    }, 700);
    return () => window.clearTimeout(id);
  }, [idle, warmFor, prefetchRange]);

  /* ---------- Live polling ---------- */

  const { tick } = time;
  const { tail, refresh: refreshStream } = stream;
  // Keys are per range identity, so a poll refetches the visible queries in place (their windows
  // re-anchor at fetch time) and tails the stream; tick() only moves the labels and chart window.
  const onTick = useCallback(() => {
    tick();
    void tail();
    void pollActiveQueries(queryClient);
  }, [tick, tail, queryClient]);
  const polling = usePollingLoop(live.live && range.live, live.intervalMs, onTick);

  const onRefresh = useCallback(async () => {
    tick();
    await Promise.all([refreshStream(), queryClient.invalidateQueries({ queryKey: [REQUESTS_QUERY_ROOT] })]);
  }, [tick, refreshStream, queryClient]);
  useHeaderRefresh(onRefresh);

  /* ---------- Presentation helpers ---------- */

  const decor = useMemo<RowDecor>(() => {
    const show = (v: string) => (showEmails ? v : maskIdentifier(v));
    const costs = new WeakMap<EventRow, number | null>();
    const book = prices.data;
    return {
      credential: (event) => ({ label: show(credentialLabel(event, authMap)), provider: eventProvider(event) }),
      cost: (event) => {
        if (!book) return null;
        if (!costs.has(event)) costs.set(event, estimateEventCost(book, event));
        return costs.get(event) ?? null;
      },
      scrub: (text) => (showEmails ? text : maskIps(maskIdentifier(text))),
    };
  }, [authMap, prices.data, showEmails]);

  const labelOf = useCallback(
    (row: Parameters<typeof credentialLabel>[0]) => {
      const label = credentialLabel(row, authMap);
      return showEmails ? label : maskIdentifier(label);
    },
    [authMap, showEmails],
  );

  const clientRefined = hasClientRefinement(filters);
  const filteredRows = useMemo(
    () => (clientRefined ? shown.rows.filter((row) => matchesClient(row, filters)) : shown.rows),
    [clientRefined, shown.rows, filters],
  );
  const sortedRows = useMemo(() => sortRows(filteredRows, sort, decor.cost), [filteredRows, sort, decor]);
  const pendingCount = useMemo(
    () => (clientRefined ? shown.pending.filter((row) => matchesClient(row, filters)).length : shown.pending.length),
    [clientRefined, shown.pending, filters],
  );

  // Raw-event buckets follow the (ticking) range window; server timelines use the window they were
  // fetched for. Either way the data is bucketed with the plan it was loaded for.
  const { plan: shownPlan, agg: shownPayload, range: shownRange } = presented;
  const buckets = useMemo(() => {
    if (shownPlan.source === 'events') {
      if (shown.status !== 'ready' && shown.series.length === 0) return null;
      return bucketPoints(shown.series, shownRange.fromMs, shownRange.toMs, shownPlan.size);
    }
    if (!shownPayload || shownPayload.timeline === null) return null;
    return bucketTimeline(shownPayload.res.timeline ?? [], shownPayload.fromMs, shownPayload.toMs, shownPlan.size);
  }, [shownPlan, shownPayload, shown.status, shown.series, shownRange.fromMs, shownRange.toMs]);

  /* ---------- Filter sources ---------- */

  const channelRows = useMemo(
    () => (sources.data?.channel_share ?? []).filter((row) => row.auth_index && row.auth_index !== '-').sort((a, b) => b.calls - a.calls),
    [sources.data],
  );

  const providerItems = useMemo<TabItem[]>(() => {
    const counts = new Map<string, number>();
    let total = 0;
    for (const row of sources.data?.channel_share ?? []) {
      total += row.calls;
      const provider = normalizeProvider(row.auth_provider_snapshot);
      // Rows without a provider snapshot cannot be filtered by provider server-side; count them only in All.
      if (provider) counts.set(provider, (counts.get(provider) ?? 0) + row.calls);
    }
    if (filters.provider !== 'all' && !counts.has(filters.provider)) counts.set(filters.provider, 0);
    const items = Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([id, count]) => ({ id, count }));
    return [{ id: 'all', label: 'All', count: total }, ...items];
  }, [sources.data, filters.provider]);

  const modelOptions = useMemo<Option[]>(
    () =>
      (sources.data?.model_stats ?? [])
        .slice()
        .sort((a, b) => b.calls - a.calls)
        .map((row) => ({ value: row.model, label: `${row.model} · ${formatCompact(row.calls)}` })),
    [sources.data],
  );

  const credentialOptions = useMemo<Option[]>(
    () => channelRows.map((row) => ({ value: row.auth_index, label: `${labelOf(row)} · ${formatCompact(row.calls)}` })),
    [channelRows, labelOf],
  );

  const credentialName = useCallback(
    (id: string) => {
      const row = channelRows.find((r) => r.auth_index === id);
      return labelOf(row ?? { auth_index: id });
    },
    [channelRows, labelOf],
  );

  const tierOptions = useMemo<Option[]>(() => {
    const tiers = new Set(['normal', 'fast', 'flex']);
    for (const row of shownAgg?.model_tier_stats ?? []) if (row.service_tier) tiers.add(row.service_tier);
    return Array.from(tiers).map((tier) => ({ value: tier, label: TIER_LABELS[tier] ?? tier }));
  }, [shownAgg]);

  /* ---------- Detail sheet ---------- */

  const [sheet, setSheet] = useState<{ event: EventRow; source: 'stream' | 'failures' } | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const failureEvents = failures.data ? (failures.data.events?.items ?? []) : undefined;
  const navList = sheet?.source === 'failures' ? (failureEvents ?? []) : sortedRows;
  const sheetKey = sheet ? eventKey(sheet.event) : null;
  const navIndex = sheetKey ? navList.findIndex((row) => eventKey(row) === sheetKey) : -1;

  const openStreamEvent = useCallback((event: EventRow) => {
    setSheet({ event, source: 'stream' });
    setSheetOpen(true);
  }, []);
  const openFailureEvent = useCallback((event: EventRow) => {
    setSheet({ event, source: 'failures' });
    setSheetOpen(true);
  }, []);
  const onSort = useCallback((key: SortKey) => setSort((current) => nextSort(current, key)), []);
  const { loadOlder } = stream;
  const onLoadOlder = useCallback(() => void loadOlder(), [loadOlder]);
  const step = (delta: number) => {
    const next = navIndex >= 0 ? navList[navIndex + delta] : undefined;
    if (next) setSheet((current) => (current ? { ...current, event: next } : current));
  };
  const siblings = useMemo(() => {
    if (!sheet) return [];
    return shown.rows.filter((row) => row.auth_index === sheet.event.auth_index).slice(0, 32);
  }, [sheet, shown.rows]);

  /* ---------- Header ---------- */

  const summary = shownAgg?.summary;
  const failRate = summary && summary.total_calls > 0 ? summary.failure_calls / summary.total_calls : 0;
  const statusText = !range.live
    ? 'fixed range'
    : !live.live
      ? 'paused'
      : polling.hidden
        ? 'paused · tab hidden'
        : 'live';
  const meta: MetaPart[] = [
    {
      text: (
        <span className={styles.liveMeta}>
          <span key={polling.beat} className={`${styles.liveDot} ${polling.running ? styles.liveDotOn : ''}`} aria-hidden="true" />
          {statusText}
        </span>
      ),
      tone: polling.running ? 'live' : 'muted',
    },
  ];
  if (summary) {
    meta.push({ text: `${formatInt(summary.total_calls)} requests` });
    meta.push({ text: `${formatRatio(failRate, failRate > 0 && failRate < 0.1 ? 1 : 0)} failed`, tone: failRate >= 0.1 ? 'attention' : 'default' });
    meta.push({ text: `p95 ${formatDuration(summary.p95_latency_ms)}` });
  } else {
    meta.push({ text: 'loading…', tone: 'muted' });
  }
  if (stream.tailError) meta.push({ text: 'reconnecting…', tone: 'attention' });

  /* ---------- Render ---------- */

  const anyFilter = clientRefined || Object.keys(serverFilters).length > 0 || !!filters.search;
  const coverage = shownAgg?.coverage;
  const streamError = stream.status === 'error' ? stream.error : null;
  const aggError = errorText(aggregates.error);

  const viewOptions = [
    { value: 'stream' as const, label: 'Stream' },
    {
      value: 'failures' as const,
      label: (
        <span className={styles.viewLabel}>
          Failures
          {summary && summary.failure_calls > 0 && <span className={styles.viewCount}>{formatCompact(summary.failure_calls)}</span>}
        </span>
      ),
    },
    { value: 'credentials' as const, label: 'Credentials' },
    { value: 'models' as const, label: 'Models' },
  ];

  const emptyNode = (
    <EmptyState
      title="No requests in this window"
      description={
        anyFilter
          ? 'Nothing matches the current filters. Widen the range or clear filters.'
          : 'Requests appear here within a second of passing through the proxy.'
      }
      action={
        anyFilter ? (
          <button type="button" className="kit-pill-button" onClick={clearAll}>
            Clear filters
          </button>
        ) : undefined
      }
    />
  );

  return (
    <div className={`kit-page ${styles.page}`} ref={revealRef}>
      <PageHeader
        title="Request Monitor"
        meta={meta}
        actions={
          <>
            <ShowEmailsToggle />
            <LiveControls
              live={live.live}
              running={polling.running}
              beat={polling.beat}
              fixedRange={!range.live}
              intervalMs={live.intervalMs}
              onLiveChange={live.setLive}
              onIntervalChange={live.setIntervalMs}
            />
          </>
        }
      />

      <div className={styles.controls} data-reveal>
        <div className={styles.toolbar}>
          <TimeRangePicker state={time} showBucket onPreview={prefetchRange} />
          <SearchField
            value={searchDraft}
            onChange={setSearchDraft}
            placeholder="Search model, request id, credential, error, IP…"
            className={styles.search}
          />
        </div>
        <ProviderTabs items={providerItems} active={filters.provider} onChange={(provider) => update({ provider })} ariaLabel="Provider" />
        <FilterBar
          filters={filters}
          onChange={update}
          onClearAll={clearAll}
          modelOptions={modelOptions}
          credentialOptions={credentialOptions}
          tierOptions={tierOptions}
          credentialName={credentialName}
        />
      </div>

      {streamError && (
        <div className="kit-error-banner" role="alert">
          Could not load requests: {streamError}{' '}
          <button type="button" className={styles.retry} onClick={() => void stream.reload()}>
            Retry
          </button>
        </div>
      )}
      {aggError && !streamError && (
        <div className="kit-error-banner" role="alert">
          Could not load summary: {aggError}
        </div>
      )}
      {coverage && coverage.raw_deleted_event_count > 0 && (
        <div className={styles.notice}>
          {formatInt(coverage.raw_deleted_event_count)} archived requests in this range are no longer available individually;
          totals still include them.
        </div>
      )}

      <SwapBody swapKey={presented.key} pending={switching}>
        <div data-reveal>
          <KpiStrip
            summary={summary}
            comparison={shownAgg?.summary_comparison}
            tiers={shownAgg?.model_tier_stats}
            rows={shown.rows}
            spanMs={shownPayload ? shownPayload.toMs - shownPayload.fromMs : shownRange.toMs - shownRange.fromMs}
            loading={aggregates.isFetching}
          />
        </div>

        <section className={`kit-panel ${styles.chartPanel}`} data-reveal>
          <div className={styles.panelHead}>
            <div>
              <h2 className="kit-panel__title">Activity</h2>
              <p className="kit-panel__subtitle">
                {BUCKET_LABELS[shownPlan.size]} buckets · {shownRange.label}
                {shown.seriesPartial && shownPlan.source === 'events' ? ' · newest 10,000 requests' : ''}
              </p>
            </div>
          </div>
          <div className={styles.chartBody}>
            <ActivityChart buckets={buckets} size={shownPlan.size} />
          </div>
        </section>

        <section className={`kit-panel ${styles.streamPanel}`} data-reveal>
          <div className={styles.panelHead}>
            <SegmentedControl<View> value={view} options={viewOptions} onChange={setView} ariaLabel="View" size="sm" />
            {view === 'stream' && (
              <div className={styles.streamActions}>
                {clientRefined && <span className={styles.refineNote}>{formatInt(filteredRows.length)} match in loaded rows</span>}
                {sort.key !== 'time' || sort.dir !== 'desc' ? (
                  <button type="button" className={styles.linkButton} onClick={() => setSort(DEFAULT_SORT)}>
                    Reset sort
                  </button>
                ) : null}
                <SegmentedControl<Density>
                  size="sm"
                  ariaLabel="Row density"
                  value={density}
                  onChange={setDensity}
                  options={[
                    { value: 'comfortable', label: 'Comfortable' },
                    { value: 'compact', label: 'Compact' },
                  ]}
                />
              </div>
            )}
          </div>

          {view === 'stream' && (
            <RequestTable
              rows={sortedRows}
              fresh={shown.fresh}
              selectedKey={sheetOpen && sheet?.source === 'stream' ? sheetKey : null}
              decor={decor}
              density={density}
              sort={sort}
              onSort={onSort}
              onOpen={openStreamEvent}
              pendingCount={pendingCount}
              onFlushPending={stream.flushPending}
              onAtTopChange={stream.setAtTop}
              loading={shown.status === 'loading'}
              reloading={shown.reloading}
              canLoadOlder={stream.canLoadOlder}
              loadingOlder={stream.loadingOlder}
              onLoadOlder={onLoadOlder}
              loadedCount={shown.rows.length}
              totalCount={summary?.total_calls ?? null}
              empty={emptyNode}
            />
          )}
          {view === 'failures' && (
            <FailuresView
              events={failureEvents}
              totalFailures={failures.data?.events?.total_count ?? 0}
              sources={failures.data?.failure_sources}
              loading={failures.isFetching}
              error={errorText(failures.error)}
              decor={decor}
              labelOf={labelOf}
              onOpen={openFailureEvent}
            />
          )}
          {view === 'credentials' && (
            <div className={styles.viewPad}>
              <CredentialsView
                rows={credentialStats.data?.credential_stats ?? (credentialStats.data ? [] : undefined)}
                loading={credentialStats.isFetching}
                error={errorText(credentialStats.error)}
                recent={shown.rows}
                labelOf={labelOf}
                onFilter={(credential) => {
                  update({ credential });
                  setView('stream');
                }}
              />
            </div>
          )}
          {view === 'models' && (
            <div className={styles.viewPad}>
              <ModelsView
                rows={shownAgg ? (shownAgg.model_tier_stats ?? []) : undefined}
                onFilter={(model) => {
                  update({ model });
                  setView('stream');
                }}
              />
            </div>
          )}
        </section>
      </SwapBody>

      <RequestDetailSheet
        open={sheetOpen}
        event={sheet?.event ?? null}
        index={navIndex}
        count={navList.length}
        onClose={() => setSheetOpen(false)}
        onPrev={() => step(-1)}
        onNext={() => step(1)}
        decor={decor}
        prices={prices.data}
        mask={mask}
        showEmails={showEmails}
        siblings={siblings}
      />
    </div>
  );
}

/**
 * KPIs, chart and table. Each change of what is presented (range, bucket, filters, search) replays
 * the page-transition enter, and a slow switch rests the previous content at reduced opacity after
 * a beat so the click is acknowledged without a blink on cached ones.
 */
function SwapBody({ swapKey, pending, children }: { swapKey: string; pending: boolean; children: ReactNode }) {
  const ref = useSwapAnimation<HTMLDivElement>(swapKey);
  return (
    <div ref={ref} className={`${styles.body} ${pending ? styles.pending : ''}`} aria-busy={pending}>
      {children}
    </div>
  );
}
