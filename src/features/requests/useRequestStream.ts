import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  LOCAL_TIME_ZONE,
  queryAnalytics,
  type AnalyticsFilters,
  type AnalyticsResponse,
  type EventRow,
} from '@/lib/api/analytics';
import { rangeKey, type ResolvedRange } from '@/lib/timeRange';
import { appendOlder, eventKey, mergeNewest } from './model/events';
import { toSeriesPoint, type SeriesPoint } from './model/series';

/** Rows shown per page / revealed per "load older". */
const PAGE = 250;
/** One-shot window load when the chart buckets raw events (sub-hour buckets). */
const SERIES_LIMIT = 10_000;
/** Live merges keep at most this many rows while the user sits at the top of the stream. */
const LIVE_CAP = 2_000;
/** Absolute ceiling, even when the user keeps loading older pages. */
const HARD_CAP = 6_000;
const TAIL_LIMIT = 500;
/** Rolling windows end "now"; a little headroom tolerates clock skew between browser and server. */
const LIVE_SKEW_MS = 5 * 60_000;
/** How long a row keeps its arrival class; outlasts the longest highlight (failures, 2.2s). */
const FRESH_MS = 2_400;
/** Polls that bring more rows than this skip the trickle and land at once (bursts, catch-up). */
const TRICKLE_MAX_ROWS = 40;
/** Minimum spacing between trickled releases, so each arrival reads as its own event. */
const TRICKLE_MIN_GAP_MS = 120;
/** Scopes remembered for instant switching (range × filters × search). */
const SCOPE_CACHE_SIZE = 8;
/** Older snapshots are not worth showing: the background catch-up would replace most of it. */
const SCOPE_CACHE_MAX_AGE_MS = 10 * 60_000;
/** A prefetch is skipped when the scope was loaded this recently. */
const PREFETCH_FRESH_MS = 30_000;
/** A restored fixed-range scope older than this is reloaded quietly in the background. */
const FIXED_REVALIDATE_MS = 60_000;

export interface StreamOptions {
  fromMs: number;
  toMs: number;
  /** Rolling range: end follows the clock and rows older than `fromMs` are pruned. */
  live: boolean;
  /** Changes whenever the server would return a different row set; triggers a full reload. */
  scopeKey: string;
  filters: AnalyticsFilters;
  search: string;
  /** Also keep a compact point for every request in the window (sub-hour chart buckets). */
  seriesEnabled: boolean;
  /**
   * Window over which one poll's arrivals are released (about the poll interval). A poll returns
   * everything recorded since the last one in a single batch; replaying it at the pace the
   * requests actually happened makes rows land one by one instead of in a clump.
   */
  trickleMs?: number;
}

/** A polled row waiting for its turn to land on the table. */
interface Arrival {
  row: EventRow;
  due: number;
}

interface Cursor {
  beforeMs: number;
  beforeId: number;
}

interface StreamState {
  /** The scope these rows belong to ('' before the first load lands). */
  scopeKey: string;
  rows: EventRow[];
  /** Arrivals held back while the user is scrolled into the stream (shown as "N new requests"). */
  pending: EventRow[];
  /** Polled rows scheduled to land one by one (see `trickleMs`). */
  incoming: Arrival[];
  /** Older rows already fetched (window load) but not yet revealed. */
  buffer: EventRow[];
  series: SeriesPoint[];
  seriesPartial: boolean;
  cursor: Cursor | null;
  serverHasMore: boolean;
  totalCount: number;
  status: 'loading' | 'ready' | 'error';
  /** A new scope is loading while the previous rows stay visible (dimmed). */
  reloading: boolean;
  error: string | null;
  tailError: string | null;
  loadingOlder: boolean;
  /** Arrival time per row key, for the one-shot highlight. */
  fresh: ReadonlyMap<string, number>;
  updatedAt: number;
}

const EMPTY_FRESH: ReadonlyMap<string, number> = new Map();

