import { useMemo, useState, type CSSProperties } from 'react';
import { Skeleton } from '@/components/ui/Skeleton';
import { formatDuration, formatInt, formatRatio } from '@/lib/format';
import { BUCKET_MS, formatBucketLabel, type ConcreteBucket } from '@/lib/timeRange';
import { niceMax, type ActivityBucket } from '../model/series';
import styles from './ActivityChart.module.scss';

const TICKS = 4;
const VIEW_W = 1000;
/** Entrance wave: each bar grows for ~420ms (CSS), starts spread over this window, left to right. */
const WAVE_SPREAD_MS = 280;

/**
 * Which column set is on screen. A new range or bucket size shares few columns with the old one,
 * so the chart re-enters (columns remount and grow in a wave); the same shape (a poll advancing the
 * rolling window by a bucket, a filter change) keeps its columns and morphs their heights.
 */
interface ColumnSet {
  size: ConcreteBucket;
  n: number;
  first: number;
  generation: number;
  /** Wave delay per column present at the entrance; columns added later grow without delay. */
  delays: ReadonlyMap<number, number>;
}

function sameShape(previous: ColumnSet, size: ConcreteBucket, n: number, first: number): boolean {
  if (previous.size !== size) return false;
  const tolerance = Math.max(2, Math.round(n * 0.1));
  return Math.abs(previous.n - n) <= tolerance && Math.abs(first - previous.first) / BUCKET_MS[size] <= tolerance;
}

/** Morphs the latency curve between same-shape frames where CSS `d` is supported (else it snaps). */
const pathStyle = (d: string) => ({ d: `path("${d}")` }) as CSSProperties;

interface ActivityChartProps {
  buckets: ActivityBucket[] | null;
  size: ConcreteBucket;
}

interface Pt {
  x: number;
  y: number;
}

/** Catmull-Rom through the points, control points clamped so the curve never leaves the plot. */
function smoothPath(points: Pt[]): string {
  if (points.length === 0) return '';
  const clamp = (v: number) => Math.max(0, Math.min(100, v));
  let d = `M${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)}`;
  for (let i = 0; i < points.length - 1; i += 1) {
    const p0 = points[Math.max(0, i - 1)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(points.length - 1, i + 2)];
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = clamp(p1.y + (p2.y - p0.y) / 6);
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = clamp(p2.y - (p3.y - p1.y) / 6);
    d += ` C${c1x.toFixed(2)} ${c1y.toFixed(2)}, ${c2x.toFixed(2)} ${c2y.toFixed(2)}, ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`;
  }
  return d;
}

function axisMs(ms: number): string {
  if (ms <= 0) return '0';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  return s >= 60 ? `${Math.round(s / 60)}m` : `${Number(s.toFixed(s < 10 ? 1 : 0))}s`;
}

function axisCount(n: number): string {
  return n >= 1000 ? `${Number((n / 1000).toFixed(1))}k` : String(Math.round(n));
}

/**
 * Stacked success/failure columns per bucket with a p95-latency line on a second axis. DOM columns
 * (not SVG) so each bucket animates in on its own as the rolling window advances. A new column set
 * enters as a left-to-right wave with the latency line drawn in behind it; the same column set
 * morphs (segment heights and the curve transition, changed axis labels fade in).
 */
