import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { Skeleton } from '@/components/ui/Skeleton';
import { IconChevronDown, IconChevronUp, IconLoader2 } from '@/components/ui/icons';
import type { EventRow } from '@/lib/api/analytics';
import { formatClock, formatCompact, formatCost, formatDuration, formatInt, formatRelative, formatStamp } from '@/lib/format';
import { eventOutputTps } from '@/lib/pricing';
import { cacheReadTokens, eventKey, freshInputTokens } from '../model/events';
import type { SortKey, SortState } from '../model/sort';
import { CredentialCell, EffortBadge, StatusBadge, StreamGlyph, TierBadge } from './bits';
import styles from './RequestTable.module.scss';

export type Density = 'comfortable' | 'compact';

export interface RowDecor {
  credential: (event: EventRow) => { label: string; provider: string };
  cost: (event: EventRow) => number | null;
  /** Masks IPs/emails in failure text unless "show emails" is on. */
  scrub: (text: string) => string;
}

const COLUMNS: Array<{ key: SortKey | null; label: string; align?: 'right'; title?: string }> = [
  { key: 'time', label: 'Time' },
  { key: 'status', label: 'Status' },
  { key: 'model', label: 'Model' },
  { key: null, label: 'Credential' },
  { key: null, label: 'Endpoint' },
  { key: 'input', label: 'Input', align: 'right', title: 'Total input tokens (includes cache read and cache write)' },
  { key: 'cache', label: 'Cache rd', align: 'right', title: 'Cache read tokens' },
  { key: 'cacheWrite', label: 'Cache wr', align: 'right', title: 'Cache write (creation) tokens' },
  { key: 'output', label: 'Output', align: 'right' },
  { key: 'latency', label: 'Latency', align: 'right' },
  { key: 'ttft', label: 'TTFT', align: 'right', title: 'Time to first token' },
  { key: 'tps', label: 'TPS', align: 'right', title: 'Output tokens / total latency' },
  { key: 'cost', label: 'Cost', align: 'right', title: 'Estimated from the model price book' },
];

const RENDER_STEP = 150;
/** Slide that eases the rows below a new arrival down, instead of jumping them a row height. */
const SLIDE_MS = 420;
const SLIDE_EASING = 'cubic-bezier(0.22, 1, 0.36, 1)';

function latencyTone(ms: number | null) {
  if (!ms) return '';
  if (ms >= 30_000) return styles.toneBad;
  if (ms >= 15_000) return styles.toneWarn;
  return '';
}

function startOfToday() {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

interface RowProps {
  event: EventRow;
  fresh: boolean;
  selected: boolean;
  decor: RowDecor;
  todayMs: number;
  onOpen: (event: EventRow) => void;
}

const RequestRow = memo(function RequestRow({ event, fresh, selected, decor, todayMs, onOpen }: RowProps) {
  const { label, provider } = decor.credential(event);
  const cost = decor.cost(event);
  const tps = eventOutputTps(event);
  const [method, ...pathParts] = (event.endpoint || '-').split(' ');
  const path = pathParts.join(' ') || event.path || '';
  const failText = event.failed && event.fail_summary ? decor.scrub(event.fail_summary).slice(0, 280) : '';
  const cls = [
    styles.row,
    fresh ? (event.failed ? styles.freshFail : styles.fresh) : '',
    selected ? styles.selected : '',
    event.failed ? styles.failedRow : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <tr
      className={cls}
      onClick={() => onOpen(event)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen(event);
        }
      }}
      tabIndex={0}
      aria-selected={selected}
      data-key={eventKey(event)}
    >
      <td
        className={styles.time}
        onMouseEnter={(e: MouseEvent<HTMLTableCellElement>) => {
          e.currentTarget.title = `${formatStamp(event.timestamp_ms)} · ${formatRelative(event.timestamp_ms)}`;
        }}
      >
        {event.timestamp_ms < todayMs && <span className={styles.day}>{formatStamp(event.timestamp_ms).slice(0, 5)}</span>}
        {formatClock(event.timestamp_ms)}
      </td>
      <td title={failText || undefined}>
        <StatusBadge event={event} />
      </td>
      <td className={styles.modelCell}>
        <span className={styles.model}>
          <span className={styles.modelName} title={event.resolved_model && event.resolved_model !== event.model ? `${event.model} → ${event.resolved_model}` : event.model}>
            {event.model || '-'}
          </span>
          {event.stream && <StreamGlyph className={styles.stream} />}
          <EffortBadge effort={event.reasoning_effort} />
          <TierBadge tier={event.service_tier} />
        </span>
      </td>
      <td className={styles.credCell}>
        <CredentialCell provider={provider} label={label} />
      </td>
      <td className={styles.endpoint} title={event.endpoint}>
        <span className={styles.method}>{method}</span>
        {path}
      </td>
      <td className={styles.num} title={`fresh ${formatInt(freshInputTokens(event))} · cache read ${formatInt(cacheReadTokens(event))} · cache write ${formatInt(event.cache_creation_tokens)}`}>
        {formatCompact(event.input_tokens)}
      </td>
      <td className={`${styles.num} ${styles.muted}`}>{cacheReadTokens(event) > 0 ? formatCompact(cacheReadTokens(event)) : '–'}</td>
      <td className={`${styles.num} ${styles.muted}`}>{event.cache_creation_tokens > 0 ? formatCompact(event.cache_creation_tokens) : '–'}</td>
      <td className={styles.num}>{formatCompact(event.output_tokens)}</td>
      <td className={`${styles.num} ${latencyTone(event.latency_ms)}`}>{formatDuration(event.latency_ms)}</td>
      <td className={`${styles.num} ${styles.muted}`}>{event.ttft_ms ? formatDuration(event.ttft_ms) : '–'}</td>
      <td className={`${styles.num} ${styles.muted}`}>{tps !== null ? (tps >= 100 ? Math.round(tps) : tps.toFixed(1)) : '–'}</td>
      <td className={styles.num}>{cost !== null ? formatCost(cost) : '–'}</td>
    </tr>
  );
});