/** Adds arrivals and drops highlights whose animation has long finished. */
function withFresh(current: ReadonlyMap<string, number>, added: EventRow[]): ReadonlyMap<string, number> {
  const now = Date.now();
  const next = new Map<string, number>();
  for (const [key, at] of current) if (now - at < FRESH_MS) next.set(key, at);
  for (const row of added) next.set(eventKey(row), now);
  return next;
}

const INITIAL: StreamState = {
  scopeKey: '',
  rows: [],
  pending: [],
  incoming: [],
  buffer: [],
  series: [],
  seriesPartial: false,
  cursor: null,
  serverHasMore: false,
  totalCount: 0,
  status: 'loading',
  reloading: false,
  error: null,
  tailError: null,
  loadingOlder: false,
  fresh: EMPTY_FRESH,
  updatedAt: 0,
};

/**
 * Spreads a poll's new rows over `windowMs`, keeping their real relative timing (oldest first, so
 * the newest lands last and ends on top). Large batches are not worth staging and land at once.
 */
function schedule(added: EventRow[], windowMs: number): Arrival[] {
  const now = Date.now();
  if (added.length <= 1 || windowMs <= 0 || added.length > TRICKLE_MAX_ROWS) {
    return added.map((row) => ({ row, due: now }));
  }
  const ordered = [...added].sort((a, b) => a.timestamp_ms - b.timestamp_ms);
  const first = ordered[0].timestamp_ms;
  const span = ordered[ordered.length - 1].timestamp_ms - first;
  let last = -Infinity;
  return ordered.map((row, i) => {
    const share = span > 0 ? (row.timestamp_ms - first) / span : i / (ordered.length - 1);
    const offset = Math.min(windowMs, Math.max(share * windowMs, last + TRICKLE_MIN_GAP_MS));
    last = offset;
    return { row, due: now + offset };
  });
}

/**
 * Lands rows on the table (at the top, with the arrival highlight unless `quiet`) and keeps the
 * live window capped.
 */
function landAtTop(s: StreamState, rows: EventRow[], incoming: EventRow[], quiet: boolean) {
  const merged = mergeNewest(rows, incoming);
  let next = merged.rows;
  let { buffer, cursor, serverHasMore } = s;
  const fresh = merged.added.length > 0 && !quiet ? withFresh(s.fresh, merged.added) : s.fresh;
  if (next.length > LIVE_CAP) {
    const last = next[LIVE_CAP - 1];
    next = next.slice(0, LIVE_CAP);
    buffer = [];
    // Re-read from the last kept row; duplicates at the same millisecond are deduped.
    cursor = { beforeMs: last.timestamp_ms + 1, beforeId: 0 };
    serverHasMore = true;
  }
  return { rows: next, buffer, cursor, serverHasMore, fresh };
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));
const isAbort = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';

function cursorOf(res: AnalyticsResponse): Cursor | null {
  const events = res.events;
  return events?.has_more ? { beforeMs: events.next_before_ms, beforeId: events.next_before_id } : null;
}

function fetchPage(
  o: StreamOptions,
  page: { limit: number; before_ms?: number; before_id?: number },
  signal: AbortSignal | undefined,
  fromOverride?: number,
) {
  const from = fromOverride ?? o.fromMs;
  const to = Math.max(o.live ? Date.now() + LIVE_SKEW_MS : o.toMs, from + 1);
  return queryAnalytics(
    {
      from_ms: from,
      to_ms: to,
      time_zone: LOCAL_TIME_ZONE,
      search_query: o.search || undefined,
      filters: o.filters,
      include: { events_page: page },
    },
    signal,
  );
}

/** Stable identity of a stream scope: server-side filters + search, range identity, row/series mode. */
export function streamScopeKey(serverScope: string, range: ResolvedRange, seriesEnabled: boolean): string {
  return [serverScope, rangeKey(range), seriesEnabled ? 'series' : 'rows'].join('|');
}

