import { useMemo } from 'react';
import { Meter } from '@/components/kit';
import { Skeleton } from '@/components/ui/Skeleton';
import type { EventRow, FailureSourceRow } from '@/lib/api/analytics';
import { formatClock, formatDuration, formatInt, formatRatio, formatRelative, formatStamp } from '@/lib/format';
import { normalizeProvider } from '@/lib/providers';
import { classifyFailure, eventKey, FAILURE_CLASS_LABELS, statusCodeOf, type FailureClass } from '../model/events';
import type { RowDecor } from './RequestTable';
import { CredentialCell, StatusBadge } from './bits';
import styles from './views.module.scss';

interface FailuresViewProps {
  events: EventRow[] | undefined;
  totalFailures: number;
  sources: FailureSourceRow[] | undefined;
  loading: boolean;
  error: string | null;
  decor: RowDecor;
  labelOf: (row: { auth_index?: string; account_snapshot?: string; auth_label_snapshot?: string; source?: string }) => string;
  onOpen: (event: EventRow, list: EventRow[]) => void;
}

const CLASS_ORDER: FailureClass[] = [
  'rate_limit',
  'upstream_5xx',
  'client_cancel',
  'overloaded',
  'timeout',
  'auth',
  'bad_request',
  'other',
];

export function FailuresView({ events, totalFailures, sources, loading, error, decor, labelOf, onOpen }: FailuresViewProps) {
  const breakdown = useMemo(() => {
    const byClass = new Map<FailureClass, number>();
    const byCode = new Map<string, { code: number; kind: string; count: number }>();
    for (const event of events ?? []) {
      const cls = classifyFailure(event);
      byClass.set(cls, (byClass.get(cls) ?? 0) + 1);
      const code = statusCodeOf(event);
      const kind = event.header_error_kind ?? '';
      const key = `${code}|${kind}`;
      const entry = byCode.get(key) ?? { code, kind, count: 0 };
      entry.count += 1;
      byCode.set(key, entry);
    }
    const classes = CLASS_ORDER.map((id) => ({ id, count: byClass.get(id) ?? 0 })).filter((c) => c.count > 0);
    const codes = Array.from(byCode.values()).sort((a, b) => b.count - a.count);
    return { classes, codes, sample: events?.length ?? 0 };
  }, [events]);

  if (error) return <div className="kit-error-banner">Could not load failures: {error}</div>;

  if (!events) {
    return (
      <div className={styles.grid2}>
        <Skeleton height={180} rounded={12} />
        <Skeleton height={180} rounded={12} />
      </div>
    );
  }

  if (events.length === 0) {
    return (
      <div className={styles.calm}>
        <span className={styles.calmDot} aria-hidden="true" />
        No failed requests in this window{loading ? '…' : '.'}
      </div>
    );
  }

  const maxClass = Math.max(...breakdown.classes.map((c) => c.count), 1);
  const sortedSources = (sources ?? []).slice(0, 12);

  return (
    <div className={styles.view}>
      {totalFailures > breakdown.sample && (
        <p className={styles.note}>
          Breakdown uses the newest {formatInt(breakdown.sample)} of {formatInt(totalFailures)} failures.
        </p>
      )}
      <div className={styles.grid2}>
        <div className={styles.block}>
          <h3 className={styles.blockTitle}>By cause</h3>
          <div className={styles.bars}>
            {breakdown.classes.map((c) => (
              <div key={c.id} className={styles.barRow} title={FAILURE_CLASS_LABELS[c.id].hint}>
                <span className={styles.barLabel}>{FAILURE_CLASS_LABELS[c.id].label}</span>
                <span className={styles.barTrack}>
                  <span
                    className={`${styles.barFill} ${c.id === 'rate_limit' ? styles.barAmber : c.id === 'client_cancel' ? styles.barNeutral : ''}`}
                    style={{ width: `${(c.count / maxClass) * 100}%` }}
                  />
                </span>
                <span className={styles.barValue}>{formatInt(c.count)}</span>
                <span className={styles.barShare}>{formatRatio(c.count / breakdown.sample, 0)}</span>
              </div>
            ))}
          </div>
        </div>
        <div className={styles.block}>
          <h3 className={styles.blockTitle}>By status code</h3>
          <div className={styles.codes}>
            {breakdown.codes.map((c) => (
              <div key={`${c.code}|${c.kind}`} className={styles.codeRow}>
                <StatusBadge event={{ failed: true, fail_status_code: c.code || undefined, header_error_kind: c.kind || undefined }} />
                <span className={styles.codeKind}>{c.kind ? c.kind.replace(/_/g, ' ') : c.code >= 500 ? 'upstream' : c.code === 499 ? 'client cancelled' : 'http'}</span>
                <span className={styles.barValue}>{formatInt(c.count)}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {sortedSources.length > 0 && (
        <div className={styles.block}>
          <h3 className={styles.blockTitle}>Failing credentials</h3>
          <div className="kit-table-wrap">
            <table className={`kit-table ${styles.table}`}>
              <thead>
                <tr>
                  <th>Credential</th>
                  <th data-align="right">Failures</th>
                  <th>Failure rate</th>
                  <th data-align="right">Avg latency</th>
                  <th data-align="right">Last seen</th>
                </tr>
              </thead>
              <tbody>
                {sortedSources.map((row) => {
                  const rate = row.calls > 0 ? row.failure / row.calls : 0;
                  return (
                    <tr key={`${row.source_hash}|${row.auth_index}`}>
                      <td>
                        <CredentialCell provider={normalizeProvider(row.auth_provider_snapshot)} label={labelOf(row)} />
                      </td>
                      <td data-mono="true" data-align="right">
                        {formatInt(row.failure)} <span className={styles.dimText}>/ {formatInt(row.calls)}</span>
                      </td>
                      <td>
                        <span className={styles.meterCell}>
                          <Meter percent={rate * 100} tone="attention" height={4} />
                          <span className={styles.meterValue}>{formatRatio(rate)}</span>
                        </span>
                      </td>
                      <td data-mono="true" data-align="right">
                        {formatDuration(row.average_latency_ms)}
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
        </div>
      )}

      <div className={styles.block}>
        <h3 className={styles.blockTitle}>Recent failures</h3>
        <ul className={styles.failList}>
          {events.slice(0, 40).map((event) => {
            const { label, provider } = decor.credential(event);
            return (
              <li key={eventKey(event)}>
                <button type="button" className={styles.failItem} onClick={() => onOpen(event, events)}>
                  <span className={styles.failTime}>{formatClock(event.timestamp_ms)}</span>
                  <StatusBadge event={event} />
                  <span className={styles.failModel}>{event.model}</span>
                  <span className={styles.failCred}>
                    <CredentialCell provider={provider} label={label} />
                  </span>
                  <span className={styles.failSummary}>{event.fail_summary ? decor.scrub(event.fail_summary) : '—'}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
