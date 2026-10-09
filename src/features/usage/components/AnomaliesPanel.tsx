import { useState } from 'react';
import { Panel } from '@/components/kit';
import type { AnomalyPoint } from '@/lib/api/analytics';
import { formatCost, formatInt, formatRatio, formatTokens } from '@/lib/format';
import { ANOMALY_LABELS, anomalyChange, formatAnomalyChange } from '../model/derive';
import styles from './panels.module.scss';

const pad = (n: number) => String(n).padStart(2, '0');
function spanLabel(a: AnomalyPoint) {
  const s = new Date(a.bucket_ms);
  const e = new Date(a.bucket_end_ms);
  const day = `${pad(s.getMonth() + 1)}/${pad(s.getDate())}`;
  return a.bucket_end_ms - a.bucket_ms >= 86_400_000 - 3_600_000
    ? day
    : `${day} ${pad(s.getHours())}:${pad(s.getMinutes())}–${pad(e.getHours())}:${pad(e.getMinutes())}`;
}

const SEVERITY_CLASS = { high: 'kit-badge kit-badge--failure', medium: 'kit-badge kit-badge--amber', low: 'kit-badge' } as const;

/** Server-flagged buckets that jumped vs the previous one. Clicking zooms the range into the bucket. */
export function AnomaliesPanel({ points, onZoom }: { points: AnomalyPoint[]; onZoom: (from: number, to: number) => void }) {
  const [showAll, setShowAll] = useState(false);
  const sorted = [...points].sort((a, b) => b.bucket_ms - a.bucket_ms);
  const visible = showAll ? sorted : sorted.slice(0, 6);
  return (
    <Panel
      flush
      title="Anomalies"
      subtitle={`${points.length} buckets changed sharply vs the bucket before · click to zoom in`}
      data-reveal
    >
      {points.length === 0 ? (
        <div className="kit-empty">Nothing unusual in this range</div>
      ) : (
        <>
          <ul className={styles.anomalyList}>
            {visible.map((a) => (
              <li key={a.bucket_ms}>
                <button type="button" className={styles.anomaly} onClick={() => onZoom(a.bucket_ms, a.bucket_end_ms)}>
                  <span className={styles.anomalyHead}>
                    <span className={SEVERITY_CLASS[a.severity]}>{a.severity}</span>
                    <span className={styles.anomalyTime}>{spanLabel(a)}</span>
                  </span>
                  <span className={styles.anomalyTags}>
                    {a.metric_keys.map((key) => (
                      <span key={key} className={styles.anomalyTag}>
                        {ANOMALY_LABELS[key]} <b>{formatAnomalyChange(key, anomalyChange(a, key))}</b>
                      </span>
                    ))}
                  </span>
                  <span className={styles.anomalyStats}>
                    {formatInt(a.calls)} req · {formatTokens(a.total_tokens)} tok · {formatCost(a.cost)}
                    {a.failure_rate > 0 && <span className="kit-tone-attention"> · {formatRatio(a.failure_rate)} failed</span>}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {sorted.length > 6 && (
            <button type="button" className={styles.more} onClick={() => setShowAll((v) => !v)}>
              {showAll ? 'Show fewer' : `Show all ${sorted.length}`}
            </button>
          )}
        </>
      )}
    </Panel>
  );
}