/** What is remembered per scope: enough to repaint the stream instantly and resume tailing. */
interface Snapshot {
  rows: EventRow[];
  buffer: EventRow[];
  series: SeriesPoint[];
  seriesPartial: boolean;
  cursor: Cursor | null;
  serverHasMore: boolean;
  totalCount: number;
  /** Newest timestamp seen, where the background tail resumes. */
  newest: number;
  savedAt: number;
}

/*
 * Module-level LRU so it survives route changes. Rows are shared by reference with the state that
 * produced them (both are treated as immutable), so remembering a scope costs no copy.
 */
const scopeCache = new Map<string, Snapshot>();
const inflight = new Map<string, Promise<Snapshot>>();
/** The scope the mounted stream is showing; prefetch never overwrites it with a shorter snapshot. */
let activeScope: string | null = null;

function cacheGet(key: string): Snapshot | undefined {
  const hit = scopeCache.get(key);
  if (!hit) return undefined;
  scopeCache.delete(key);
  if (Date.now() - hit.savedAt > SCOPE_CACHE_MAX_AGE_MS) return undefined;
  scopeCache.set(key, hit);
  return hit;
}

function cachePut(key: string, snapshot: Snapshot) {
  scopeCache.delete(key);
  scopeCache.set(key, snapshot);
  while (scopeCache.size > SCOPE_CACHE_SIZE) {
    const oldest = scopeCache.keys().next().value;
    if (oldest === undefined) break;
    scopeCache.delete(oldest);
  }
}

function newestOf(state: Pick<StreamState, 'rows' | 'pending' | 'series'>): number {
  return Math.max(state.rows[0]?.timestamp_ms ?? 0, state.pending[0]?.timestamp_ms ?? 0, state.series[0]?.ts ?? 0);
}

/** The first page of a scope (or the whole window when the chart buckets raw events). */
async function fetchSnapshot(o: StreamOptions, signal?: AbortSignal): Promise<Snapshot> {
  const res = await fetchPage(o, { limit: o.seriesEnabled ? SERIES_LIMIT : PAGE }, signal);
  const items = res.events?.items ?? [];
  return {
    rows: items.slice(0, PAGE),
    buffer: items.slice(PAGE),
    series: o.seriesEnabled ? items.map((item) => toSeriesPoint(item, eventKey(item))) : [],
    seriesPartial: o.seriesEnabled && !!res.events?.has_more,
    cursor: cursorOf(res),
    serverHasMore: !!res.events?.has_more,
    totalCount: res.events?.total_count ?? items.length,
    newest: items[0]?.timestamp_ms ?? 0,
    savedAt: Date.now(),
  };
}

/**
 * Warms a scope before it is shown (hovered or quick preset), so selecting it paints from memory.
 * Concurrent requests for one scope share a fetch, and the mounted stream reuses it on click.
 */
export function prefetchStream(o: StreamOptions): void {
  const key = o.scopeKey;
  if (key === activeScope || inflight.has(key)) return;
  const hit = scopeCache.get(key);
  if (hit && Date.now() - hit.savedAt < PREFETCH_FRESH_MS) return;
  const request = fetchSnapshot(o).finally(() => inflight.delete(key));
  inflight.set(key, request);
  request
    .then((snapshot) => {
      if (key === activeScope) return;
      const current = scopeCache.get(key);
      if (!current || current.savedAt < snapshot.savedAt) cachePut(key, snapshot);
    })
    .catch(() => undefined);
}

function stateFrom(snapshot: Snapshot, scopeKey: string, cutoff: number): StreamState {
  const keep = (row: EventRow) => row.timestamp_ms >= cutoff;
  return {
    ...INITIAL,
    scopeKey,
    rows: snapshot.rows.filter(keep),
    buffer: snapshot.buffer.filter(keep),
    series: snapshot.series.filter((p) => p.ts >= cutoff),
    seriesPartial: snapshot.seriesPartial,
    cursor: snapshot.cursor,
    serverHasMore: snapshot.serverHasMore,
    totalCount: snapshot.totalCount,
    status: 'ready',
    updatedAt: snapshot.savedAt,
  };
}

