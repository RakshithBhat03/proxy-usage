import type { CSSProperties } from 'react';
import { formatAge, type ResetDisplay } from '@/lib/quota/parse';
import { quotaLevel } from '@/lib/quota/model';
import type { AccountQuota, PlanInfo } from '@/lib/quota/types';
import styles from './QuotaBits.module.scss';

/**
 * Quota meter: thin track, fill colored by REMAINING (>= 70 green, >= 30 amber, below red);
 * unknown renders an empty track. Fills sweep in once on mount (`index` staggers rows) and glide
 * on refresh.
 */
export function QuotaMeter({ percent, index = 0, size = 'md' }: { percent: number | null; index?: number; size?: 'md' | 'sm' }) {
  const value = percent === null || !Number.isFinite(percent) ? null : Math.min(100, Math.max(0, percent));
  const level = quotaLevel(value);
  const style = { width: `${Math.round((value ?? 0) * 100) / 100}%`, '--meter-index': index } as CSSProperties;
  return (
    <div
      className={`${styles.meter} ${size === 'sm' ? styles.meterSm : ''}`}
      role="meter"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={value ?? undefined}
      aria-label={value === null ? 'Unknown remaining' : `${Math.round(value)}% remaining`}
    >
      <div className={`${styles.fill} ${styles[`fill_${level}`]}`} style={style} />
    </div>
  );
}

/** "10/08, 22:10 · in 2 hours" (cards) or "in 2 hours · 10/08, 22:10" (ledger, relative first). */
export function ResetLabel({ display, soon = false, order = 'absolute-first' }: { display: ResetDisplay; soon?: boolean; order?: 'absolute-first' | 'relative-first' }) {
  const relative = display.relative ? <span className={`${styles.relative} ${soon ? styles.soon : ''}`}>{display.relative}</span> : null;
  const absolute = <span className={styles.absolute}>{display.absolute}</span>;
  return order === 'relative-first' ? (
    <span className={styles.reset}>
      {relative}
      {relative && <span className={styles.sep}>·</span>}
      {absolute}
    </span>
  ) : (
    <span className={styles.reset}>
      {absolute}
      {relative && <span className={styles.sep}>·</span>}
      {relative}
    </span>
  );
}

/** Plan chip: Codex Pro 20x gets the platinum badge, Pro 5x / Max / Ultra the gold one. */
export function PlanBadge({ plan }: { plan: PlanInfo }) {
  const cls = plan.tier === 'elite' ? styles.planElite : plan.tier === 'premium' ? styles.planPremium : styles.planPlain;
  return <span className={cls}>{plan.label}</span>;
}

const SOURCE_LABEL: Record<AccountQuota['source'], string> = {
  live: 'updated',
  signals: 'from traffic',
};

/** "updated 3 min ago" / "from traffic · 12 min ago": cached numbers are never presented as live. */
export function SourceTag({ quota, now, fetching }: { quota: AccountQuota | null; now: number; fetching?: boolean }) {
  if (fetching) return <span className={styles.source}>refreshing…</span>;
  if (!quota || quota.observedAtMs === null) return quota ? <span className={styles.source}>{SOURCE_LABEL[quota.source]}</span> : null;
  const age = formatAge(quota.observedAtMs, now);
  const stale = quota.source !== 'live' || now - quota.observedAtMs > 15 * 60_000;
  const text = quota.source === 'live' ? `updated ${age}` : `${SOURCE_LABEL[quota.source]} · ${age}`;
  return (
    <span className={`${styles.source} ${stale ? styles.sourceStale : ''}`} title={quota.source === 'live' ? 'Read live from the provider' : 'Cached value; refresh to read live'}>
      {text}
    </span>
  );
}
