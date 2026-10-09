import { Fragment, useMemo, useState } from 'react';
import { Panel, ProviderIcon } from '@/components/kit';
import { IconChevronDown } from '@/components/ui/icons';
import type { CredentialStatRow, CredentialTimelinePoint } from '@/lib/api/analytics';
import { formatCost, formatDuration, formatInt, formatRatio, formatRelative, formatTokens } from '@/lib/format';
import { bucketStarts, type ConcreteBucket } from '@/lib/timeRange';
import { useIdentity } from '@/stores/privacy';
import { Sparkline } from '../charts/Sparkline';
import { credentialLabel, fileProvider } from '../model/derive';
import { QuotaHistoryButton } from '@/features/quotaHistory/QuotaHistoryButton';
import { ShareBar, SortTh, useSorted } from './sortable';
import styles from './panels.module.scss';

type CredKey = 'label' | 'calls' | 'success' | 'tokens' | 'cost' | 'latency' | 'seen';

const ACCESSORS: Record<CredKey, (r: CredentialStatRow) => number | string | null> = {
  label: (r) => credentialLabel(r).toLowerCase(),
  calls: (r) => r.calls,
  success: (r) => (r.calls > 0 ? r.success_rate : null),
  tokens: (r) => r.total_tokens,
  cost: (r) => r.cost,
  latency: (r) => r.average_latency_ms,
  seen: (r) => r.last_seen_ms || null,
};

interface CredentialsPanelProps {
  rows: CredentialStatRow[];
  timeline: CredentialTimelinePoint[];
  fromMs: number;
  toMs: number;
  granularity: 'hour' | 'day';
  selected: string[];
  onToggle: (id: string) => void;
  now: number;
  /** Opens the credential's quota history (right-side sheet). */
  onOpenQuota?: (row: CredentialStatRow) => void;
}

export function credentialProvider(row: Pick<CredentialStatRow, 'auth_provider_snapshot' | 'auth_file_snapshot' | 'id'>) {
  return row.auth_provider_snapshot || fileProvider(row.auth_file_snapshot || row.id);
}

