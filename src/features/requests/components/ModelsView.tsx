import { Meter } from '@/components/kit';
import { Skeleton } from '@/components/ui/Skeleton';
import type { ModelTierStat } from '@/lib/api/analytics';
import { formatCompact, formatCost, formatDuration, formatInt, formatRatio, formatTps } from '@/lib/format';
import styles from './views.module.scss';

interface ModelsViewProps {
  rows: ModelTierStat[] | undefined;
  onFilter: (model: string) => void;
}

/** Per model × service tier speed card: latency, TTFT and output TPS straight from the server. */
export function ModelsView({ rows, onFilter }: ModelsViewProps) {
  if (!rows) return <Skeleton height={220} rounded={12} />;
  if (rows.length === 0) return <div className="kit-empty">No model traffic in this window.</div>;
  const maxTps = Math.max(...rows.map((r) => r.output_tps ?? 0), 1);

  return (
    <div className="kit-table-wrap">
      <table className={`kit-table ${styles.table}`}>
        <thead>
          <tr>
            <th>Model</th>
            <th data-align="right">Requests</th>
            <th>Success</th>
            <th data-align="right">Avg latency</th>
            <th data-align="right">Avg TTFT</th>
            <th>Output TPS</th>
            <th data-align="right">Tokens</th>
            <th data-align="right">Cost</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={`${row.model}|${row.service_tier}`}
              className={styles.clickable}
              onClick={() => onFilter(row.model)}
              title="Filter the stream to this model"
            >
              <td>
                <span className={styles.modelCell}>
                  <span className={styles.modelName}>{row.model}</span>
                  {row.service_tier && row.service_tier !== 'normal' && (
                    <span className={`kit-badge ${row.service_tier === 'fast' ? 'kit-badge--amber' : ''}`}>{row.service_tier}</span>
                  )}
                </span>
              </td>
              <td data-mono="true" data-align="right">
                {formatInt(row.calls)}
              </td>
              <td>
                <span className={styles.meterCell}>
                  <Meter percent={row.success_rate * 100} tone="auto-remaining" height={4} />
                  <span className={styles.meterValue}>{formatRatio(row.success_rate)}</span>
                </span>
              </td>
              <td data-mono="true" data-align="right">
                {formatDuration(row.average_latency_ms)}
              </td>
              <td data-mono="true" data-align="right">
                {formatDuration(row.average_ttft_ms)}
              </td>
              <td>
                <span className={styles.meterCell} title={`${formatInt(row.tps_samples)} samples`}>
                  <Meter percent={((row.output_tps ?? 0) / maxTps) * 100} tone="neutral" height={4} />
                  <span className={styles.meterValueWide}>{formatTps(row.output_tps)}</span>
                </span>
              </td>
              <td data-mono="true" data-align="right">
                {formatCompact(row.total_tokens)}
              </td>
              <td data-mono="true" data-align="right">
                {formatCost(row.cost)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
