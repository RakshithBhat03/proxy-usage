import type { ReactNode } from 'react';
import { StatTile } from '@/components/kit';
import type { Summary, SummaryComparison } from '@/lib/api/analytics';
import { formatCompact, formatCost, formatDuration, formatInt, formatPercent, formatRatio, formatTokens, formatTps } from '@/lib/format';
import { pctChange, successTone, type TierAggregate } from '../model/derive';
import styles from './KpiGrid.module.scss';

type Good = 'up' | 'down' | 'neutral';

interface Delta {
  /** Relative change (fraction) or, with `points`, an absolute change of a 0..1 rate. */
  value: number;
  points?: boolean;
  good: Good;
}

function DeltaBadge({ delta }: { delta: Delta }) {
  const { value, points, good } = delta;
  const flat = Math.abs(value) < (points ? 0.0005 : 0.005);
  const up = value > 0;
  const tone = flat || good === 'neutral' ? 'neutral' : (up && good === 'up') || (!up && good === 'down') ? 'good' : 'bad';
  const text = points ? `${Math.abs(value * 100).toFixed(1)} pts` : `${Math.abs(value * 100) >= 999 ? '999+' : Math.abs(value * 100).toFixed(Math.abs(value) < 0.1 ? 1 : 0)}%`;
  return (
    <span className={`${styles.delta} ${styles[`delta_${tone}`]}`} title="vs previous period">
      {flat ? '±' : up ? '▲' : '▼'} {text}
    </span>
  );
}

function Label({ text, delta }: { text: string; delta?: Delta | null }) {
  return (
    <span className={styles.label}>
      <span className={styles.labelText}>{text}</span>
      {delta && <DeltaBadge delta={delta} />}
    </span>
  );
}

interface KpiGridProps {
  summary: Summary;
  comparison?: SummaryComparison;
  previous?: Summary;
  tiers: TierAggregate;
  previousTiers?: TierAggregate;
  rangeMinutes: number;
  compare: boolean;
}

const rpmText = (v: number) => `${v >= 100 ? formatCompact(v) : v.toFixed(v < 10 ? 2 : 1)} rpm`;

export function KpiGrid({ summary: s, comparison: c, previous: p, tiers, previousTiers, rangeMinutes, compare }: KpiGridProps) {
  const rel = (cur: number | null | undefined, prev: number | null | undefined, good: Good): Delta | null =>
    compare && cur != null && prev != null && (prev > 0 || cur > 0) ? { value: pctChange(cur, prev), good } : null;
  const pts = (cur: number | null | undefined, prev: number | null | undefined, good: Good, prevCalls?: number): Delta | null =>
    compare && cur != null && prev != null && (prevCalls ?? 1) > 0 ? { value: cur - prev, points: true, good } : null;

  const rpm = rangeMinutes > 0 ? s.total_calls / rangeMinutes : 0;
  const tpm = rangeMinutes > 0 ? s.total_tokens / rangeMinutes : 0;
  const tasksCapped = s.approx_tasks >= 500;

  const tiles: Array<{ key: string; node: ReactNode }> = [
    {
      key: 'requests',
      node: (
        <StatTile
          label={<Label text="Requests" delta={rel(s.total_calls, c?.total_calls, 'neutral')} />}
          value={s.total_calls}
          format={formatInt}
          hint={
            <>
              <span className="kit-tone-live">{formatInt(s.success_calls)}</span> ok ·{' '}
              <span className={s.failure_calls > 0 ? 'kit-tone-attention' : undefined}>{formatInt(s.failure_calls)}</span> failed
            </>
          }
        />
      ),
    },
    {
      key: 'success',
      node: (
        <StatTile
          label={<Label text="Success rate" delta={pts(s.success_rate, c?.success_rate, 'up', c?.total_calls)} />}
          value={s.total_calls > 0 ? s.success_rate * 100 : null}
          format={(v) => formatPercent(v, 1)}
          tone={successTone(s.success_rate, s.total_calls)}
          hint={s.zero_token_calls > 0 ? `${formatInt(s.zero_token_calls)} empty responses` : `${formatInt(s.failure_calls)} failures`}
        />
      ),
    },
    {
      key: 'tokens',
      node: (
        <StatTile
          label={<Label text="Total tokens" delta={rel(s.total_tokens, c?.total_tokens, 'neutral')} />}
          value={s.total_tokens}
          format={formatTokens}
          hint={`in ${formatTokens(s.input_tokens)} · out ${formatTokens(s.output_tokens)}`}
        />
      ),
    },
    {
      key: 'cost',
      node: (
        <StatTile
          label={<Label text="Cost" delta={rel(s.total_cost, c?.total_cost, 'down')} />}
          value={s.total_cost}
          format={formatCost}
          hint={`${formatCost(s.average_cost_per_call)} / request`}
        />
      ),
    },
    {
      key: 'latency',
      node: (
        <StatTile
          label={<Label text="Avg latency" delta={rel(s.average_latency_ms, p?.average_latency_ms, 'down')} />}
          value={s.average_latency_ms}
          format={formatDuration}
          hint={`p95 ${formatDuration(s.p95_latency_ms)}`}
        />
      ),
    },
    {
      key: 'ttft',
      node: (
        <StatTile
          label={<Label text="Avg TTFT" delta={rel(tiers.avgTtft, previousTiers?.avgTtft, 'down')} />}
          value={tiers.avgTtft}
          format={formatDuration}
          hint={`p95 ${formatDuration(s.p95_ttft_ms)}`}
        />
      ),
    },
    {
      key: 'tps',
      node: (
        <StatTile
          label={<Label text="Output speed" delta={rel(tiers.outputTps, previousTiers?.outputTps, 'up')} />}
          value={tiers.outputTps}
          format={formatTps}
          hint={`mean of ${formatInt(tiers.tpsSamples)} requests`}
        />
      ),
    },
    {
      key: 'cache',
      node: (
        <StatTile
          label={<Label text="Cache hit rate" delta={pts(s.cache_hit_rate, p?.cache_hit_rate, 'up', p?.total_calls)} />}
          value={s.input_tokens > 0 ? s.cache_hit_rate * 100 : null}
          format={(v) => formatPercent(v, 1)}
          hint={`read ${formatTokens(s.cache_read_tokens + s.cached_tokens)} · write ${formatTokens(s.cache_creation_tokens)}`}
        />
      ),
    },
    {
      key: 'throughput',
      node: (
        <StatTile
          label={<Label text="Throughput" />}
          value={rpm}
          format={rpmText}
          hint={`${formatTokens(tpm)} TPM · last 30m ${s.rpm_30m.toFixed(1)} rpm`}
        />
      ),
    },
    {
      key: 'tasks',
      node: (
        <StatTile
          label={<Label text="Approx. tasks" />}
          value={s.approx_tasks}
          format={(v) => (tasksCapped && Math.round(v) >= 500 ? '500+' : formatInt(v))}
          hint={`${formatRatio(s.approx_task_success_rate)} clean · ${formatCompact(s.avg_daily_requests)} req/day`}
        />
      ),
    },
  ];

  return (
    <div className={`kit-stat-grid ${styles.grid}`}>
      {tiles.map((tile) => (
        <div key={tile.key} className={styles.cell}>
          {tile.node}
        </div>
      ))}
    </div>
  );
}
