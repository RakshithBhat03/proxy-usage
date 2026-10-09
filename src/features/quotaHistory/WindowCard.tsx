import type { ReactNode } from 'react';
import { IconCalendar, IconClock } from '@/components/ui/extraIcons';
import { IconEyeOff, IconTimer } from '@/components/ui/icons';
import { formatCost, formatInt, formatRatio, formatStamp, formatTokens } from '@/lib/format';
import {
  estimateWindowUsage,
  forecastWindow,
  projectUsageAtReset,
  toMetrics,
  type CapacityForecast,
  type QuotaForecast,
  type UsageMetrics,
} from '@/lib/quotaHistory/forecast';
import type { WindowModelScope } from '@/lib/quotaHistory/sources';
import type { HistoryWindow, WindowKind, WindowUsage } from '@/lib/quotaHistory/types';
import { formatIn, formatPeriod, formatRate, formatSpanLength, formatUsed, formatWhen, usedColor } from './format';
import styles from './QuotaHistoryPage.module.scss';

export interface WindowGroup {
  windowId: string;
  label: string;
  kind: WindowKind;
  current: HistoryWindow | null;
  /** The newest ended window that actually saw usage. */
  previous: HistoryWindow | null;
  /** The ended window that got the most out of the limit: most tokens, else highest used %. */
  best: HistoryWindow | null;
}

const hadUsage = (w: HistoryWindow, usage: Record<string, WindowUsage>) => (usage[w.uid]?.requests ?? 0) > 0 || (w.peakUsed ?? 0) > 0;

function bestWindow(ended: HistoryWindow[], usage: Record<string, WindowUsage>): HistoryWindow | null {
  const tokens = (w: HistoryWindow) => (usage[w.uid]?.matched ? usage[w.uid].tokens : 0);
  const byTokens = ended.reduce<HistoryWindow | null>((top, w) => (tokens(w) > (top ? tokens(top) : 0) ? w : top), null);
  return byTokens ?? ended.reduce<HistoryWindow | null>((top, w) => ((w.peakUsed ?? 0) > (top?.peakUsed ?? 0) ? w : top), null);
}

export function groupWindows(windows: HistoryWindow[], usage: Record<string, WindowUsage>): WindowGroup[] {
  const map = new Map<string, HistoryWindow[]>();
  for (const w of windows) map.set(w.windowId, [...(map.get(w.windowId) ?? []), w]);
  const rank = (kind: WindowKind) => (kind === 'five-hour' ? 0 : kind === 'weekly' ? 1 : 2);
  return [...map.values()]
    .map((list) => {
      const newestFirst = [...list].sort((a, b) => b.startMs - a.startMs);
      const ended = newestFirst.filter((w) => w.status === 'past' && hadUsage(w, usage));
      return {
        windowId: list[0].windowId,
        label: list[0].label,
        kind: list[0].kind,
        current: newestFirst.find((w) => w.status === 'current') ?? null,
        previous: ended[0] ?? null,
        best: bestWindow(ended, usage),
      };
    })
    .sort((a, b) => rank(a.kind) - rank(b.kind) || a.label.localeCompare(b.label));
}

/* ---------- Estimate (shared with the page summary) ---------- */

export interface WindowEstimate {
  forecast: QuotaForecast | null;
  atReset: UsageMetrics | null;
  /** What 100% of the window is worth, from the used % (or the previous window's actuals). */
  capacity: CapacityForecast | null;
  /** Used % at reset at the average pace; 100 once exhausted. */
  projected: number | null;
}

export function estimateGroup(group: WindowGroup, usage: Record<string, WindowUsage>, usageAtReading: Record<string, WindowUsage>, now: number): WindowEstimate | null {
  const { current, previous } = group;
  if (!current) return null;
  const cur = usage[current.uid];
  // Only usage counted up to the quota reading may be scaled by its percentage.
  const atReading =
    usageAtReading[current.uid] ??
    (cur && cur.lastSeenMs !== null && current.lastObservedAtMs !== null && cur.lastSeenMs <= current.lastObservedAtMs ? cur : undefined);
  const soFar = toMetrics(cur);
  const raw = estimateWindowUsage({
    usedPercent: current.lastUsed,
    current: toMetrics(atReading),
    previous: toMetrics(previous ? usage[previous.uid] : undefined),
  });
  const capacity = raw && soFar && (raw.requests < soFar.requests || raw.tokens < soFar.tokens || raw.cost + 1e-9 < soFar.cost) ? null : raw;
  const forecast = forecastWindow(current, now);
  return {
    forecast,
    atReset: soFar ? projectUsageAtReset(current, soFar, now, capacity) : null,
    capacity,
    projected: forecast?.exhausted ? 100 : (forecast?.average?.projectedAtReset ?? null),
  };
}

/* ---------- Pieces ---------- */

const KIND_ICON: Record<WindowKind, ReactNode> = {
  'five-hour': <IconTimer size={15} />,
  weekly: <IconCalendar size={15} />,
  other: <IconClock size={15} />,
};

const projectedText = (p: number | null) => (p === null ? '--' : p > 100 ? '>100%' : `~${formatUsed(p)}`);