/**
 * The live request stream. There is no push channel, so this:
 *  1. loads the newest page (or the whole window when the chart needs raw events),
 *  2. on every poll fetches only rows at/after the newest one seen (`from_ms` is inclusive) and
 *     merges them on top, deduped by `event_hash`,
 *  3. pages older rows with the keyset cursor (`next_before_ms/id`).
 * While the user is scrolled down, arrivals queue in `pending` instead of shifting the table.
 */
export function useRequestStream(options: StreamOptions) {
  const [state, setState] = useState<StreamState>(INITIAL);
  const optsRef = useRef(options);
  const stateRef = useRef(state);
  const genRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const newestRef = useRef(0);
  const tailBusy = useRef(false);
  const atTopRef = useRef(true);

  // Layout effects so the scope switch below (also a layout effect) already sees the new options.
  useLayoutEffect(() => {
    optsRef.current = options;
  });
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const commit = useCallback((next: StreamState) => {
    stateRef.current = next;
    setState(next);
  }, []);

  /**
   * Loads the first page of the current scope. `background` keeps what is on screen untouched (no
   * dim, no skeleton) until the replacement lands, for revalidating a scope restored from memory.
   */
  const loadInitial = useCallback(
    async (background = false) => {
      const o = optsRef.current;
      const gen = ++genRef.current;
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      tailBusy.current = false;
      if (!background) {
        setState((s) =>
          s.status === 'ready' && s.rows.length > 0
            ? { ...s, reloading: true, error: null }
            : { ...s, status: 'loading', error: null },
        );
      }
      try {
        // A prefetch of this scope may already be on the wire (hover, then click): share it.
        const shared = inflight.get(o.scopeKey);
        const snapshot = shared ? await shared : await fetchSnapshot(o, controller.signal);
        if (gen !== genRef.current) return;
        newestRef.current = snapshot.newest;
        commit(stateFrom(snapshot, o.scopeKey, Number.NEGATIVE_INFINITY));
      } catch (error) {
        if (isAbort(error) || gen !== genRef.current) return;
        if (background) setState((s) => ({ ...s, tailError: messageOf(error) }));
        else setState((s) => ({ ...s, status: 'error', reloading: false, error: messageOf(error) }));
      }
    },
    [commit],
  );

  /**
   * Fetches rows newer than the newest one seen and merges them on top. `quiet` (catching up a
   * scope restored from memory) merges in place without the arrival highlight or the pill: those
   * rows are not news to the viewer, just the part of the window they have not seen yet.
   */
  const tail = useCallback(async (quiet = false) => {
    const o = optsRef.current;
    if (tailBusy.current || stateRef.current.status !== 'ready' || stateRef.current.reloading) return;
    const gen = genRef.current;
    const signal = abortRef.current?.signal ?? new AbortController().signal;
    tailBusy.current = true;
    try {
      const from = Math.max(o.fromMs, newestRef.current || o.fromMs);
      const res = await fetchPage(o, { limit: TAIL_LIMIT }, signal, from);
      if (gen !== genRef.current) return;
      if (res.events?.has_more) {
        // More arrived than one tail page holds: reload rather than leave a gap (quietly when
        // catching up a restored scope, whose rows stay on screen until the reload lands).
        tailBusy.current = false;
        void loadInitial(quiet);
        return;
      }
      const items = res.events?.items ?? [];
      if (items[0]) newestRef.current = Math.max(newestRef.current, items[0].timestamp_ms);
      const atTop = quiet || atTopRef.current;
      const cutoff = o.live ? o.fromMs : Number.NEGATIVE_INFINITY;
      setState((s) => {
        const known = new Set<string>();
        for (const row of s.rows) known.add(eventKey(row));
        for (const row of s.pending) known.add(eventKey(row));
        for (const a of s.incoming) known.add(eventKey(a.row));
        const added = items.filter((item) => !known.has(eventKey(item)));
        const keep = (row: EventRow) => row.timestamp_ms >= cutoff;
        const series = o.seriesEnabled
          ? [...added.map((item) => toSeriesPoint(item, eventKey(item))), ...s.series].filter((p) => p.ts >= cutoff)
          : s.series;
        const rows = s.rows.filter(keep);
        let pending = s.pending.filter(keep);
        const buffer = s.buffer.filter(keep);
        let incoming = s.incoming.filter((a) => keep(a.row));
        let landed = { rows, buffer, cursor: s.cursor, serverHasMore: s.serverHasMore, fresh: s.fresh };
        if (atTop) {
          // Rows still queued from the previous poll land now, ahead of this poll's batch.
          const now = [...pending, ...incoming.map((a) => a.row)];
          if (quiet) now.push(...added);
          landed = landAtTop({ ...s, buffer }, rows, now, quiet);
          pending = [];
          incoming = quiet ? [] : schedule(added, o.trickleMs ?? 0);
        } else if (added.length > 0) {
          pending = mergeNewest(pending, added).rows.slice(0, LIVE_CAP);
        }
        const unchanged =
          added.length === 0 &&
          landed.rows.length === s.rows.length &&
          pending.length === s.pending.length &&
          incoming.length === s.incoming.length &&
          series.length === s.series.length;
        // Nothing new: keep the same state object so an empty poll re-renders nothing.
        if (unchanged && s.tailError === null) return s;
        return {
          ...s,
          ...landed,
          pending,
          incoming,
          series,
          totalCount: Math.max(s.totalCount, landed.rows.length + incoming.length),
          tailError: null,
          updatedAt: Date.now(),
        };
      });
      // An empty poll leaves the state (and so the remembered snapshot) untouched; mark the
      // snapshot as current anyway so switching back to this scope stays instant.
      const remembered = scopeCache.get(o.scopeKey);
      if (remembered) scopeCache.set(o.scopeKey, { ...remembered, savedAt: Date.now() });
    } catch (error) {
      if (isAbort(error) || gen !== genRef.current) return;
      setState((s) => ({ ...s, tailError: messageOf(error) }));
    } finally {
      if (gen === genRef.current) tailBusy.current = false;
    }
  }, [loadInitial]);

  const loadOlder = useCallback(async () => {
    const s = stateRef.current;
    if (s.loadingOlder || s.reloading || s.status !== 'ready' || s.rows.length >= HARD_CAP) return;
    if (s.buffer.length > 0) {
      setState((cur) => ({
        ...cur,
        rows: appendOlder(cur.rows, cur.buffer.slice(0, PAGE)),
        buffer: cur.buffer.slice(PAGE),
      }));
      return;
    }
    if (!s.serverHasMore || !s.cursor) return;
    const o = optsRef.current;
    const gen = genRef.current;
    const signal = abortRef.current?.signal ?? new AbortController().signal;
    setState((cur) => ({ ...cur, loadingOlder: true }));
    try {
      const res = await fetchPage(o, { limit: PAGE, before_ms: s.cursor.beforeMs, before_id: s.cursor.beforeId }, signal);
      if (gen !== genRef.current) return;
      const items = res.events?.items ?? [];
      setState((cur) => ({
        ...cur,
        rows: appendOlder(cur.rows, items),
        cursor: cursorOf(res),
        serverHasMore: !!res.events?.has_more,
        loadingOlder: false,
      }));
    } catch (error) {
      if (isAbort(error) || gen !== genRef.current) return;
      setState((cur) => ({ ...cur, loadingOlder: false, tailError: messageOf(error) }));
    }
  }, []);

  const flushPending = useCallback(() => {
    setState((s) => {
      if (s.pending.length === 0 && s.incoming.length === 0) return s;
      const landed = landAtTop(s, s.rows, [...s.pending, ...s.incoming.map((a) => a.row)], false);
      return { ...s, ...landed, pending: [], incoming: [] };
    });
  }, []);

  // Trickle: land queued arrivals when they fall due. Off the top of the stream they join the
  // "N new requests" pill instead, like any other arrival.
  useEffect(() => {
    if (state.incoming.length === 0) return;
    const nextDue = Math.min(...state.incoming.map((a) => a.due));
    const id = window.setTimeout(() => {
      setState((s) => {
        const now = Date.now() + 16;
        const due = s.incoming.filter((a) => a.due <= now).map((a) => a.row);
        if (due.length === 0) return s;
        const incoming = s.incoming.filter((a) => a.due > now);
        if (!atTopRef.current) return { ...s, incoming, pending: mergeNewest(s.pending, due).rows.slice(0, LIVE_CAP) };
        return { ...s, ...landAtTop(s, s.rows, due, false), incoming };
      });
    }, Math.max(0, nextDue - Date.now()));
    return () => window.clearTimeout(id);
  }, [state.incoming]);

  /** The table reports whether its scroller is at the top; arrivals only merge in place there. */
  const setAtTop = useCallback(
    (atTop: boolean) => {
      const was = atTopRef.current;
      atTopRef.current = atTop;
      if (atTop && !was) flushPending();
    },
    [flushPending],
  );

  const refresh = useCallback(() => (optsRef.current.live ? tail() : loadInitial()), [loadInitial, tail]);

  /*
   * Scope change (range, server filters, search). A scope seen recently repaints from memory before
   * the browser paints (layout effect), then catches up in the background: live windows tail from
   * the newest remembered row, fixed windows reload quietly once the snapshot is a minute old. A new
   * scope loads with the previous rows kept on screen.
   */
  useLayoutEffect(() => {
    const o = optsRef.current;
    activeScope = o.scopeKey;
    const cached = cacheGet(o.scopeKey);
    if (!cached) {
      newestRef.current = 0;
      void loadInitial();
      return;
    }
    genRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = new AbortController();
    tailBusy.current = false;
    newestRef.current = cached.newest;
    commit(stateFrom(cached, o.scopeKey, o.live ? o.fromMs : Number.NEGATIVE_INFINITY));
    const age = Date.now() - cached.savedAt;
    if (o.live) {
      if (age > 1_000) void tail(true);
    } else if (age > FIXED_REVALIDATE_MS) {
      void loadInitial(true);
    }
  }, [options.scopeKey, loadInitial, tail, commit]);

  useEffect(
    () => () => {
      abortRef.current?.abort();
      activeScope = null;
    },
    [],
  );

  // Remember every settled state of the scope, so switching back to it is instant.
  useEffect(() => {
    if (state.status !== 'ready' || state.reloading || !state.scopeKey) return;
    cachePut(state.scopeKey, {
      // Rows held behind the "N new" pill or still queued to land are folded in; a restored scope
      // starts at the top.
      rows:
        state.pending.length + state.incoming.length > 0
          ? mergeNewest(state.rows, [...state.pending, ...state.incoming.map((a) => a.row)]).rows
          : state.rows,
      buffer: state.buffer,
      series: state.series,
      seriesPartial: state.seriesPartial,
      cursor: state.cursor,
      serverHasMore: state.serverHasMore,
      totalCount: state.totalCount,
      newest: Math.max(newestOf(state), ...state.incoming.map((a) => a.row.timestamp_ms)),
      savedAt: state.updatedAt,
    });
  }, [state]);

  // Drop the arrival highlight so remounted rows (sort/filter changes) do not flash again.
  useEffect(() => {
    if (state.fresh.size === 0) return;
    const id = window.setTimeout(() => setState((s) => ({ ...s, fresh: withFresh(s.fresh, []) })), FRESH_MS + 100);
    return () => window.clearTimeout(id);
  }, [state.fresh]);

  const canLoadOlder = state.rows.length < HARD_CAP && (state.buffer.length > 0 || (state.serverHasMore && !!state.cursor));

  return {
    ...state,
    /** The state object itself: stable between renders unless something changed. */
    snapshot: state,
    canLoadOlder,
    loadOlder,
    tail,
    refresh,
    reload: loadInitial,
    flushPending,
    setAtTop,
  };
}

export type RequestStream = ReturnType<typeof useRequestStream>;