interface RequestTableProps {
  rows: EventRow[];
  fresh: ReadonlyMap<string, number>;
  selectedKey: string | null;
  decor: RowDecor;
  density: Density;
  sort: SortState;
  onSort: (key: SortKey) => void;
  onOpen: (event: EventRow) => void;
  pendingCount: number;
  onFlushPending: () => void;
  onAtTopChange: (atTop: boolean) => void;
  loading: boolean;
  reloading: boolean;
  canLoadOlder: boolean;
  loadingOlder: boolean;
  onLoadOlder: () => void;
  loadedCount: number;
  totalCount: number | null;
  empty: ReactNode;
}

export function RequestTable({
  rows,
  fresh,
  selectedKey,
  decor,
  density,
  sort,
  onSort,
  onOpen,
  pendingCount,
  onFlushPending,
  onAtTopChange,
  loading,
  reloading,
  canLoadOlder,
  loadingOlder,
  onLoadOlder,
  loadedCount,
  totalCount,
  empty,
}: RequestTableProps) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLTableSectionElement>(null);
  const slideRef = useRef<Animation | null>(null);
  const [renderCount, setRenderCount] = useState(RENDER_STEP);
  const [todayMs] = useState(startOfToday);
  const atTopRef = useRef(true);

  const visible = rows.slice(0, renderCount);
  const topKey = visible.length > 0 ? eventKey(visible[0]) : null;
  const prevTopRef = useRef(topKey);

  // While this table is not mounted (another view is open) arrivals should merge straight in.
  useEffect(() => {
    onAtTopChange(true);
    return () => onAtTopChange(true);
  }, [onAtTopChange]);

  const onScroll = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const atTop = el.scrollTop < 12;
    if (atTop !== atTopRef.current) {
      atTopRef.current = atTop;
      onAtTopChange(atTop);
    }
  }, [onAtTopChange]);

  const advance = useCallback(() => {
    if (renderCount < rows.length) setRenderCount((n) => n + RENDER_STEP);
    else if (canLoadOlder && !loadingOlder) onLoadOlder();
  }, [renderCount, rows.length, canLoadOlder, loadingOlder, onLoadOlder]);

  // Infinite scroll: reveal more rendered rows first, then fetch older pages. The observer reads
  // `advance` through a ref, so it is created once instead of on every arrival.
  const advanceRef = useRef(advance);
  useEffect(() => {
    advanceRef.current = advance;
  }, [advance]);
  useEffect(() => {
    const root = scrollerRef.current;
    const target = sentinelRef.current;
    if (!root || !target || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && advanceRef.current(), {
      root,
      rootMargin: '0px 0px 320px 0px',
    });
    observer.observe(target);
    return () => observer.disconnect();
  }, []);

  /*
   * Arrivals at the top (FLIP on the whole body): before paint, measure how far the previous top
   * row was pushed down, start <tbody> that far up so nothing appears to move, then ease it back to
   * rest. One transform animation on one element, run by the compositor; the new row slides out
   * from under the sticky header. A landing mid-slide continues from where the body is. Skipped when
   * scrolled into the table (the user is reading) and for anything that is not an insertion
   * (sorting, filtering, a new scope).
   */
  useLayoutEffect(() => {
    const prev = prevTopRef.current;
    prevTopRef.current = topKey;
    const body = bodyRef.current;
    const scroller = scrollerRef.current;
    if (!prev || !topKey || prev === topKey || !body || !scroller || scroller.scrollTop >= 12) return;
    const index = visible.findIndex((event) => eventKey(event) === prev);
    if (index <= 0 || !visible.slice(0, index).every((event) => fresh.has(eventKey(event)))) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const prevRow = body.rows[index];
    const first = body.rows[0];
    if (!prevRow || !first) return;
    let from = first.offsetTop - prevRow.offsetTop;
    const running = slideRef.current;
    if (running?.playState === 'running') {
      from += new DOMMatrixReadOnly(getComputedStyle(body).transform).m42;
      running.cancel();
    }
    slideRef.current = body.animate([{ transform: `translateY(${from}px)` }, { transform: 'translateY(0)' }], {
      duration: SLIDE_MS,
      easing: SLIDE_EASING,
    });
    // Keyed on the top row alone: it only has work to do when a new row takes the top.
  }, [topKey]);

  // Keep the row being inspected in the sheet visible while stepping with ↑/↓.
  useEffect(() => {
    if (!selectedKey || typeof CSS === 'undefined') return;
    const row = scrollerRef.current?.querySelector(`tr[data-key="${CSS.escape(selectedKey)}"]`);
    row?.scrollIntoView({ block: 'nearest' });
  }, [selectedKey]);

  const jumpToTop = () => {
    scrollerRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
    onFlushPending();
  };

  const showSkeleton = loading && rows.length === 0;

  return (
    <div className={`${styles.wrap} ${density === 'compact' ? styles.compact : ''} ${reloading ? styles.reloading : ''}`}>
      {pendingCount > 0 && (
        <button type="button" className={styles.newPill} onClick={jumpToTop}>
          <IconChevronUp size={13} />
          {formatInt(pendingCount)} new request{pendingCount === 1 ? '' : 's'}
        </button>
      )}
      <div className={styles.scroller} ref={scrollerRef} onScroll={onScroll}>
        <table className={`kit-table ${styles.table}`}>
          <thead>
            <tr>
              {COLUMNS.map((col) => {
                const active = col.key !== null && sort.key === col.key;
                return (
                  <th
                    key={col.label}
                    data-align={col.align}
                    data-sortable={col.key ? 'true' : undefined}
                    aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined}
                    title={col.title}
                    onClick={col.key ? () => onSort(col.key as SortKey) : undefined}
                    className={active ? styles.sorted : undefined}
                  >
                    <span className={styles.th}>
                      {col.label}
                      {active && (sort.dir === 'asc' ? <IconChevronUp size={11} /> : <IconChevronDown size={11} />)}
                    </span>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody ref={bodyRef}>
            {showSkeleton
              ? Array.from({ length: 12 }, (_, i) => (
                  <tr key={i} className={styles.skeletonRow}>
                    {COLUMNS.map((col, j) => (
                      <td key={col.label}>
                        <Skeleton width={j === 2 ? 140 : j === 3 ? 120 : j === 4 ? 110 : 44} height={11} rounded={4} />
                      </td>
                    ))}
                  </tr>
                ))
              : visible.map((event) => {
                  const key = eventKey(event);
                  return (
                    <RequestRow
                      key={key}
                      event={event}
                      fresh={fresh.has(key)}
                      selected={key === selectedKey}
                      decor={decor}
                      todayMs={todayMs}
                      onOpen={onOpen}
                    />
                  );
                })}
          </tbody>
        </table>
        {!showSkeleton && rows.length === 0 && <div className={styles.empty}>{empty}</div>}
        <div ref={sentinelRef} className={styles.sentinel} aria-hidden="true" />
        {!showSkeleton && rows.length > 0 && (
          <div className={styles.footer}>
            <span className={styles.footerCount}>
              {formatInt(Math.min(visible.length, rows.length))} shown · {formatInt(loadedCount)} loaded
              {totalCount !== null && <> of {formatInt(totalCount)}</>}
            </span>
            {renderCount < rows.length || canLoadOlder ? (
              <button type="button" className={styles.loadOlder} onClick={advance} disabled={loadingOlder}>
                {loadingOlder ? <IconLoader2 size={13} className="kit-spin" /> : <IconChevronDown size={13} />}
                Load older
              </button>
            ) : (
              <span className={styles.footerEnd}>Start of window</span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