export function ActivityChart({ buckets, size }: ActivityChartProps) {
  const [active, setActive] = useState<number | null>(null);
  const [columns, setColumns] = useState<ColumnSet | null>(null);
  if (buckets && buckets.length > 0) {
    const n = buckets.length;
    const first = buckets[0].start;
    if (!columns || columns.size !== size || columns.n !== n || columns.first !== first) {
      if (columns && sameShape(columns, size, n, first)) {
        setColumns({ ...columns, n, first });
      } else {
        const delays = new Map<number, number>();
        buckets.forEach((b, i) => delays.set(b.start, n > 1 ? Math.round((i / (n - 1)) * WAVE_SPREAD_MS) : 0));
        setColumns({ size, n, first, generation: (columns?.generation ?? -1) + 1, delays });
        setActive(null);
      }
    }
  }
  const generation = columns?.generation ?? 0;
  const delays = columns?.delays;

  const model = useMemo(() => {
    if (!buckets) return null;
    let peak = 0;
    let latPeak = 0;
    let success = 0;
    let failure = 0;
    for (const b of buckets) {
      peak = Math.max(peak, b.success + b.failure);
      latPeak = Math.max(latPeak, b.p95 ?? 0);
      success += b.success;
      failure += b.failure;
    }
    const countMax = niceMax(peak, TICKS, true);
    const latMax = niceMax(latPeak, TICKS);
    const n = buckets.length;
    const segments: Pt[][] = [];
    let current: Pt[] = [];
    buckets.forEach((b, i) => {
      if (b.p95 === null) {
        if (current.length) segments.push(current);
        current = [];
        return;
      }
      current.push({ x: ((i + 0.5) / n) * VIEW_W, y: 100 - (b.p95 / latMax) * 100 });
    });
    if (current.length) segments.push(current);
    const xTicks = Array.from(new Set(Array.from({ length: Math.min(6, n) }, (_, k) => Math.round((k * (n - 1)) / Math.max(1, Math.min(6, n) - 1)))));
    return { countMax, latMax, success, failure, segments, xTicks, n, hasLatency: latPeak > 0 };
  }, [buckets]);

  if (!buckets || !model) {
    return (
      <div className={styles.loading} aria-busy="true">
        <Skeleton height={196} rounded={10} />
      </div>
    );
  }

  const { countMax, latMax, success, failure, segments, xTicks, n, hasLatency } = model;
  const total = success + failure;
  const activeBucket = active !== null ? buckets[active] : null;
  const gap = n > 200 ? 0 : n > 90 ? 1 : 2;
  const ticks = Array.from({ length: TICKS + 1 }, (_, i) => 1 - i / TICKS);

  return (
    <figure className={styles.chart}>
      <figcaption className={styles.legend}>
        <span className={styles.legendItem}>
          <span className={`${styles.swatch} ${styles.swatchSuccess}`} aria-hidden="true" />
          Success <b>{formatInt(success)}</b>
        </span>
        <span className={styles.legendItem}>
          <span className={`${styles.swatch} ${styles.swatchFailure}`} aria-hidden="true" />
          Failed <b>{formatInt(failure)}</b>
        </span>
        {hasLatency && (
          <span className={styles.legendItem}>
            <span className={styles.swatchLine} aria-hidden="true" />
            p95 latency
          </span>
        )}
      </figcaption>

      <div className={styles.plot}>
        <div className={styles.yAxis} aria-hidden="true">
          {ticks.map((r) => (
            <span key={`${r}:${axisCount(countMax * r)}`} className={styles.yTick} style={{ top: `${(1 - r) * 100}%` }}>
              {axisCount(countMax * r)}
            </span>
          ))}
        </div>

        <div className={styles.canvas}>
          <div className={styles.gridlines} aria-hidden="true">
            {ticks.map((r) => (
              <span key={r} className={styles.gridline} style={{ top: `${(1 - r) * 100}%` }} />
            ))}
          </div>

          <div
            key={`bars-${generation}`}
            className={styles.columns}
            style={{ gap }}
            role="img"
            aria-label={`${formatInt(total)} requests, ${formatInt(failure)} failed, in ${n} buckets`}
            onMouseLeave={() => setActive(null)}
          >
            {buckets.map((b, i) => {
              const count = b.success + b.failure;
              const delay = delays?.get(b.start) ?? 0;
              return (
                <div
                  key={b.start}
                  className={`${styles.column} ${active === i ? styles.columnActive : ''}`}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => setActive((cur) => (cur === i ? null : i))}
                >
                  <div className={styles.stack} style={{ '--bar-delay': `${delay}ms` } as CSSProperties}>
                    {b.failure > 0 && (
                      <span
                        className={`${styles.segment} ${styles.failure} ${b.success > 0 ? styles.segmentGap : ''}`}
                        style={{ height: `${(b.failure / countMax) * 100}%` }}
                      />
                    )}
                    {b.success > 0 && (
                      <span
                        className={`${styles.segment} ${styles.success} ${b.failure > 0 ? styles.squareTop : ''}`}
                        style={{ height: `${(b.success / countMax) * 100}%` }}
                      />
                    )}
                    {count === 0 && <span className={styles.idle} />}
                  </div>
                </div>
              );
            })}
          </div>

          {hasLatency && (
            <svg
              key={`p95-${generation}`}
              className={styles.line}
              viewBox={`0 0 ${VIEW_W} 100`}
              preserveAspectRatio="none"
              aria-hidden="true"
            >
              {segments.map((points, i) => {
                const d =
                  points.length > 1
                    ? smoothPath(points)
                    : `M${(points[0].x - 4).toFixed(2)} ${points[0].y.toFixed(2)} L${(points[0].x + 4).toFixed(2)} ${points[0].y.toFixed(2)}`;
                return <path key={`${i}:${points.length}`} d={d} style={pathStyle(d)} vectorEffect="non-scaling-stroke" />;
              })}
            </svg>
          )}

          {activeBucket && activeBucket.p95 !== null && (
            <span
              className={styles.lineDot}
              style={{ left: `${((active! + 0.5) / n) * 100}%`, top: `${100 - (activeBucket.p95 / latMax) * 100}%` }}
              aria-hidden="true"
            />
          )}

          {total === 0 && (
            <p key={`empty-${generation}`} className={styles.empty}>
              No requests in this window
            </p>
          )}

          {activeBucket && (
            <div
              className={styles.tooltip}
              role="status"
              style={{
                left: `${((active! + 0.5) / n) * 100}%`,
                transform:
                  active! < n * 0.18 ? 'translateX(-10%)' : active! > n * 0.82 ? 'translateX(-90%)' : 'translateX(-50%)',
              }}
            >
              <span className={styles.tooltipTime}>
                {formatBucketLabel(activeBucket.start, size)} – {formatBucketLabel(activeBucket.end, size)}
              </span>
              <span className={styles.tooltipRow}>
                <span className={`${styles.swatch} ${styles.swatchSuccess}`} aria-hidden="true" />
                Success <b>{formatInt(activeBucket.success)}</b>
              </span>
              <span className={styles.tooltipRow}>
                <span className={`${styles.swatch} ${styles.swatchFailure}`} aria-hidden="true" />
                Failed <b>{formatInt(activeBucket.failure)}</b>
              </span>
              <span className={styles.tooltipFoot}>
                <span>
                  p95 <b>{formatDuration(activeBucket.p95)}</b>
                </span>
                <span>
                  {activeBucket.success + activeBucket.failure > 0
                    ? `${formatRatio(activeBucket.failure / (activeBucket.success + activeBucket.failure))} failed`
                    : 'idle'}
                </span>
              </span>
            </div>
          )}
        </div>

        <div className={`${styles.yAxis} ${styles.yAxisRight}`} aria-hidden="true">
          {hasLatency &&
            ticks.map((r) => (
              <span key={`${r}:${axisMs(latMax * r)}`} className={styles.yTick} style={{ top: `${(1 - r) * 100}%` }}>
                {axisMs(latMax * r)}
              </span>
            ))}
        </div>
      </div>

      <div key={`xaxis-${generation}`} className={styles.xAxis} aria-hidden="true">
        {xTicks.map((i) => (
          <span
            key={`${i}:${buckets[i].start}`}
            className={styles.xTick}
            style={{ left: `${((i + 0.5) / n) * 100}%` }}
          >
            {formatBucketLabel(buckets[i].start, size)}
          </span>
        ))}
      </div>
    </figure>
  );
}
