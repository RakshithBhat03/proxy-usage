import { useEffect, useRef, type ReactNode } from 'react';
import { Meter } from '@/components/kit';
import { Sheet } from '@/components/ui/Sheet';
import { IconChevronDown, IconChevronUp, IconCopy } from '@/components/ui/icons';
import type { EventRow, ResponseHeaderMetadata, ResponseHeaderQuotaWindow } from '@/lib/api/analytics';
import {
  formatCompact,
  formatCost,
  formatDuration,
  formatInt,
  formatPercent,
  formatRatio,
  formatRelative,
  formatStamp,
  formatTps,
} from '@/lib/format';
import { eventGenerationTps, eventOutputTps, type PriceBook } from '@/lib/pricing';
import { providerLabel } from '@/lib/providers';
import { TOKEN_COLORS } from '@/lib/tokenColors';
import { costBreakdown } from '../model/cost';
import { cacheHitRate, classifyFailure, eventKey, FAILURE_CLASS_LABELS, statusCodeOf } from '../model/events';
import type { RowDecor } from './RequestTable';
import { CopyButton, CredentialCell, EffortBadge, Kv, StatusBadge, StreamGlyph, TierBadge, copyText } from './bits';
import styles from './RequestDetailSheet.module.scss';

interface RequestDetailSheetProps {
  open: boolean;
  /** Kept after closing so the sheet can animate out with its content. */
  event: EventRow | null;
  index: number;
  count: number;
  onClose: () => void;
  onPrev: () => void;
  onNext: () => void;
  decor: RowDecor;
  prices: PriceBook | undefined;
  /** Identity masker (emails) — identity when "show emails" is on. */
  mask: (value: string | null | undefined) => string;
  showEmails: boolean;
  /** Other loaded requests on the same credential, newest first. */
  siblings: EventRow[];
}

