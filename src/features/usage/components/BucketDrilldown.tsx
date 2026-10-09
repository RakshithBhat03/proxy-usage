import { Link } from 'react-router-dom';
import { PillButton } from '@/components/kit';
import { Skeleton } from '@/components/ui/Skeleton';
import { IconX } from '@/components/ui/icons';
import { IconArrowUpRight } from '@/components/ui/extraIcons';
import type { AnalyticsResponse } from '@/lib/api/analytics';
import { formatClock, formatCost, formatDuration, formatInt, formatRatio, formatTokens, formatTps } from '@/lib/format';
import { eventOutputTps, estimateEventCost, type PriceBook } from '@/lib/pricing';
import { useIdentity } from '@/stores/privacy';
import type { ConcreteBucket } from '@/lib/timeRange';
import { bucketTitle } from '../charts/TimelineChart';
import type { ChartBucket } from '../model/timeline';
import styles from './panels.module.scss';

interface BucketDrilldownProps {
  bucket: ChartBucket;
  size: ConcreteBucket;
  data: AnalyticsResponse | undefined;
  loading: boolean;
  error: Error | null;
  prices: PriceBook;
  onClose: () => void;
  onZoom: () => void;
  requestsHref: string;
}

/** Inline detail strip for a clicked chart bucket: its numbers plus the newest 20 requests. */
export function BucketDrilldown({ bucket, size, data, loading, error, prices, onClose, onZoom, requestsHref }: BucketDrilldownProps) {
  const identity = useIdentity();
  const items = data?.drilldown_preview?.items ?? [];
  const s = data?.summary;
  return (
    <div className={styles.drill}>
      <div className={styles.drillHead}>
        <div>
          <div className={styles.drillTitle}>{bucketTitle(bucket.start, bucket.end, size)}</div>
          <div className={styles.drillMeta}>
            {formatInt(bucket.calls)} requests · {formatRatio(bucket.calls ? bucket.success / bucket.calls : null)} success ·{' '}
            {formatTokens(bucket.totalTokens)} tokens · {formatCost(bucket.cost)}
            {s?.p95_latency_ms ? ` · p95 ${formatDuration(s.p95_latency_ms)}` : ''}
          </div>
        </div>
        <div className={styles.drillActions}>
          <PillButton onClick={onZoom}>Zoom to bucket</PillButton>
          <Link className="kit-pill-button" to={requestsHref}>
            Request Monitor <IconArrowUpRight size={12} />
          </Link>
          <button type="button" className={styles.iconButton} onClick={onClose} aria-label="Close bucket details">
            <IconX size={14} />
          </button>
        </div>
      </div>
      {error ? (
        <div className="kit-error-banner">{error.message}</div>
      ) : loading && items.length === 0 ? (
        <div className={styles.drillSkeleton}>
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} height={18} />
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="kit-empty">No requests in this bucket</div>
      ) : (
        <div className="kit-table-wrap">
          <table className={`kit-table ${styles.table}`}>
            <thead>
              <tr>
                <th>Time</th>
                <th>Model</th>
                <th>Credential</th>
                <th data-align="right">In / out</th>
                <th data-align="right">Latency</th>
                <th data-align="right">TTFT</th>
                <th data-align="right">Speed</th>
                <th data-align="right">Cost</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {items.map((e) => {
                const cost = estimateEventCost(prices, e);
                return (
                  <tr key={e.event_hash}>
                    <td data-mono="true">{formatClock(e.timestamp_ms)}</td>
                    <td>
                      {e.analytics_model || e.model}
                      {e.service_tier && !['auto', 'default', 'standard', ''].includes(e.service_tier) && (
                        <span className="kit-badge" style={{ marginLeft: 6 }}>
                          {e.service_tier}
                        </span>
                      )}
                    </td>
                    <td className={styles.dim}>{identity(e.auth_label_snapshot || e.account_snapshot || e.source) || '--'}</td>
                    <td data-align="right" data-mono="true">
                      {formatTokens(e.input_tokens)} / {formatTokens(e.output_tokens)}
                    </td>
                    <td data-align="right" data-mono="true">{formatDuration(e.latency_ms)}</td>
                    <td data-align="right" data-mono="true">{formatDuration(e.ttft_ms)}</td>
                    <td data-align="right" data-mono="true">{formatTps(eventOutputTps(e))}</td>
                    <td data-align="right" data-mono="true">{cost === null ? '--' : formatCost(cost)}</td>
                    <td>
                      {e.failed ? (
                        <span className="kit-badge kit-badge--failure" title={e.fail_summary}>
                          {e.fail_status_code ?? 'failed'}
                          {e.fail_summary ? ` · ${e.fail_summary.slice(0, 40)}` : ''}
                        </span>
                      ) : (
                        <span className="kit-badge kit-badge--success">{e.fail_status_code ?? 200}</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
