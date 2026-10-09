import { useMemo, useState } from 'react';
import { Panel, SegmentedControl } from '@/components/kit';
import type { HeatmapPoint, HourlyPoint } from '@/lib/api/analytics';
import { formatCompact, formatCost, formatInt, formatRatio, formatTokens } from '@/lib/format';
import styles from './panels.module.scss';

type HeatMetric = 'calls' | 'tokens' | 'cost' | 'failure_rate';
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
/** Go weekday (0 = Sunday) → Monday-first row. */
const rowOf = (weekday: number) => (weekday + 6) % 7;
const pad = (n: number) => String(n).padStart(2, '0');

const fmt: Record<HeatMetric, (v: number) => string> = {
  calls: formatInt,
  tokens: formatTokens,
  cost: formatCost,
  failure_rate: (v) => formatRatio(v),
};

/** Weekday × hour activity in the browser's zone. Volume uses the healthy-traffic hue, failure rate terracotta. */
export function HeatmapPanel({ points, hourly }: { points: HeatmapPoint[]; hourly: HourlyPoint[] }) {
  const [metric, setMetric] = useState<HeatMetric>('calls');
  const [hover, setHover] = useState<HeatmapPoint | null>(null);

  const grid = useMemo(() => {
    const cells = new Map<string, HeatmapPoint>();
    points.forEach((p) => cells.set(`${rowOf(p.weekday)}-${p.hour}`, p));
    const max = Math.max(0, ...points.map((p) => p[metric]));
    return { cells, max };
  }, [points, metric]);

  const focus = useMemo(() => {
    const top = (pick: (p: HeatmapPoint) => number, filter?: (p: HeatmapPoint) => boolean) =>
      [...points].filter(filter ?? (() => true)).sort((a, b) => pick(b) - pick(a)).slice(0, 3);
    return {
      requests: top((p) => p.calls),
      cost: top((p) => p.cost),
      failures: top((p) => p.failure_rate, (p) => p.failure > 0 && p.calls >= 5),
    };
  }, [points]);

  const hourMax = Math.max(0, ...hourly.map((h) => h.calls));
  const hourly24 = Array.from({ length: 24 }, (_, hour) => hourly.find((h) => h.hour === hour) ?? { hour, calls: 0, tokens: 0 });
  const failureMetric = metric === 'failure_rate';

  return (
    <div className={styles.heatLayout}>
      <Panel
        title="Activity by weekday & hour"
        subtitle="Local time · hover a cell for its top models"
        actions={
          <SegmentedControl
            size="sm"
            value={metric}
            onChange={setMetric}
            options={[
              { value: 'calls', label: 'Requests' },
              { value: 'tokens', label: 'Tokens' },
              { value: 'cost', label: 'Cost' },
              { value: 'failure_rate', label: 'Failure %' },
            ]}
            ariaLabel="Heatmap metric"
          />
        }
        data-reveal
      >
        {points.length === 0 ? (
          <div className="kit-empty">No activity</div>
        ) : (
          <div className={styles.heat} onMouseLeave={() => setHover(null)}>
            <div className={styles.heatGrid} role="grid" aria-label="Weekday by hour heatmap">
              <span />
              {Array.from({ length: 24 }, (_, h) => (
                <span key={h} className={styles.heatHour}>
                  {h % 3 === 0 ? pad(h) : ''}
                </span>
              ))}
              {DAYS.map((day, row) => (
                <div key={day} className={styles.heatRow} role="row">
                  <span className={styles.heatDay}>{day}</span>
                  {Array.from({ length: 24 }, (_, hour) => {
                    const cell = grid.cells.get(`${row}-${hour}`);
                    const value = cell ? cell[metric] : 0;
                    const intensity = grid.max > 0 ? value / grid.max : 0;
                    const color = failureMetric ? 'var(--viz-failure)' : 'var(--viz-success)';
                    return (
                      <span
                        key={hour}
                        role="gridcell"
                        className={`${styles.heatCell} ${hover === cell && cell ? styles.heatCellActive : ''}`}
                        style={
                          cell && value > 0
                            ? { background: `color-mix(in srgb, ${color} ${Math.round(14 + intensity * 86)}%, var(--bg-tertiary))` }
                            : undefined
                        }
                        onMouseEnter={() => setHover(cell ?? null)}
                        aria-label={`${day} ${pad(hour)}:00 ${cell ? fmt[metric](value) : 'no traffic'}`}
                      />
                    );
                  })}
                </div>
              ))}
            </div>
            <div className={styles.heatInfo}>
              {hover ? (
                <>
                  <div className={styles.heatInfoTitle}>
                    {DAYS[rowOf(hover.weekday)]} {pad(hover.hour)}:00–{pad((hover.hour + 1) % 24)}:00
                  </div>
                  <div className={styles.heatStats}>
                    <span>
                      <b>{formatInt(hover.calls)}</b> req
                    </span>
                    <span>
                      <b>{formatTokens(hover.tokens)}</b> tok
                    </span>
                    <span>
                      <b>{formatCost(hover.cost)}</b>
                    </span>
                    <span className={hover.failure > 0 ? 'kit-tone-attention' : undefined}>
                      <b>{formatInt(hover.failure)}</b> failed ({formatRatio(hover.failure_rate)})
                    </span>
                  </div>
                  {(hover.model_contributors ?? []).slice(0, 4).map((c) => (
                    <div key={c.key} className={styles.contrib}>
                      <span className={styles.contribName}>{c.label || c.key}</span>
                      <span className={styles.contribBar}>
                        <span style={{ width: `${Math.round(c.share * 100)}%` }} />
                      </span>
                      <span className={styles.contribPct}>{formatRatio(c.share, 0)}</span>
                    </div>
                  ))}
                </>
              ) : (
                <div className={styles.focus}>
                  <FocusList title="Busiest" items={focus.requests} value={(p) => `${formatCompact(p.calls)} req`} />
                  <FocusList title="Most spend" items={focus.cost} value={(p) => formatCost(p.cost)} />
                  {focus.failures.length > 0 && (
                    <FocusList title="Failure risk" items={focus.failures} value={(p) => formatRatio(p.failure_rate)} attention />
                  )}
                </div>
              )}
            </div>
          </div>
        )}
      </Panel>

      <Panel title="Hour of day" subtitle="Requests per local hour" data-reveal>
        <div className={styles.hourBars} role="img" aria-label="Requests by hour of day">
          {hourly24.map((h) => (
            <span key={h.hour} className={styles.hourCol} title={`${pad(h.hour)}:00 · ${formatInt(h.calls)} requests · ${formatTokens(h.tokens)} tokens`}>
              <span className={styles.hourBar} style={{ height: `${hourMax > 0 ? Math.max(h.calls > 0 ? 3 : 0, (h.calls / hourMax) * 100) : 0}%` }} />
            </span>
          ))}
        </div>
        <div className={styles.hourAxis}>
          {[0, 6, 12, 18, 23].map((h) => (
            <span key={h} style={{ left: `${((h + 0.5) / 24) * 100}%` }}>
              {pad(h)}
            </span>
          ))}
        </div>
      </Panel>
    </div>
  );
}

function FocusList({
  title,
  items,
  value,
  attention,
}: {
  title: string;
  items: HeatmapPoint[];
  value: (p: HeatmapPoint) => string;
  attention?: boolean;
}) {
  if (items.length === 0) return null;
  return (
    <div className={styles.focusGroup}>
      <div className={styles.focusTitle}>{title}</div>
      {items.map((p) => (
        <div key={`${p.weekday}-${p.hour}`} className={styles.focusItem}>
          <span>
            {DAYS[rowOf(p.weekday)]} {pad(p.hour)}:00
          </span>
          <b className={attention ? 'kit-tone-attention' : undefined}>{value(p)}</b>
        </div>
      ))}
    </div>
  );
}