export function CredentialsPanel({ rows, timeline, fromMs, toMs, granularity, selected, onToggle, now, onOpenQuota }: CredentialsPanelProps) {
  const identity = useIdentity();
  const [expanded, setExpanded] = useState<string | null>(null);
  const sort = useSorted(rows, ACCESSORS, 'calls');
  const totalCost = rows.reduce((s, r) => s + r.cost, 0);

  // Sparkline per credential: zero-filled at the server granularity.
  const series = useMemo(() => {
    const size: ConcreteBucket = granularity === 'day' ? '1d' : '1h';
    const starts = bucketStarts(fromMs, toMs, size);
    const index = new Map(starts.map((s, i) => [s, i]));
    const map = new Map<string, number[]>();
    for (const point of timeline) {
      let arr = map.get(point.id);
      if (!arr) {
        arr = new Array(starts.length).fill(0);
        map.set(point.id, arr);
      }
      const i = index.get(point.bucket_ms);
      if (i !== undefined) arr[i] += point.calls;
    }
    return map;
  }, [timeline, fromMs, toMs, granularity]);

  return (
    <Panel flush title="Credentials" subtitle={`${rows.length} credentials · trend per ${granularity} · click to filter`} data-reveal>
      {rows.length === 0 ? (
        <div className="kit-empty">No credential traffic in this range</div>
      ) : (
        <div className="kit-table-wrap">
          <table className={`kit-table ${styles.table}`}>
            <thead>
              <tr>
                <th aria-label="Expand" className={styles.expandCol} />
                <SortTh id="label" label="Credential" sort={sort} align="left" />
                <th className={styles.trendCol}>Trend</th>
                <SortTh id="calls" label="Requests" sort={sort} />
                <SortTh id="success" label="Success" sort={sort} />
                <SortTh id="tokens" label="Tokens" sort={sort} />
                <SortTh id="cost" label="Cost" sort={sort} />
                <th className={styles.shareCol}>Share</th>
                <SortTh id="latency" label="Latency" sort={sort} />
                <SortTh id="seen" label="Last seen" sort={sort} />
              </tr>
            </thead>
            <tbody>
              {sort.sorted.map((r) => {
                const active = selected.includes(r.id);
                const open = expanded === r.id;
                const share = totalCost > 0 ? r.cost / totalCost : 0;
                const failing = r.calls > 0 && r.success_rate < 0.97;
                return (
                  <Fragment key={r.id}>
                    <tr className={active ? styles.rowActive : undefined}>
                      <td className={styles.expandCol}>
                        {(r.models?.length ?? 0) > 0 && (
                          <button
                            type="button"
                            className={`${styles.expand} ${open ? styles.expandOpen : ''}`}
                            onClick={() => setExpanded(open ? null : r.id)}
                            aria-expanded={open}
                            aria-label="Show models"
                          >
                            <IconChevronDown size={13} />
                          </button>
                        )}
                      </td>
                      <td>
                        <button type="button" className={styles.entity} onClick={() => onToggle(r.id)} title={active ? 'Remove credential filter' : 'Filter to this credential'}>
                          <ProviderIcon provider={credentialProvider(r)} size={13} />
                          <span className={styles.entityStack}>
                            <span className={styles.entityName}>{identity(credentialLabel(r))}</span>
                            {r.auth_file_snapshot && r.auth_file_snapshot !== credentialLabel(r) && (
                              <span className={styles.entitySub}>{identity(r.auth_file_snapshot)}</span>
                            )}
                          </span>
                        </button>
                        {onOpenQuota && <QuotaHistoryButton onClick={() => onOpenQuota(r)} />}
                      </td>
                      <td className={styles.trendCol}>
                        <Sparkline points={series.get(r.id) ?? []} color={failing ? 'var(--viz-failure)' : 'var(--viz-success)'} ariaLabel="Requests trend" />
                      </td>
                      <td data-align="right" data-mono="true">{formatInt(r.calls)}</td>
                      <td data-align="right" data-mono="true" className={failing ? styles.warnText : undefined}>
                        {r.calls > 0 ? formatRatio(r.success_rate) : '--'}
                      </td>
                      <td data-align="right" data-mono="true">{formatTokens(r.total_tokens)}</td>
                      <td data-align="right" data-mono="true" className={styles.strong}>{formatCost(r.cost)}</td>
                      <td className={styles.shareCol}>
                        <span className={styles.shareCell}>
                          <ShareBar value={share} />
                          <span>{formatRatio(share, 0)}</span>
                        </span>
                      </td>
                      <td data-align="right" data-mono="true">{formatDuration(r.average_latency_ms)}</td>
                      <td data-align="right" data-mono="true" title={r.last_seen_ms ? new Date(r.last_seen_ms).toLocaleString() : undefined}>
                        {r.last_seen_ms ? formatRelative(r.last_seen_ms, now) : '--'}
                      </td>
                    </tr>
                    {open && (
                      <tr className={styles.detailRow}>
                        <td />
                        <td colSpan={9}>
                          <div className={styles.subGrid}>
                            {(r.models ?? [])
                              .slice()
                              .sort((a, b) => b.cost - a.cost)
                              .map((m) => (
                                <div key={m.model} className={styles.subItem}>
                                  <span className={styles.entityName}>{m.model}</span>
                                  <span className={styles.subStats}>
                                    {formatInt(m.calls)} req · {formatTokens(m.total_tokens)} tok · {formatCost(m.cost)} ·{' '}
                                    <span className={m.success_rate < 0.97 ? styles.warnText : undefined}>{formatRatio(m.success_rate)}</span> ok · cache{' '}
                                    {formatRatio(m.cache_hit_rate)}
                                  </span>
                                </div>
                              ))}
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}
