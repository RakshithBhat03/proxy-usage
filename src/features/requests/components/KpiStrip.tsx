import { StatTile } from '@/components/kit';
import { Skeleton } from '@/components/ui/Skeleton';
import type { EventRow, ModelTierStat, Summary, SummaryComparison } from '@/lib/api/analytics';
import { formatCompact, formatCost, formatDuration, formatInt, formatPercent, formatRatio, formatTps } from '@/lib/format';
import { eventGenerationTps } from '@/lib/pricing';
import styles from './KpiStrip.module.scss';

interface KpiStripProps {
  summary: Summary | undefined;
  comparison: SummaryComparison | undefined;
  tiers: ModelTierStat[] | undefined;
  rows: EventRow[];
  spanMs: number;
  loading: boolean;
}

function weighted<T>(items: T[], value: (item: T) => number | null | undefined, weight: (item: T) => number) {
  let sum = 0;
  let total = 0;
  for (const item of items) {
    const v = value(item);
    const w = weight(item);
    if (typeof v === 'number' && Number.isFinite(v) && v > 0 && w > 0) {
      sum += v * w;
      total += w;
    }
  }
  return total > 0 ? sum / total : null;
}

function delta(current: number, previous: number | undefined) {
  if (previous === undefined) return null;
  if (previous <= 0) return current > 0 ? 'new vs prev' : null;
  const change = ((current - previous) / previous) * 100;
  if (Math.abs(change) < 0.5) return '≈ prev window';
  return `${change > 0 ? '▲' : '▼'} ${formatPercent(Math.abs(change), Math.abs(change) < 10 ? 1 : 0)} vs prev`;
}

export function KpiStrip({ summary, comparison, tiers, rows, spanMs, loading }: KpiStripProps) {
  if (!summary) {
    return (
      <div className={styles.grid} aria-busy={loading}>
        {Array.from({ length: 8 }, (_, i) => (
          <div key={i} className={`kit-stat ${styles.skeleton}`}>
            <Skeleton width={70} height={11} rounded={4} />
            <Skeleton width={92} height={24} rounded={6} />
            <Skeleton width={110} height={10} rounded={4} />
          </div>
        ))}
      </div>
    );
  }

  const total = summary.total_calls;
  const failureRate = total > 0 ? summary.failure_calls / total : 0;
  const tierRows = tiers ?? [];
  const avgTtft = weighted(tierRows, (t) => t.average_ttft_ms, (t) => t.success_calls);
  const avgTps = weighted(tierRows, (t) => t.output_tps, (t) => t.tps_samples);
  const genSamples = rows.map(eventGenerationTps).filter((v): v is number => v !== null);
  const genTps = genSamples.length > 0 ? genSamples.reduce((a, b) => a + b, 0) / genSamples.length : null;
  const minutes = Math.max(spanMs / 60_000, 1);
  const rpm = total / minutes;

  return (
    <div className={styles.grid}>
      <StatTile
        label="Requests"
        value={total}
        format={(v) => formatInt(Math.round(v))}
        hint={delta(total, comparison?.total_calls) ?? `${formatInt(summary.success_calls)} ok`}
      />
      <StatTile
        label="Failure rate"
        value={failureRate * 100}
        format={(v) => formatPercent(v, v > 0 && v < 10 ? 2 : 1)}
        tone={failureRate >= 0.1 ? 'attention' : failureRate >= 0.03 ? 'amber' : 'default'}
        hint={`${formatInt(summary.failure_calls)} failed`}
      />
      <StatTile
        label="P95 latency"
        value={summary.p95_latency_ms}
        format={(v) => formatDuration(v)}
        hint={`avg ${formatDuration(summary.average_latency_ms)}`}
      />
      <StatTile
        label="Avg TTFT"
        value={avgTtft}
        format={(v) => formatDuration(v)}
        hint={`p95 ${formatDuration(summary.p95_ttft_ms)}`}
      />
      <StatTile
        label="Output TPS"
        value={avgTps}
        format={(v) => formatTps(v)}
        hint={genTps !== null ? `${formatTps(genTps)} excl. TTFT` : 'incl. TTFT'}
      />
      <StatTile
        label="RPM"
        value={rpm}
        format={(v) => (v >= 100 ? formatInt(Math.round(v)) : v.toFixed(1))}
        hint={`over ${minutes >= 120 ? `${formatCompact(minutes / 60)} h` : `${Math.round(minutes)} min`}`}
      />
      <StatTile
        label="Tokens"
        value={summary.total_tokens}
        format={(v) => formatCompact(v)}
        hint={`${formatRatio(summary.cache_hit_rate, 0)} cached · ${formatCompact(summary.output_tokens)} out`}
      />
      <StatTile
        label="Est. cost"
        value={summary.total_cost}
        format={(v) => formatCost(v)}
        hint={`${formatCost(summary.average_cost_per_call)} / req`}
      />
    </div>
  );
}