function Stat({ label, value, hint, color }: { label: string; value: string; hint?: string; color?: string }) {
  return (
    <div className={styles.stat}>
      <span className={styles.statLabel}>{label}</span>
      <span className={styles.statValue} style={color ? { color } : undefined}>
        {value}
      </span>
      {hint && <span className={styles.statHint}>{hint}</span>}
    </div>
  );
}

function MiniBar({ used, color }: { used: number | null; color?: string }) {
  return (
    <span className={styles.miniBar}>
      <span style={{ width: `${Math.min(100, Math.max(0, used ?? 0))}%`, background: color ?? usedColor(used) }} />
    </span>
  );
}

/** A finished window's actuals: the peak used % and what it served. */
function EndedRow({
  name,
  window,
  usage,
  blank,
  title,
}: {
  name: string;
  window: HistoryWindow | null;
  usage: Record<string, WindowUsage>;
  blank: string;
  title?: string;
}) {
  const u = window ? usage[window.uid] : undefined;
  const period = window ? formatPeriod(window.startMs, window.endMs) : undefined;
  return (
    <div className={styles.compareRow} role="row" title={title}>
      <span className={styles.rowName}>
        {name}
        <small title={period}>{window ? `${period}${window.endedEarly ? ' · early' : ''}` : 'none with usage'}</small>
      </span>
      <span className={styles.usedCell}>
        <MiniBar used={window?.peakUsed ?? null} />
        <b style={{ color: window?.peakUsed == null ? undefined : usedColor(window.peakUsed) }}>{window ? formatUsed(window.peakUsed) : '--'}</b>
      </span>
      <b>{u?.matched ? formatInt(u.requests) : window ? blank : '--'}</b>
      <b>{u?.matched ? formatTokens(u.tokens) : window ? blank : '--'}</b>
      <b>{u?.matched ? formatCost(u.cost) : window ? blank : '--'}</b>
      <b>{u?.matched && u.requests > 0 ? formatRatio(u.successCalls / u.requests) : '--'}</b>
    </div>
  );
}

/* ---------- Card ---------- */

interface WindowCardProps {
  group: WindowGroup;
  estimate: WindowEstimate | null;
  scope: WindowModelScope;
  usage: Record<string, WindowUsage>;
  now: number;
  usageLoading: boolean;
  onHide: () => void;
}

