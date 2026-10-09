import { useId, useMemo, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { formatCompact, formatCost, formatDuration, formatInt, formatRatio, formatTokens } from '@/lib/format';
import type { ConcreteBucket } from '@/lib/timeRange';
import { ANOMALY_LABELS, anomalyChange, formatAnomalyChange } from '../model/derive';
import type { ChartMetric } from '../model/filters';
import type { ChartBucket } from '../model/timeline';
import { niceMax } from './axis';
import { buildSmoothLinePath, segmentsOf } from './curve';
import { COLORS } from './palette';
import { useElementWidth } from './useElementWidth';
import { useTweenedFrame, type TweenFrame } from './useTween';
import styles from './TimelineChart.module.scss';

interface Series {
  key: string;
  label: string;
  color: string;
  value: (b: ChartBucket) => number | null;
  dashed?: boolean;
  /** Legend total; omitted for averages that cannot be summed. */
  total?: string;
}

interface MetricSpec {
  kind: 'bars' | 'lines';
  series: Series[];
  axis: (v: number) => string;
  /** Fixed axis max (percentages). */
  fixedMax?: number;
}

const pad = (n: number) => String(n).padStart(2, '0');
const dayLabel = (ms: number) => {
  const d = new Date(ms);
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;
};
const timeLabel = (ms: number) => {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function bucketTitle(start: number, end: number, size: ConcreteBucket): string {
  if (size === '1w') return `${dayLabel(start)} – ${dayLabel(end - 1)}`;
  if (size === '1d') return `${WEEKDAYS[new Date(start).getDay()]} ${dayLabel(start)}`;
  return `${dayLabel(start)} ${timeLabel(start)} – ${timeLabel(end)}`;
}

const sum = (buckets: ChartBucket[], pick: (b: ChartBucket) => number) => buckets.reduce((s, b) => s + pick(b), 0);

function specFor(metric: ChartMetric, buckets: ChartBucket[]): MetricSpec {
  switch (metric) {
    case 'requests':
      return {
        kind: 'bars',
        axis: formatCompact,
        series: [
          { key: 'success', label: 'Success', color: COLORS.success, value: (b) => b.success, total: formatInt(sum(buckets, (b) => b.success)) },
          { key: 'failure', label: 'Failed', color: COLORS.failure, value: (b) => b.failure, total: formatInt(sum(buckets, (b) => b.failure)) },
        ],
      };
    case 'tokens':
      return {
        kind: 'bars',
        axis: formatTokens,
        series: [
          { key: 'cacheRead', label: 'Cache read', color: COLORS.cacheRead, value: (b) => b.cacheRead, total: formatTokens(sum(buckets, (b) => b.cacheRead)) },
          { key: 'cacheWrite', label: 'Cache write', color: COLORS.cacheWrite, value: (b) => b.cacheWrite, total: formatTokens(sum(buckets, (b) => b.cacheWrite)) },
          { key: 'fresh', label: 'Fresh input', color: COLORS.fresh, value: (b) => b.freshInput, total: formatTokens(sum(buckets, (b) => b.freshInput)) },
          { key: 'output', label: 'Output', color: COLORS.output, value: (b) => b.outputTokens, total: formatTokens(sum(buckets, (b) => b.outputTokens)) },
        ],
      };
    case 'cost':
      return {
        kind: 'bars',
        axis: (v) => (v >= 1000 ? `$${formatCompact(v)}` : v >= 10 ? `$${Math.round(v)}` : `$${v.toFixed(v >= 1 ? 1 : 2)}`),
        series: [{ key: 'cost', label: 'Cost', color: COLORS.cost, value: (b) => b.cost, total: formatCost(sum(buckets, (b) => b.cost)) }],
      };
    case 'latency':
      return {
        kind: 'lines',
        axis: (v) => (v >= 1000 ? `${Math.round(v / 100) / 10}s` : `${Math.round(v)}ms`),
        series: [
          { key: 'avg', label: 'Avg latency', color: COLORS.line, value: (b) => (b.calls > 0 ? b.avgLatency : null) },
          { key: 'p95', label: 'P95 latency', color: COLORS.lineMuted, value: (b) => (b.calls > 0 ? b.p95Latency : null), dashed: true },
        ],
      };
    case 'cache':
      return {
        kind: 'lines',
        axis: (v) => `${Math.round(v * 100)}%`,
        fixedMax: 1,
        series: [{ key: 'hit', label: 'Cache hit rate', color: COLORS.line, value: (b) => (b.calls > 0 ? b.cacheHitRate : null) }],
      };
  }
}

const HEIGHT = 236;
const M = { top: 22, right: 6, bottom: 34, left: 46 };
const TICKS = 4;

/** Bar path with a rounded data end (top) and a square baseline end. */
function barPath(x: number, y: number, w: number, h: number, round: boolean): string {
  if (h <= 0) return '';
  const r = round ? Math.min(4, w / 2, h) : 0;
  return `M${x} ${y + h}V${y + r}${r ? `Q${x} ${y} ${x + r} ${y}` : ''}H${x + w - r}${r ? `Q${x + w} ${y} ${x + w} ${y + r}` : ''}V${y + h}Z`;
}

const MIN_SEGMENT = 3;

/**
 * Stacked segment heights with a visibility floor. Cache reads are often ~97% of tokens, which
 * would leave cache write / fresh / output as sub-pixel slivers; each non-zero segment gets at
 * least MIN_SEGMENT px, borrowed from the tallest segment so the column total stays true.
 */
function segmentHeights(raw: number[]): number[] {
  const total = raw.reduce((s, h) => s + h, 0);
  const small = raw.filter((h) => h > 0 && h < MIN_SEGMENT);
  if (small.length === 0) return raw;
  const tallest = raw.indexOf(Math.max(...raw));
  const borrow = small.reduce((s, h) => s + (MIN_SEGMENT - h), 0);
  // Only borrow when the tallest segment can spare it and still dominate visibly.
  if (raw[tallest] - borrow < MIN_SEGMENT * 2 || total < raw.filter((h) => h > 0).length * MIN_SEGMENT * 2) return raw;
  return raw.map((h, i) => (i === tallest ? h - borrow : h > 0 && h < MIN_SEGMENT ? MIN_SEGMENT : h));
}

interface TimelineChartProps {
  buckets: ChartBucket[];
  metric: ChartMetric;
  size: ConcreteBucket;
  selected: number | null;
  onSelect: (bucket: ChartBucket | null) => void;
  dimmed?: boolean;
  /** Extra tooltip line, e.g. why cost may be partial. */
  footnote?: ReactNode;
}

/**
 * Signature timeline: hand-built SVG following the CPAMC dashboard conventions (2px surface gaps,
 * 4px rounded data ends, recessive grid, direct peak label, glass tooltip that slides between
 * columns). Geometry is normalized to the axis and tweened, so refreshes and metric switches morph.
 */
export function TimelineChart({ buckets, metric, size, selected, onSelect, dimmed, footnote }: TimelineChartProps) {
  const [wrapRef, width] = useElementWidth<HTMLDivElement>();
  const gradientId = useId();
  const [hover, setHover] = useState<number | null>(null);
  const spec = useMemo(() => specFor(metric, buckets), [metric, buckets]);

  const axisMax = useMemo(() => {
    if (spec.fixedMax) return spec.fixedMax;
    const peak =
      spec.kind === 'bars'
        ? Math.max(0, ...buckets.map((b) => spec.series.reduce((s, x) => s + (x.value(b) ?? 0), 0)))
        : Math.max(0, ...buckets.flatMap((b) => spec.series.map((x) => x.value(b) ?? 0)));
    return niceMax(peak, TICKS);
  }, [buckets, spec]);

  const target = useMemo<TweenFrame>(
    () => ({
      keys: buckets.map((b) => b.start),
      rows: spec.series.map((s) =>
        buckets.map((b) => {
          const v = s.value(b);
          return v === null ? null : v;
        }),
      ),
      max: axisMax,
    }),
    [buckets, spec, axisMax],
  );
  const frame = useTweenedFrame(target, `${spec.kind}:${spec.series.map((s) => s.key).join(',')}`);
  // The tweened frame can lag one render behind a new bucket set; align it by bucket start.
  const rows = useMemo(() => {
    const index = new Map(frame.keys.map((key, i) => [key, i]));
    return spec.series.map((_, s) =>
      buckets.map((b) => {
        const i = index.get(b.start);
        const v = i === undefined ? null : (frame.rows[s]?.[i] ?? null);
        return v === null ? null : v / (frame.max || 1);
      }),
    );
  }, [frame, spec, buckets]);

  const n = buckets.length;
  const plotW = Math.max(10, width - M.left - M.right);
  const plotH = HEIGHT - M.top - M.bottom;
  const slot = n > 0 ? plotW / n : plotW;
  const gap = slot >= 6 ? 2 : slot >= 3 ? 1 : 0;
  const barW = Math.max(1, Math.min(24, slot - gap));
  const cx = (i: number) => M.left + slot * i + slot / 2;
  const yOf = (ratio: number) => M.top + plotH * (1 - Math.max(0, Math.min(1.04, ratio)));

  const totals = buckets.map((b) => spec.series.reduce((s, x) => s + (x.value(b) ?? 0), 0));
  const peakIndex = spec.kind === 'bars' && n > 0 ? totals.indexOf(Math.max(...totals)) : -1;
  const hasData = buckets.some((b) => b.calls > 0);

  const xTicks = useMemo(() => {
    if (n === 0) return [];
    const count = Math.max(2, Math.floor(plotW / 92));
    const step = Math.max(1, Math.ceil(n / count));
    const daily = size === '1d' || size === '1w';
    const ticks: Array<{ index: number; top: string; bottom?: string }> = [];
    let lastDay = '';
    for (let i = 0; i < n; i += step) {
      const start = buckets[i].start;
      const day = dayLabel(start);
      if (daily) ticks.push({ index: i, top: day });
      else {
        ticks.push({ index: i, top: timeLabel(start), bottom: day !== lastDay ? day : undefined });
        lastDay = day;
      }
    }
    return ticks;
  }, [buckets, n, plotW, size]);

  const handleMove = (event: ReactPointerEvent<SVGRectElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const index = Math.floor(((event.clientX - rect.left) / rect.width) * n);
    setHover(index >= 0 && index < n ? index : null);
  };

  const active = hover ?? (selected !== null ? buckets.findIndex((b) => b.start === selected) : -1);
  const activeIndex = active !== null && active >= 0 ? active : null;
  const activeBucket = activeIndex !== null ? buckets[activeIndex] : null;
  const selectedIndex = selected !== null ? buckets.findIndex((b) => b.start === selected) : -1;

  return (
    <figure className={`${styles.chart} ${dimmed ? styles.dimmed : ''}`}>
      <figcaption className={styles.legend}>
        {spec.series.map((s) => (
          <span key={s.key} className={styles.legendItem}>
            <span
              className={`${styles.swatch} ${spec.kind === 'lines' ? styles.swatchLine : ''} ${s.dashed ? styles.swatchDashed : ''}`}
              style={{ background: s.dashed ? undefined : s.color, borderColor: s.color }}
              aria-hidden="true"
            />
            {s.label}
            {s.total && <b>{s.total}</b>}
          </span>
        ))}
      </figcaption>

      <div ref={wrapRef} className={styles.plot}>
        <svg
          width={width}
          height={HEIGHT}
          className={styles.svg}
          role="img"
          aria-label={`${spec.series.map((s) => s.label).join(', ')} over ${n} buckets`}
        >
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--text-primary)" stopOpacity="0.14" />
              <stop offset="100%" stopColor="var(--text-primary)" stopOpacity="0.01" />
            </linearGradient>
          </defs>

          {Array.from({ length: TICKS + 1 }, (_, i) => {
            const ratio = i / TICKS;
            const y = yOf(ratio);
            return (
              <g key={i}>
                <line x1={M.left} x2={M.left + plotW} y1={y} y2={y} className={i === 0 ? styles.baseline : styles.grid} />
                <text x={M.left - 8} y={y} className={styles.yTick} textAnchor="end" dominantBaseline="middle">
                  {spec.axis(axisMax * ratio)}
                </text>
              </g>
            );
          })}

          {selectedIndex >= 0 && (
            <rect x={M.left + slot * selectedIndex} y={M.top} width={slot} height={plotH} className={styles.selectedBand} />
          )}
          {activeIndex !== null && hover !== null && spec.kind === 'bars' && (
            <rect x={M.left + slot * activeIndex} y={M.top} width={slot} height={plotH} className={styles.hoverBand} />
          )}

          {spec.kind === 'bars' ? (
            <g>
              {buckets.map((b, i) => {
                const x = cx(i) - barW / 2;
                const values = rows.map((row) => Math.max(0, row[i] ?? 0));
                const lastNonZero = values.reduce((last, v, s) => (v > 0 ? s : last), -1);
                if (lastNonZero < 0) {
                  return <rect key={b.start} x={x} y={M.top + plotH - 2} width={barW} height={2} rx={1} className={styles.idle} />;
                }
                const heights = segmentHeights(values.map((v) => v * plotH));
                let base = M.top + plotH;
                return (
                  <g key={b.start}>
                    {values.map((v, s) => {
                      if (v <= 0) return null;
                      const fullH = heights[s];
                      const segmentGap = s < lastNonZero ? (fullH >= 6 ? 2 : fullH >= 2.5 ? 1 : 0) : 0;
                      const h = Math.max(fullH - segmentGap, 0.5);
                      const top = base - fullH;
                      base = top;
                      return (
                        <path
                          key={spec.series[s].key}
                          d={barPath(x, top + segmentGap, barW, h, s === lastNonZero)}
                          fill={spec.series[s].color}
                        />
                      );
                    })}
                  </g>
                );
              })}
              {peakIndex >= 0 && totals[peakIndex] > 0 && slot >= 4 && (
                <text
                  x={cx(peakIndex)}
                  y={yOf(totals[peakIndex] / (frame.max || axisMax)) - 6}
                  className={styles.peak}
                  textAnchor={peakIndex < n * 0.08 ? 'start' : peakIndex > n * 0.92 ? 'end' : 'middle'}
                >
                  {spec.axis === formatCompact ? formatInt(totals[peakIndex]) : spec.axis(totals[peakIndex])}
                </text>
              )}
            </g>
          ) : (
            <g>
              {spec.series.map((s, si) => {
                const row = rows[si] ?? [];
                const segments = segmentsOf(row);
                return segments.map((segment, k) => {
                  const pts = segment.map(({ index, value }) => ({ x: cx(index), y: yOf(value) }));
                  const line = pts.length === 1 ? `M${pts[0].x - 2} ${pts[0].y}H${pts[0].x + 2}` : buildSmoothLinePath(pts, M.top, M.top + plotH);
                  const area =
                    spec.series.length === 1 && pts.length > 1
                      ? `${line} L${pts[pts.length - 1].x} ${M.top + plotH} L${pts[0].x} ${M.top + plotH} Z`
                      : null;
                  return (
                    <g key={`${s.key}-${k}`}>
                      {area && <path d={area} fill={`url(#${gradientId})`} />}
                      <path
                        d={line}
                        fill="none"
                        stroke={s.color}
                        strokeWidth={2}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeDasharray={s.dashed ? '4 4' : undefined}
                      />
                    </g>
                  );
                });
              })}
            </g>
          )}

          {buckets.map((b, i) =>
            b.anomalies.length > 0 ? (
              <circle
                key={`anomaly-${b.start}`}
                cx={cx(i)}
                cy={8}
                r={3}
                className={b.anomalies.some((a) => a.severity === 'high') ? styles.anomalyHigh : styles.anomaly}
              />
            ) : null,
          )}

          {activeIndex !== null && hover !== null && spec.kind === 'lines' && (
            <g>
              <line x1={cx(activeIndex)} x2={cx(activeIndex)} y1={M.top} y2={M.top + plotH} className={styles.crosshair} />
              {spec.series.map((s, si) => {
                const v = rows[si]?.[activeIndex];
                return v === null || v === undefined ? null : (
                  <circle key={s.key} cx={cx(activeIndex)} cy={yOf(v)} r={4} fill={s.color} className={styles.dot} />
                );
              })}
            </g>
          )}

          {xTicks.map((tick) => (
            <text key={tick.index} x={cx(tick.index)} y={M.top + plotH + 16} className={styles.xTick} textAnchor="middle">
              <tspan>{tick.top}</tspan>
              {tick.bottom && (
                <tspan x={cx(tick.index)} dy={12} className={styles.xTickDay}>
                  {tick.bottom}
                </tspan>
              )}
            </text>
          ))}

          <rect
            x={M.left}
            y={0}
            width={plotW}
            height={M.top + plotH}
            fill="transparent"
            className={styles.hit}
            onPointerMove={handleMove}
            onPointerLeave={() => setHover(null)}
            onClick={() => {
              if (activeBucket) onSelect(activeBucket.start === selected ? null : activeBucket);
            }}
          />
        </svg>

        {!hasData && <p className={styles.noData}>No requests in this range</p>}

        {activeBucket && hover !== null && (
          <div
            className={styles.tooltip}
            style={{
              left: cx(activeIndex!),
              transform:
                activeIndex! < n * 0.2 ? 'translateX(-8%)' : activeIndex! > n * 0.8 ? 'translateX(-92%)' : 'translateX(-50%)',
            }}
            role="status"
          >
            <span className={styles.tooltipTitle}>{bucketTitle(activeBucket.start, activeBucket.end, size)}</span>
            <TooltipBody bucket={activeBucket} metric={metric} />
            {activeBucket.anomalies.length > 0 && (
              <span className={styles.tooltipAnomaly}>
                {activeBucket.anomalies.flatMap((a) =>
                  a.metric_keys.map((key) => (
                    <span key={`${a.bucket_ms}-${key}`}>
                      {ANOMALY_LABELS[key]} <b>{formatAnomalyChange(key, anomalyChange(a, key))}</b>
                    </span>
                  )),
                )}
              </span>
            )}
            {footnote && activeBucket.unpriced > 0 && <span className={styles.tooltipNote}>{footnote}</span>}
            <span className={styles.tooltipHint}>{selected === activeBucket.start ? 'Click to close details' : 'Click for details'}</span>
          </div>
        )}
      </div>

      <details className={styles.table}>
        <summary>Data table</summary>
        <div className="kit-table-wrap">
          <table className="kit-table">
            <thead>
              <tr>
                <th>Bucket</th>
                {spec.series.map((s) => (
                  <th key={s.key} data-align="right">
                    {s.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {buckets.map((b) => (
                <tr key={b.start}>
                  <td>{bucketTitle(b.start, b.end, size)}</td>
                  {spec.series.map((s) => {
                    const v = s.value(b);
                    return (
                      <td key={s.key} data-align="right" data-mono="true">
                        {v === null ? '--' : metric === 'requests' ? formatInt(v) : spec.axis(v)}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}

function Row({ color, label, value, dashed }: { color?: string; label: string; value: string; dashed?: boolean }) {
  return (
    <span className={styles.tooltipRow}>
      {color ? (
        <span className={`${styles.swatch} ${dashed ? styles.swatchDashed : ''}`} style={{ background: dashed ? undefined : color, borderColor: color }} aria-hidden="true" />
      ) : (
        <span className={styles.swatchSpacer} aria-hidden="true" />
      )}
      {label}
      <b>{value}</b>
    </span>
  );
}

function TooltipBody({ bucket: b, metric }: { bucket: ChartBucket; metric: ChartMetric }) {
  const approx = b.p95Approx ? '≈ ' : '';
  switch (metric) {
    case 'requests':
      return (
        <>
          <Row color={COLORS.success} label="Success" value={formatInt(b.success)} />
          <Row color={COLORS.failure} label="Failed" value={formatInt(b.failure)} />
          <span className={styles.tooltipFoot}>
            {b.calls > 0 ? `${formatRatio(b.success / b.calls)} success · ${formatTokens(b.totalTokens)} tok · ${formatCost(b.cost)}` : 'No requests'}
          </span>
        </>
      );
    case 'tokens':
      return (
        <>
          <Row color={COLORS.output} label="Output" value={formatTokens(b.outputTokens)} />
          <Row color={COLORS.fresh} label="Fresh input" value={formatTokens(b.freshInput)} />
          <Row color={COLORS.cacheWrite} label="Cache write" value={formatTokens(b.cacheWrite)} />
          <Row color={COLORS.cacheRead} label="Cache read" value={formatTokens(b.cacheRead)} />
          {b.reasoningTokens > 0 && <Row color={COLORS.reasoning} label="of output: reasoning" value={formatTokens(b.reasoningTokens)} />}
          <span className={styles.tooltipFoot}>
            {formatTokens(b.totalTokens)} total · {b.calls > 0 ? `${formatCompact(b.totalTokens / b.calls)} / req` : 'no requests'}
          </span>
        </>
      );
    case 'cost':
      return (
        <>
          <Row color={COLORS.cost} label="Cost" value={formatCost(b.cost)} />
          <Row label="Requests" value={formatInt(b.calls)} />
          <span className={styles.tooltipFoot}>{b.calls > 0 ? `${formatCost(b.cost / b.calls)} / request` : 'No requests'}</span>
        </>
      );
    case 'latency':
      return (
        <>
          <Row color={COLORS.line} label="Avg latency" value={formatDuration(b.avgLatency)} />
          <Row color={COLORS.lineMuted} dashed label="P95 latency" value={`${approx}${formatDuration(b.p95Latency)}`} />
          <Row label="P95 TTFT" value={`${approx}${formatDuration(b.p95Ttft)}`} />
          <span className={styles.tooltipFoot}>
            {formatInt(b.calls)} requests{b.p95Approx ? ' · p95 = max of merged buckets' : ''}
          </span>
        </>
      );
    case 'cache':
      return (
        <>
          <Row color={COLORS.line} label="Cache hit" value={formatRatio(b.cacheHitRate)} />
          <Row label="Cache read" value={formatTokens(b.cacheRead)} />
          <Row label="Input" value={formatTokens(b.inputTokens)} />
          <span className={styles.tooltipFoot}>{formatInt(b.calls)} requests</span>
        </>
      );
  }
}
