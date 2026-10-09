import { useMemo } from 'react';
import { Meter } from '@/components/kit';
import { Skeleton } from '@/components/ui/Skeleton';
import type { CredentialStatRow, EventRow } from '@/lib/api/analytics';
import { formatCompact, formatCost, formatDuration, formatInt, formatRatio, formatRelative, formatStamp } from '@/lib/format';
import { normalizeProvider } from '@/lib/providers';
import { eventKey } from '../model/events';
import { CredentialCell } from './bits';
import styles from './views.module.scss';

interface CredentialsViewProps {
  rows: CredentialStatRow[] | undefined;
  loading: boolean;
  error: string | null;
  /** Loaded stream rows, for the per-credential recent-outcome strip. */
  recent: EventRow[];
  labelOf: (row: CredentialStatRow) => string;
  onFilter: (authIndex: string) => void;
}

const STRIP = 16;

export function CredentialsView({ rows, loading, error, recent, labelOf, onFilter }: CredentialsViewProps) {
  const strips = useMemo(() => {
    const map = new Map<string, EventRow[]>();
    for (const event of recent) {
      const list = map.get(event.auth_index) ?? [];
      if (list.length < STRIP) {
        list.push(event);
        map.set(event.auth_index, list);
      }
    }
    return map;
  }, [recent]);

  if (error) return <div className="kit-error-banner">Could not load credential health: {error}</div>;
  if (!rows) return <Skeleton height={220} rounded={12} />;
  if (rows.length === 0) return <div className="kit-empty">No credential traffic in this window{loading ? '…' : '.'}</div>;

  const sorted = rows.slice().sort((a, b) => b.calls - a.calls || b.last_seen_ms - a.last_seen_ms);

  return (
    <div className="kit-table-wrap">
      <table className={`kit-table ${styles.table}`}>
        <thead>
          <tr>
            <th>Credential</th>
            <th data-align="right">Requests</th>
            <th>Success rate</th>
            <th data-align="right">Failures</th>
            <th data-align="right">Avg latency</th>
            <th data-align="right">Tokens</th>
            <th data-align="right">Cost</th>
            <th>Recent</th>
            <th data-align="right">Last seen</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((row) => {
            const strip = row.auth_index ? (strips.get(row.auth_index) ?? []) : [];
            return (
              <tr
                key={row.id}
                className={row.auth_index ? styles.clickable : undefined}
                onClick={row.auth_index ? () => onFilter(row.auth_index!) : undefined}
                title={row.auth_index ? 'Filter the stream to this credential' : undefined}
              >
                <td>
                  <CredentialCell provider={normalizeProvider(row.auth_provider_snapshot)} label={labelOf(row)} />
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
                <td data-mono="true" data-align="right" className={row.failure_calls > 0 ? styles.failText : undefined}>
                  {formatInt(row.failure_calls)}
                </td>
                <td data-mono="true" data-align="right">
                  {formatDuration(row.average_latency_ms)}
                </td>
                <td data-mono="true" data-align="right">
                  {formatCompact(row.total_tokens)}
                </td>
                <td data-mono="true" data-align="right">
                  {formatCost(row.cost)}
                </td>
                <td>
                  <span className={styles.strip} aria-label="Recent outcomes, oldest to newest">
                    {strip
                      .slice()
                      .reverse()
                      .map((e) => (
                        <span key={eventKey(e)} className={`${styles.stripCell} ${e.failed ? styles.stripFail : ''}`} />
                      ))}
                    {strip.length === 0 && <span className={styles.dimText}>–</span>}
                  </span>
                </td>
                <td data-mono="true" data-align="right" title={formatStamp(row.last_seen_ms)}>
                  {formatRelative(row.last_seen_ms)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