export function WindowCard({ group, estimate, scope, usage, now, usageLoading, onHide }: WindowCardProps) {
  const { current, previous } = group;
  const used = current?.lastUsed ?? null;
  const forecast = estimate?.forecast ?? null;
  const projected = estimate?.projected ?? null;
  const avg = forecast?.average ?? null;
  const recent = forecast?.recent ?? null;
  const cur = current ? usage[current.uid] : undefined;
  const capacity = estimate?.capacity ?? null;
  const unknownScope = scope.kind === 'unknown';
  const blank = unknownScope ? 'n/a' : usageLoading ? '…' : '--';

  let runsOut: { value: string; hint?: string; color?: string } = { value: '--' };
  if (forecast?.exhausted) runsOut = { value: 'Exhausted', hint: `back ${formatIn(current?.endMs ?? now, now)}`, color: 'var(--viz-failure)' };
  else if (avg?.runsOutAtMs)
    runsOut = { value: formatWhen(avg.runsOutAtMs, now), hint: `${formatSpanLength((current?.endMs ?? now) - avg.runsOutAtMs)} before reset`, color: 'var(--viz-failure)' };
  else if (avg && avg.projectedAtReset >= 95) runsOut = { value: 'Close', hint: 'lands at the limit', color: 'var(--quota-medium-color)' };
  else if (avg) runsOut = { value: 'No', hint: 'not before the reset', color: 'var(--viz-success)' };

  return (
    <article className={styles.card}>
      <header className={styles.cardHead}>
        <span className={styles.kindIcon} data-kind={group.kind}>
          {KIND_ICON[group.kind]}
        </span>
        <strong className={styles.cardTitle}>{group.label}</strong>
        {current ? (
          <span className={styles.reset} title={new Date(current.endMs).toLocaleString()}>
            <b>resets {formatIn(current.endMs, now)}</b> · {formatStamp(current.endMs)}
          </span>
        ) : (
          <span className={styles.reset}>idle</span>
        )}
        <button type="button" className={styles.rowButton} onClick={onHide} title={`Hide ${group.label} on every account of this provider`} aria-label={`Hide ${group.label}`}>
          <IconEyeOff size={14} />
        </button>
      </header>

      <div className={styles.hero}>
        <div className={styles.heroMain}>
          <div className={styles.heroFigure}>
            <span className={styles.heroValue} style={{ color: used === null ? undefined : usedColor(used) }}>
              {current ? formatUsed(used) : '--'}
            </span>
            <span className={styles.heroUnit}>{current ? `used · ${formatUsed(used === null ? null : Math.max(0, 100 - used))} left` : 'no active window'}</span>
          </div>
          <div className="kit-meter" style={{ height: 5 }} role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={used ?? undefined} aria-label="Used">
            {projected !== null && used !== null && projected > used && (
              <div className={styles.meterProjected} style={{ width: `${Math.min(100, projected)}%`, color: usedColor(projected) }} />
            )}
            <div className={`kit-meter__fill ${styles.meterFill}`} style={{ width: `${Math.min(100, used ?? 0)}%`, background: usedColor(used) }} />
          </div>
          <span className={styles.heroMeta}>
            {current ? formatPeriod(current.startMs, current.endMs) : previous ? `last window ended ${formatIn(previous.endMs, now)}` : 'starts with the next request'}
          </span>
        </div>
      </div>

      {current && (
        <div className={styles.stats}>
          <Stat
            label="At reset"
            value={projectedText(projected)}
            hint={forecast?.lowConfidence ? 'rough · early reading' : 'at average pace'}
            color={projected === null ? undefined : usedColor(projected)}
          />
          <Stat label="Runs out" value={runsOut.value} hint={runsOut.hint} color={runsOut.color} />
          <Stat
            label="Burn rate"
            value={avg ? formatRate(avg.ratePerHour) : '--'}
            hint={recent ? `last ${formatSpanLength(recent.spanMs)}: ${formatRate(recent.ratePerHour)}` : 'since window start'}
          />
          <Stat
            label="Full window"
            value={estimate?.capacity ? formatCost(estimate.capacity.cost) : '--'}
            hint={
              !estimate?.capacity
                ? 'needs usage + reading'
                : estimate.capacity.basis === 'quota'
                  ? `${formatInt(estimate.capacity.requests)} req · ${formatTokens(estimate.capacity.tokens)}`
                  : 'previous window total'
            }
          />
        </div>
      )}

      <div className={styles.compare} role="table" aria-label={`${group.label}: all-time high, previous, current and full window`}>
        <div className={`${styles.compareRow} ${styles.compareHead}`} role="row">
          <span />
          <span>Used</span>
          <span>Requests</span>
          <span>Tokens</span>
          <span>Cost</span>
          <span>Success</span>
        </div>

        {group.best && (
          <EndedRow
            name="All-time high"
            window={group.best}
            usage={usage}
            blank={blank}
            title={`Ended ${group.label} window with the ${usage[group.best.uid]?.matched ? 'most tokens' : 'highest used %'} in the loaded history`}
          />
        )}
        <EndedRow name="Previous" window={previous} usage={usage} blank={blank} />

        {current && (
          <>
            <div className={`${styles.compareRow} ${styles.compareCurrent}`} role="row">
              <span className={styles.rowName}>
                Current
                <small>so far</small>
              </span>
              <span className={styles.usedCell}>
                <MiniBar used={used} />
                <b style={{ color: used === null ? undefined : usedColor(used) }}>{formatUsed(used)}</b>
              </span>
              <b>{cur?.matched ? formatInt(cur.requests) : blank}</b>
              <b>{cur?.matched ? formatTokens(cur.tokens) : blank}</b>
              <b>{cur?.matched ? formatCost(cur.cost) : blank}</b>
              <b>{cur?.matched && cur.requests > 0 ? formatRatio(cur.successCalls / cur.requests) : '--'}</b>
            </div>
            <div className={`${styles.compareRow} ${styles.compareForecast}`} role="row">
              <span className={styles.rowName}>
                Full window
                <small>{!capacity ? 'needs usage + reading' : capacity.basis === 'quota' ? 'est. at 100% used' : 'previous window total'}</small>
              </span>
              <span className={styles.usedCell}>
                <MiniBar used={capacity ? 100 : null} color="var(--text-tertiary)" />
                <b className={styles.muted}>{capacity ? '100%' : '--'}</b>
              </span>
              <b>{capacity ? `~${formatInt(capacity.requests)}` : blank}</b>
              <b>{capacity ? `~${formatTokens(capacity.tokens)}` : blank}</b>
              <b>{capacity ? `~${formatCost(capacity.cost)}` : blank}</b>
              <b className={styles.muted}>--</b>
            </div>
          </>
        )}
      </div>

      {unknownScope && (
        <p className={styles.scopeNote}>
          This limit only meters some models and the provider does not say which, so requests, tokens and cost are not shown.
        </p>
      )}

      <footer className={styles.cardFoot}>
        <span className={styles.scopeChip} title={scope.kind === 'models' ? scope.models.join(', ') : undefined}>
          {scope.kind === 'all' ? 'all models' : scope.kind === 'models' ? (scope.models.length <= 2 ? scope.models.join(', ') : `${scope.models.length} models`) : 'models unknown'}
        </span>
        {current?.lastObservedAtMs != null
          ? `reading ${now - current.lastObservedAtMs < 60_000 ? 'just now' : formatIn(current.lastObservedAtMs, now)}`
          : previous?.lastObservedAtMs != null
            ? `last reading ${formatStamp(previous.lastObservedAtMs)}`
            : 'no reading yet'}
        {current ? ` · ${current.points.length} reading${current.points.length === 1 ? '' : 's'} this window` : ''}
      </footer>
    </article>
  );
}
