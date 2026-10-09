import { useState, type MouseEvent, type ReactNode, type SVGProps } from 'react';
import { ProviderIcon } from '@/components/kit';
import { IconCheck, IconCopy } from '@/components/ui/icons';
import type { EventRow } from '@/lib/api/analytics';
import { notify } from '@/stores/notifications';
import { normalizeServiceTier, statusCodeOf, statusTone, type StatusTone } from '../model/events';
import styles from './bits.module.scss';

const TONE_CLASS: Record<StatusTone, string> = {
  ok: 'kit-badge kit-badge--success',
  fail: 'kit-badge kit-badge--failure',
  rate: 'kit-badge kit-badge--amber',
  cancel: 'kit-badge',
};

const TONE_TITLE: Record<StatusTone, string> = {
  ok: 'Success',
  fail: 'Failed',
  rate: 'Rate limited',
  cancel: 'Client cancelled',
};

type StatusFields = Pick<EventRow, 'failed' | 'fail_status_code' | 'fail_summary' | 'header_error_kind'>;

export function StatusBadge({ event, withLabel = false }: { event: StatusFields; withLabel?: boolean }) {
  const tone = statusTone(event);
  const code = statusCodeOf(event);
  return (
    <span className={`${TONE_CLASS[tone]} ${styles.status}`} title={`${TONE_TITLE[tone]}${code ? ` · HTTP ${code}` : ''}`}>
      {code || 'ERR'}
      {withLabel && <span className={styles.statusLabel}>{TONE_TITLE[tone]}</span>}
    </span>
  );
}

export function TierBadge({ tier }: { tier: string | undefined }) {
  const normalized = normalizeServiceTier(tier);
  if (normalized === 'normal') return null;
  return (
    <span className={`kit-badge ${normalized === 'fast' ? 'kit-badge--amber' : ''}`} title={`Service tier: ${tier}`}>
      {normalized}
    </span>
  );
}

export function EffortBadge({ effort }: { effort: string | undefined }) {
  if (!effort) return null;
  return (
    <span className="kit-badge" title={`Reasoning effort: ${effort}`}>
      {effort}
    </span>
  );
}

/** Three descending bars: a streamed (SSE) response. */
export function StreamGlyph(props: SVGProps<SVGSVGElement>) {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-label="Streaming" role="img" {...props}>
      <title>Streaming response</title>
      <path d="M2 3h8M2 6h5.5M2 9h3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

export function CredentialCell({ provider, label }: { provider: string; label: string }) {
  return (
    <span className={styles.credential}>
      <ProviderIcon provider={provider} size={13} />
      <span className={styles.credentialLabel} title={label}>
        {label}
      </span>
    </span>
  );
}

export async function copyText(text: string, what = 'Copied') {
  try {
    await navigator.clipboard.writeText(text);
    notify(what, 'success');
  } catch {
    notify('Copy failed', 'error');
  }
}

export function CopyButton({ value, label = 'Copy', what }: { value: string; label?: string; what?: string }) {
  const [done, setDone] = useState(false);
  const onClick = (event: MouseEvent) => {
    event.stopPropagation();
    void copyText(value, what ?? `${label} copied`).then(() => {
      setDone(true);
      window.setTimeout(() => setDone(false), 1200);
    });
  };
  return (
    <button type="button" className={styles.copy} onClick={onClick} aria-label={label} title={label}>
      {done ? <IconCheck size={12} /> : <IconCopy size={12} />}
    </button>
  );
}

/** Small mono "label value" pill used in sheets and summaries. */
export function Kv({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className={styles.kv}>
      <span className={styles.kvLabel}>{label}</span>
      <span className={styles.kvValue}>{children}</span>
    </div>
  );
}