function Section({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className={styles.section}>
      <div className={styles.sectionHead}>
        <h3 className={styles.sectionTitle}>{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

function windowLabel(minutes: number | undefined) {
  if (!minutes) return 'Window';
  if (minutes % 1440 === 0) return `${minutes / 1440}d window`;
  if (minutes % 60 === 0) return `${minutes / 60}h window`;
  return `${minutes}m window`;
}

function QuotaWindowRow({ name, win }: { name: string; win: ResponseHeaderQuotaWindow }) {
  const used = win.used_percent ?? null;
  return (
    <div className={styles.quotaRow}>
      <div className={styles.quotaHead}>
        <span className={styles.quotaName}>
          {name} <span className={styles.dim}>{windowLabel(win.window_minutes)}</span>
        </span>
        <span className={styles.mono}>{used !== null ? `${formatPercent(used, 0)} used` : '--'}</span>
      </div>
      <Meter percent={used} tone="auto-used" height={5} />
      {win.reset_at_ms ? (
        <span className={styles.dim}>
          resets {formatRelative(win.reset_at_ms)} · {formatStamp(win.reset_at_ms)}
        </span>
      ) : null}
    </div>
  );
}

function HeaderMetadata({ meta, mask }: { meta: ResponseHeaderMetadata; mask: (v: string) => string }) {
  const { quota, errors, trace, routing, response, rate_limit: rate, data_policy: policy, provider_usage: usage } = meta;
  const traceIds = Object.entries(trace ?? {}).filter(([, v]) => typeof v === 'string' && v);
  const routingEntries = Object.entries({ ...(routing ?? {}), ...(response ?? {}) }).filter(
    ([, v]) => v !== undefined && v !== '' && v !== null,
  );
  return (
    <div className={styles.stack}>
      {quota && (quota.primary || quota.secondary || quota.plan_type) && (
        <div className={styles.card}>
          <div className={styles.cardHead}>
            <span>Quota</span>
            <span className={styles.badges}>
              {quota.plan_type && <span className="kit-badge">{quota.plan_type}</span>}
              {quota.active_limit && <span className="kit-badge">{quota.active_limit}</span>}
              {quota.reached_window_kind && <span className="kit-badge kit-badge--failure">reached · {quota.reached_window_kind}</span>}
            </span>
          </div>
          {quota.primary && <QuotaWindowRow name="Primary" win={quota.primary} />}
          {quota.secondary && <QuotaWindowRow name="Secondary" win={quota.secondary} />}
          {(quota.credits_balance !== undefined || quota.credits_unlimited) && (
            <span className={styles.dim}>
              Credits {quota.credits_unlimited ? 'unlimited' : (quota.credits_balance ?? '--')}
              {quota.credits_has_credits === false && !quota.credits_unlimited ? ' · none left' : ''}
            </span>
          )}
          {quota.recover_at_ms ? <span className={styles.dim}>Recovers {formatRelative(quota.recover_at_ms)}</span> : null}
        </div>
      )}

      {rate && (rate.requests || rate.tokens) && (
        <div className={styles.card}>
          <div className={styles.cardHead}>
            <span>Rate limits</span>
          </div>
          {(['requests', 'tokens'] as const).map((key) => {
            const bucket = rate[key];
            if (!bucket || bucket.limit === undefined) return null;
            const remaining = bucket.remaining ?? 0;
            const pct = bucket.limit > 0 ? (remaining / bucket.limit) * 100 : null;
            return (
              <div key={key} className={styles.quotaRow}>
                <div className={styles.quotaHead}>
                  <span className={styles.quotaName}>{key === 'requests' ? 'Requests' : 'Tokens'}</span>
                  <span className={styles.mono}>
                    {formatCompact(remaining)} / {formatCompact(bucket.limit)} left
                  </span>
                </div>
                <Meter percent={pct} tone="auto-remaining" height={5} />
              </div>
            );
          })}
        </div>
      )}

      {errors && (errors.retry_after_seconds || errors.should_retry !== undefined || errors.code || errors.authorization_error) && (
        <div className={styles.kvGrid}>
          {errors.kind && <Kv label="Error kind">{errors.kind}</Kv>}
          {errors.code && <Kv label="Error code">{errors.code}</Kv>}
          {errors.retry_after_seconds ? (
            <Kv label="Retry after">
              {formatDuration(errors.retry_after_seconds * 1000)}
              {errors.retry_after_recover_at_ms ? ` · ${formatStamp(errors.retry_after_recover_at_ms)}` : ''}
            </Kv>
          ) : null}
          {errors.should_retry !== undefined && <Kv label="Should retry">{errors.should_retry ? 'yes' : 'no'}</Kv>}
          {errors.authorization_error && <Kv label="Authorization">{errors.authorization_error}</Kv>}
          {errors.ide_error_code && <Kv label="IDE error">{errors.ide_error_code}</Kv>}
          {errors.rate_limit_bypass && <Kv label="Bypass">{errors.rate_limit_bypass}</Kv>}
        </div>
      )}

      {usage && (usage.limit !== undefined || usage.state) && (
        <div className={styles.kvGrid}>
          {usage.state && <Kv label="Provider usage">{usage.state}</Kv>}
          {usage.limit !== undefined && (
            <Kv label="Used / limit">
              {formatCompact(usage.actual)} / {formatCompact(usage.limit)} {usage.unit ?? ''}
            </Kv>
          )}
          {usage.recover_at_ms ? <Kv label="Recovers">{formatRelative(usage.recover_at_ms)}</Kv> : null}
        </div>
      )}

      {traceIds.length > 0 && (
        <div className={styles.idList}>
          {traceIds.map(([key, value]) => (
            <div key={key} className={styles.idRow}>
              <span className={styles.idKey}>{key.replace(/_/g, ' ')}</span>
              <span className={styles.idValue}>{String(value)}</span>
              <CopyButton value={String(value)} label={`Copy ${key}`} what="Trace id copied" />
            </div>
          ))}
        </div>
      )}

      {(routingEntries.length > 0 || policy) && (
        <div className={styles.kvGrid}>
          {routingEntries.map(([key, value]) => (
            <Kv key={key} label={key.replace(/_/g, ' ')}>
              {mask(String(value))}
            </Kv>
          ))}
          {policy?.retention_mode && <Kv label="Retention">{policy.retention_mode}</Kv>}
          {policy?.zero_retention !== undefined && <Kv label="Zero retention">{policy.zero_retention ? 'yes' : 'no'}</Kv>}
        </div>
      )}
    </div>
  );
}

export function RequestDetailSheet({
  open,
  event,
  index,
  count,
  onClose,
  onPrev,
  onNext,
  decor,
  prices,
  mask,
  showEmails,
  siblings,
}: RequestDetailSheetProps) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const currentKey = event ? eventKey(event) : '';
  // Stepping to another request starts at the top of the sheet.
  useEffect(() => {
    bodyRef.current?.parentElement?.scrollTo({ top: 0 });
  }, [currentKey]);

  // ↑/↓ (and k/j) step through the visible list while the sheet is open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return;
      if (e.key === 'ArrowUp' || e.key === 'k') {
        e.preventDefault();
        onPrev();
      } else if (e.key === 'ArrowDown' || e.key === 'j') {
        e.preventDefault();
        onNext();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onPrev, onNext]);

  if (!event) return <Sheet open={false} onClose={onClose} />;

  const { label, provider } = decor.credential(event);
  const breakdown = costBreakdown(prices, event);
  const latency = event.latency_ms ?? 0;
  const ttft = event.ttft_ms ?? 0;
  const ttftPct = latency > 0 && ttft > 0 ? Math.min(100, (ttft / latency) * 100) : 0;
  const outTps = eventOutputTps(event);
  const genTps = eventGenerationTps(event);
  const code = statusCodeOf(event);
  const failureClass = event.failed ? classifyFailure(event) : null;
  const tokenMax = Math.max(1, ...breakdown.parts.filter((p) => !p.included).map((p) => p.tokens));
  const ip = (value: string | undefined) => (value ? (showEmails ? value : decor.scrub(value)) : '');
  const models = [event.requested_model, event.resolved_model, event.response_model].filter(
    (m, i, all): m is string => !!m && all.indexOf(m) === i,
  );

  const json = () => {
    const raw = JSON.stringify(event, null, 2);
    return showEmails ? raw : decor.scrub(mask(raw));
  };

  const meta: Array<[string, ReactNode, string?]> = [
    ['Request id', event.request_id, event.request_id],
    ['Event hash', event.event_hash, event.event_hash],
    ['Endpoint', event.endpoint],
    ['Method · path', `${event.method || '-'} ${event.path || ''}`],
    ['Stream', event.stream ? 'yes' : 'no'],
    ['Generate', event.generate === undefined ? undefined : event.generate ? 'yes' : 'no'],
    ['Service tier', event.service_tier],
    ['Reasoning effort', event.reasoning_effort],
    ['Executor', event.executor_type],
    ['Models', models.length > 1 ? models.join(' → ') : undefined],
    ['Session', event.session_id, event.session_id],
    ['Parent session', event.parent_session_id, event.parent_session_id],
    ['Client IP', ip(event.client_ip) || undefined],
    ['X-Forwarded-For', ip(event.x_forwarded_for) || undefined],
    ['User agent', event.user_agent],
    ['Auth index', event.auth_index, event.auth_index],
    ['Auth file', event.auth_file_snapshot ? mask(event.auth_file_snapshot) : undefined],
    ['Project', event.auth_project_id_snapshot ? mask(event.auth_project_id_snapshot) : undefined],
    ['API key hash', event.api_key_hash ? `${event.api_key_hash.slice(0, 16)}…` : undefined, event.api_key_hash || undefined],
  ];

  return (
    <Sheet
      open={open}
      onClose={onClose}
      size="lg"
      eyebrow={
        <span className={styles.eyebrow}>
          {formatStamp(event.timestamp_ms)} · {new Date(event.timestamp_ms).toLocaleTimeString([], { hour12: false })} ·{' '}
          {formatRelative(event.timestamp_ms)}
        </span>
      }
      title={
        <span className={styles.title}>
          <StatusBadge event={event} withLabel />
          <span className={styles.titleModel}>{event.model || 'Unknown model'}</span>
        </span>
      }
      description={
        <span className={styles.subline}>
          <CredentialCell provider={provider} label={label} />
          <span className={styles.dot}>·</span>
          <span>{providerLabel(provider)}</span>
          {event.stream && <StreamGlyph className={styles.streamIcon} />}
          <EffortBadge effort={event.reasoning_effort} />
          <TierBadge tier={event.service_tier} />
        </span>
      }
      footer={
        <div className={styles.footer}>
          <div className={styles.nav}>
            <button type="button" className={styles.navButton} onClick={onPrev} disabled={index <= 0} aria-label="Newer request">
              <IconChevronUp size={14} />
            </button>
            <button
              type="button"
              className={styles.navButton}
              onClick={onNext}
              disabled={index >= count - 1}
              aria-label="Older request"
            >
              <IconChevronDown size={14} />
            </button>
            <span className={styles.navCount}>
              {index + 1} / {formatInt(count)}
            </span>
            <span className={styles.navHint}>↑ ↓ to step</span>
          </div>
          <button type="button" className="kit-pill-button" onClick={() => void copyText(json(), 'Request JSON copied')}>
            <span className="kit-pill-button__icon">
              <IconCopy size={12} />
            </span>
            Copy JSON
          </button>
        </div>
      }
    >
      <div className={styles.body} key={currentKey} ref={bodyRef}>
        <Section
          title="Timing"
          aside={<span className={styles.mono}>{formatDuration(event.latency_ms)} total</span>}
        >
          <div className={styles.timing}>
            <div className={`${styles.timingBar} ${event.failed ? styles.timingFailed : ''}`}>
              {ttftPct > 0 && <span className={styles.timingTtft} style={{ width: `${ttftPct}%` }} />}
              <span className={styles.timingGen} />
            </div>
            <div className={styles.timingLabels}>
              {ttftPct > 0 ? (
                <>
                  <span>
                    <i className={`${styles.legendDot} ${styles.legendTtft}`} />
                    TTFT <b>{formatDuration(ttft)}</b>
                  </span>
                  <span>
                    <i className={`${styles.legendDot} ${event.failed ? styles.legendFail : styles.legendGen}`} />
                    Generation <b>{formatDuration(Math.max(latency - ttft, 0))}</b>
                  </span>
                </>
              ) : (
                <span className={styles.dim}>No time-to-first-token recorded</span>
              )}
            </div>
          </div>
          <div className={styles.kvGrid}>
            <Kv label="Output TPS">{formatTps(outTps)}</Kv>
            <Kv label="Generation TPS">{formatTps(genTps)}</Kv>
            <Kv label="Cache hit">{formatRatio(cacheHitRate(event))}</Kv>
            <Kv label="Status">HTTP {code || '--'}</Kv>
          </div>
        </Section>

        <Section title="Tokens & cost" aside={<span className={styles.mono}>{breakdown.total !== null ? formatCost(breakdown.total) : 'no price'}</span>}>
          <div className={styles.tokens}>
            {breakdown.parts.map((part) => (
              <div key={part.id} className={`${styles.tokenRow} ${part.included ? styles.tokenIncluded : ''}`}>
                <span className={styles.tokenName}>{part.label}</span>
                <span className={styles.tokenBar}>
                  <span
                    className={styles.tokenFill}
                    style={{
                      width: `${Math.max(part.tokens > 0 ? 1.5 : 0, (part.tokens / tokenMax) * 100)}%`,
                      background: TOKEN_COLORS[part.id],
                    }}
                  />
                </span>
                <span className={styles.tokenCount}>{formatInt(part.tokens)}</span>
                <span className={styles.tokenCost}>
                  {part.included ? 'in output' : part.cost !== null ? formatCost(part.cost) : '–'}
                </span>
              </div>
            ))}
            <div className={`${styles.tokenRow} ${styles.tokenTotal}`}>
              <span className={styles.tokenName}>Total</span>
              <span />
              <span className={styles.tokenCount}>{formatInt(event.total_tokens)}</span>
              <span className={styles.tokenCost}>{breakdown.total !== null ? formatCost(breakdown.total) : '–'}</span>
            </div>
          </div>
        </Section>

        {(event.failed || event.fail_summary || event.header_error_kind) && (
          <Section
            title="Failure"
            aside={
              event.fail_summary ? (
                <CopyButton value={decor.scrub(event.fail_summary)} label="Copy failure summary" what="Failure summary copied" />
              ) : undefined
            }
          >
            <div className={styles.kvGrid}>
              <Kv label="Status">HTTP {code || '--'}</Kv>
              {failureClass && <Kv label="Class">{FAILURE_CLASS_LABELS[failureClass].label}</Kv>}
              {event.header_error_kind && <Kv label="Header error">{event.header_error_kind}</Kv>}
              {event.header_error_code && <Kv label="Error code">{event.header_error_code}</Kv>}
            </div>
            {event.fail_summary && <pre className={styles.failure}>{decor.scrub(event.fail_summary)}</pre>}
          </Section>
        )}

        {event.response_metadata && Object.keys(event.response_metadata).length > 0 && (
          <Section title="Response headers">
            <HeaderMetadata meta={event.response_metadata} mask={(v) => (showEmails ? v : decor.scrub(mask(v)))} />
          </Section>
        )}

        <Section title="Request">
          <div className={styles.metaGrid}>
            {meta
              .filter(([, value]) => value !== undefined && value !== null && value !== '')
              .map(([key, value, copy]) => (
                <div key={key} className={styles.metaRow}>
                  <span className={styles.metaKey}>{key}</span>
                  <span className={styles.metaValue}>{value}</span>
                  {copy ? <CopyButton value={copy} label={`Copy ${key.toLowerCase()}`} what={`${key} copied`} /> : <span />}
                </div>
              ))}
          </div>
        </Section>

        {siblings.length > 1 && (
          <Section title="Same credential" aside={<span className={styles.dim}>last {siblings.length} loaded</span>}>
            <div className={styles.outcomes} aria-label="Recent outcomes on this credential">
              {siblings
                .slice()
                .reverse()
                .map((s) => (
                  <span
                    key={eventKey(s)}
                    className={`${styles.outcome} ${s.failed ? styles.outcomeFail : ''} ${eventKey(s) === eventKey(event) ? styles.outcomeCurrent : ''}`}
                    title={`${formatStamp(s.timestamp_ms)} · ${s.model} · ${s.failed ? `failed ${statusCodeOf(s)}` : 'ok'} · ${formatDuration(s.latency_ms)}`}
                  />
                ))}
            </div>
          </Section>
        )}
      </div>
    </Sheet>
  );
}
