import { useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { ProviderIcon } from '@/components/kit';
import { IconRefreshCw } from '@/components/ui/icons';
import { formatRemaining } from '@/lib/quota/model';
import { buildResetDisplay, localUtcOffsetLabel } from '@/lib/quota/parse';
import { claudeResetBlocker } from '@/lib/quota/providers';
import { collectQuotaRowInstants, pickUrgentRowId, resetCreditRowId } from '@/lib/quota/schedule';
import type { AccountQuota, QuotaWindow } from '@/lib/quota/types';
import { providerLabel } from '@/lib/providers';
import { PlanBadge, QuotaMeter, ResetLabel, SourceTag } from './QuotaBits';
import type { QuotaEntryState } from './useQuotaData';
import styles from './QuotaCard.module.scss';

interface QuotaCardProps {
  state: QuotaEntryState;
  displayName: string;
  now: number;
  /** One-off entrance delay captured at mount; null = no entrance (tab switch, refresh). */
  entranceDelayMs: number | null;
  onRefresh: () => void;
  onResetCodex: () => void;
  onResetClaude: () => void;
}

const money = (cents: number | null | undefined) => (typeof cents === 'number' ? `$${(cents / 100).toFixed(2)}` : '--');

/** CPAMC quota card: icon + mono file name, provider facts, window meters, quiet action pills. */
export function QuotaCard({ state, displayName, now, entranceDelayMs, onRefresh, onResetCodex, onResetClaude }: QuotaCardProps) {
  const { entry, quota, status, fetching, error } = state;
  const [mountDelay] = useState(entranceDelayMs);
  const enterStyle = mountDelay === null ? undefined : ({ '--enter-delay': `${mountDelay}ms` } as CSSProperties);
  const disabled = entry.disabled;

  const codexResets = quota?.codex?.manualResets.available ?? 0;
  const grants = quota?.claude?.resetGrants ?? null;
  const claudeBlocker = grants ? claudeResetBlocker(grants) : null;

  return (
    <article className={`${styles.card} ${mountDelay === null ? '' : 'kit-enter'} ${disabled ? styles.cardDisabled : ''}`} style={enterStyle}>
      <header className={styles.head}>
        <span className={styles.iconWrap} title={providerLabel(entry.provider)}>
          <ProviderIcon provider={entry.provider} size={16} />
        </span>
        <span className={styles.fileName} title={displayName}>
          {displayName}
        </span>
        {disabled && <span className="kit-badge">Disabled</span>}
      </header>

      <div className={styles.body}>
        {status === 'idle' ? (
          <button type="button" className={styles.idleBody} onClick={onRefresh} disabled={disabled}>
            <IconRefreshCw size={15} aria-hidden="true" className={styles.idleGlyph} />
            <span className={styles.idleHint}>{disabled ? 'Credential is disabled' : 'Click here to refresh quota'}</span>
          </button>
        ) : status === 'loading' ? (
          <div className={styles.skeleton} aria-busy="true">
            <span className={styles.srOnly}>Loading quota...</span>
            {[0, 1].map((row) => (
              <div key={row} className={styles.skeletonRow} aria-hidden="true">
                <span className={styles.skeletonLabel} />
                <span className={styles.skeletonTrack} />
              </div>
            ))}
          </div>
        ) : status === 'error' ? (
          <div className={styles.errorStrip} role="alert">
            Failed to load quota: {error}
          </div>
        ) : quota ? (
          <>
            {error && (
              <div className={styles.warnStrip} role="status">
                Live refresh failed: {error}
              </div>
            )}
            <QuotaCardBody quota={quota} now={now} />
          </>
        ) : null}
      </div>

      {status !== 'idle' && (
        <footer className={styles.footer}>
          <SourceTag quota={quota} now={now} fetching={fetching} />
          <div className={styles.actions}>
            {entry.provider === 'claude' && grants && (
              <button
                type="button"
                className="kit-pill-button"
                onClick={onResetClaude}
                disabled={disabled || fetching || claudeBlocker !== null}
                title={claudeBlocker ?? 'Spend one banked reset to clear the current limits'}
              >
                <span className="kit-pill-button__icon">
                  <IconRefreshCw size={13} />
                </span>
                Reset limits
              </button>
            )}
            {entry.provider === 'codex' && codexResets > 0 && (
              <button type="button" className="kit-pill-button" onClick={onResetCodex} disabled={disabled || fetching} title="Consume one manual reset">
                <span className="kit-pill-button__icon">
                  <IconRefreshCw size={13} />
                </span>
                Reset quota
              </button>
            )}
            <button type="button" className="kit-pill-button" onClick={onRefresh} disabled={disabled || fetching} title="Read this credential's quota live">
              <span className={`kit-pill-button__icon ${fetching ? 'kit-spin' : ''}`}>
                <IconRefreshCw size={13} />
              </span>
              Refresh quota
            </button>
          </div>
        </footer>
      )}
    </article>
  );
}

function FactItem({ label, children }: { label: string; children: ReactNode }) {
  return (
    <span className={styles.factItem}>
      <span className={styles.factLabel}>{label}</span>
      <span className={styles.factValue}>{children}</span>
    </span>
  );
}

export function QuotaCardBody({ quota, now }: { quota: AccountQuota; now: number }) {
  const urgentId = useMemo(() => pickUrgentRowId(collectQuotaRowInstants(quota), now), [quota, now]);
  const codex = quota.codex;
  const claude = quota.claude;
  const xai = quota.xai;
  const renewal = codex?.renewsAtMs ? buildResetDisplay(codex.renewsAtMs, now) : null;
  const credits = codex?.manualResets.credits ?? [];
  const grants = claude?.resetGrants?.grants.filter((grant) => grant.left > 0) ?? [];

  const facts: ReactNode[] = [];
  if (claude?.resetGrants) facts.push(<FactItem key="resets" label="Resets remaining">{claude.resetGrants.count}</FactItem>);
  if (quota.plan) {
    facts.push(
      <FactItem key="plan" label="Plan">
        <PlanBadge plan={quota.plan} />
      </FactItem>,
    );
  }
  if (claude?.extraUsage) {
    facts.push(
      <FactItem key="extra" label="Extra Usage">
        {money(claude.extraUsage.usedCents)} / {money(claude.extraUsage.limitCents)}
      </FactItem>,
    );
  }
  if (renewal) {
    facts.push(
      <FactItem key="renewal" label="Renewal time">
        <ResetLabel display={renewal} />
      </FactItem>,
    );
  }
  if (codex && (codex.creditsUnlimited || codex.creditBalance !== null)) {
    facts.push(<FactItem key="balance" label="Credit balance">{codex.creditsUnlimited ? 'Unlimited' : codex.creditBalance}</FactItem>);
  }
  if (codex && codex.manualResets.available !== null) facts.push(<FactItem key="manual" label="Manual resets">{codex.manualResets.available}</FactItem>);
  if (xai?.payAsYouGo) {
    facts.push(
      <FactItem key="payg" label="Pay-as-you-go">
        {xai.payAsYouGo.capCents ? `Enabled, cap ${money(xai.payAsYouGo.capCents)}` : 'Disabled'}
      </FactItem>,
    );
  }
  if (xai && xai.prepaidBalanceCents !== null) facts.push(<FactItem key="prepaid" label="Prepaid balance">{money(xai.prepaidBalanceCents)}</FactItem>);

  let lastGroup: string | undefined;
  return (
    <>
      {facts.length > 0 && <div className={styles.facts}>{facts}</div>}

      {grants.length > 0 && (
        <div className={styles.expiryList}>
          <div className={styles.expiryTitle}>Reset grant expiry ({localUtcOffsetLabel()})</div>
          {grants.map((grant, index) => {
            const display = buildResetDisplay(grant.endsAtMs, now);
            return (
              <div key={grant.id} className={styles.expiryRow}>
                <span className={styles.expiryLabel}>
                  {grant.label || `Grant ${index + 1}`} · {grant.left} / {grant.total} resets remaining
                </span>
                <span className={styles.expiryTime}>{display ? <ResetLabel display={display} /> : 'No expiry'}</span>
              </div>
            );
          })}
        </div>
      )}

      {credits.length > 0 ? (
        <div className={styles.expiryList}>
          <div className={styles.expiryTitle}>Manual reset expiry ({localUtcOffsetLabel()})</div>
          {credits.map((credit, index) => {
            const rowId = resetCreditRowId(credit.id, index);
            const soon = rowId === urgentId;
            const display = buildResetDisplay(credit.expiresAtMs, now);
            return (
              <div key={rowId} className={`${styles.expiryRow} ${soon ? styles.expiryRowSoon : ''}`} title={soon ? 'Recovers first on this credential' : undefined}>
                <span className={styles.expiryLabel}>Reset {index + 1}</span>
                <span className={styles.expiryTime}>{display && <ResetLabel display={display} soon={soon} />}</span>
              </div>
            );
          })}
        </div>
      ) : codex?.manualResets.error ? (
        <div className={styles.warnStrip}>Manual reset expiry unavailable: {codex.manualResets.error}</div>
      ) : null}

      {quota.note && <div className={styles.message}>{quota.note}</div>}

      {quota.windows.length === 0 && !quota.note ? (
        <div className={styles.message}>No quota data available</div>
      ) : (
        quota.windows.map((window, index) => {
          const header = window.group && window.group !== lastGroup ? window.group : null;
          lastGroup = window.group;
          return (
            <div key={window.id} className={styles.windowBlock}>
              {header && <div className={styles.groupTitle}>{header}</div>}
              <WindowRow window={window} index={index} now={now} soon={window.id === urgentId} />
            </div>
          );
        })
      )}

      {xai && xai.productUsage.length > 0 && (
        <div className={styles.expiryList}>
          <div className={styles.expiryTitle}>Usage breakdown (shared quota)</div>
          {xai.productUsage.map((item) => (
            <div key={item.product} className={styles.expiryRow}>
              <span className={styles.expiryLabel}>{item.product}</span>
              <span className={styles.expiryTime}>{item.usagePercent === null ? '--' : `${Math.round(item.usagePercent)}%`}</span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function WindowRow({ window, index, now, soon }: { window: QuotaWindow; index: number; now: number; soon: boolean }) {
  const display = buildResetDisplay(window.resetAtMs, now);
  return (
    <div className={styles.windowRow} title={soon ? 'Recovers first on this credential' : undefined}>
      <div className={styles.windowHeader}>
        <span className={styles.windowLabel}>{window.label}</span>
        <span className={styles.windowMeta}>
          <span className={styles.windowPercent}>{formatRemaining(window.remainingPercent)}</span>
          {window.amount && <span className={styles.windowAmount}>{window.amount}</span>}
          {display ? (
            <ResetLabel display={display} soon={soon} />
          ) : window.stale ? (
            <span className={styles.windowStale} title="This window reset after it was observed; refresh to read it live">
              rolled over
            </span>
          ) : null}
        </span>
      </div>
      <QuotaMeter percent={window.remainingPercent} index={index} />
    </div>
  );
}
