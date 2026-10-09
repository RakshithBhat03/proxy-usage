import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { ProviderIcon } from '@/components/kit';
import { IconChevronDown, IconRefreshCw } from '@/components/ui/icons';
import { useCountUp } from '@/hooks/motion';
import { MANUAL_RESETS_COLUMN, ledgerColumns, summarizeProvider, type LedgerColumn, type WindowSummary } from '@/lib/quota/ledger';
import { formatRemaining, quotaLevel } from '@/lib/quota/model';
import { buildResetDisplay, formatInstantShort, formatRelativeInstant } from '@/lib/quota/parse';
import { claudeResetBlocker } from '@/lib/quota/providers';
import { collectQuotaRowInstants, pickUrgentRowId } from '@/lib/quota/schedule';
import type { AccountQuota, QuotaEntry, QuotaProvider } from '@/lib/quota/types';
import { providerLabel } from '@/lib/providers';
import { QuotaMeter, ResetLabel, SourceTag } from './QuotaBits';
import type { QuotaEntryState } from './useQuotaData';
import styles from './LedgerView.module.scss';

export interface ProviderGroup {
  provider: QuotaProvider;
  states: QuotaEntryState[];
}

interface LedgerViewProps {
  groups: ProviderGroup[];
  now: number;
  displayName: (entry: QuotaEntry) => string;
  onRefresh: (entry: QuotaEntry) => void;
  onResetCodex: (entry: QuotaEntry) => void;
  onResetClaude: (entry: QuotaEntry) => void;
  /** Cascade the strip and sections in (first data only). */
  animateEntrance: boolean;
}

const enterStyle = (delay: number | null) => (delay === null ? undefined : ({ '--enter-delay': `${delay}ms` } as CSSProperties));

/**
 * Multi-account "Ledger": a per-provider summary strip (sums of remaining across accounts, one
 * segment per account), then one hairline row per credential with window columns aligned.
 */
export function LedgerView({ groups, now, displayName, onRefresh, onResetCodex, onResetClaude, animateEntrance }: LedgerViewProps) {
  // Captured once: later re-renders (refresh, tab switch) never replay the cascade.
  const [entrance] = useState(animateEntrance);
  return (
    <div className={styles.ledger}>
      <SummaryStrip groups={groups} now={now} enterDelay={entrance ? 0 : null} />
      {groups.map((group, index) => (
        <ProviderSection
          key={group.provider}
          enterDelay={entrance ? Math.min(360, 70 * (index + 1)) : null}
          group={group}
          now={now}
          displayName={displayName}
          onRefresh={onRefresh}
          onResetCodex={onResetCodex}
          onResetClaude={onResetClaude}
        />
      ))}
    </div>
  );
}

/* ---------- summary strip ---------- */

function SummaryStrip({ groups: allGroups, now, enterDelay }: { groups: ProviderGroup[]; now: number; enterDelay: number | null }) {
  const groups = allGroups.filter((group) => group.states.some((state) => !state.entry.disabled));
  if (groups.length === 0) return null;
  return (
    <section className={`${styles.strip} ${enterDelay === null ? '' : 'kit-enter'}`} style={enterStyle(enterDelay)} aria-label="Provider totals">
      {groups.map((group) => (
        <SummaryCell key={group.provider} group={group} now={now} />
      ))}
    </section>
  );
}

type SegmentInput = WindowSummary['segments'];

/** One window's cross-account total: label, big "X% of N%", a segment per account, soonest reset. */
function WindowBlock({ row, total, now, placeholder }: { row: WindowSummary | null; total: number; now: number; placeholder: SegmentInput }) {
  // Armed after mount so the total counts up from zero on arrival, then glides between refreshes.
  const [armed, setArmed] = useState(false);
  useEffect(() => setArmed(true), []);
  const animated = useCountUp(armed ? (row?.sumRemaining ?? 0) : 0);
  const reset = row?.soonestResetMs ? buildResetDisplay(row.soonestResetMs, now) : null;
  return (
    <div className={styles.block}>
      <div className={styles.cellLabel}>{row?.label ?? 'No quota window reported'}</div>
      <div className={styles.cellFigure}>
        <span className={styles.cellBig}>{row?.sumRemaining === null || !row ? '--' : `${animated}%`}</span>
        <span className={styles.cellOf}>of {total}%</span>
        {row && row.unknownCount > 0 && <span className={styles.cellUnknown}>· {row.unknownCount} not loaded</span>}
      </div>
      <div className={styles.segments} aria-hidden="true">
        {(row?.segments ?? placeholder).map((segment, index) => (
          <span key={segment.key} className={styles.segment}>
            <span
              className={`${styles.segmentFill} ${styles[`level_${segment.level}`]}`}
              style={{ width: `${segment.remaining ?? 0}%`, '--meter-index': index } as CSSProperties}
            />
          </span>
        ))}
      </div>
      <div className={styles.cellReset}>
        {reset ? <ResetLabel display={reset} order="relative-first" /> : <span className={styles.muted}>No reset pending</span>}
      </div>
    </div>
  );
}

function SummaryCell({ group, now }: { group: ProviderGroup; now: number }) {
  const [expanded, setExpanded] = useState(false);
  const activeStates = group.states.filter((state) => !state.entry.disabled);
  const summary = useMemo(
    () =>
      summarizeProvider(
        group.provider,
        // Disabled credentials can't serve traffic, so they never count toward capacity.
        group.states.filter((state) => !state.entry.disabled).map((state) => ({ key: state.entry.key, quota: state.quota })),
        now,
      ),
    [group, now],
  );
  const count = summary.credentialCount;
  const total = count * 100;
  const placeholder: SegmentInput = activeStates.map((state) => ({ key: state.entry.key, remaining: null, level: 'unknown' as const }));
  // Everything except the primary window: shown as compact totals, expanded into full blocks.
  const extraRows = [summary.secondary, ...summary.others].filter((row): row is WindowSummary => row !== null);

  return (
    <div className={styles.cell}>
      <div className={styles.cellTop}>
        <span className={styles.cellName}>
          <ProviderIcon provider={group.provider} size={14} />
          {providerLabel(group.provider)}
        </span>
        <span className={styles.cellCount}>
          {count} credential{count === 1 ? '' : 's'}
        </span>
      </div>
      <WindowBlock row={summary.primary} total={total} now={now} placeholder={placeholder} />
      {extraRows.length > 0 && (
        <div className={styles.cellSecondary}>
          {extraRows.map((row, index) => (
            <div key={row.windowId} className={styles.secondaryRow}>
              <span className={styles.secondaryLabel}>{row.label}</span>
              <span className={styles.secondaryValue}>{row.sumRemaining === null ? '--' : `${row.sumRemaining}%`}</span>
              {index === 0 && (
                <button type="button" className={styles.textToggle} onClick={() => setExpanded((v) => !v)} aria-expanded={expanded}>
                  {expanded ? 'Hide' : 'Show'}
                </button>
              )}
            </div>
          ))}
          {expanded && (
            <div className={styles.expandedBlocks}>
              {extraRows.map((row) => (
                <WindowBlock key={row.windowId} row={row} total={total} now={now} placeholder={placeholder} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ---------- sections ---------- */

interface SectionProps {
  group: ProviderGroup;
  enterDelay: number | null;
  now: number;
  displayName: (entry: QuotaEntry) => string;
  onRefresh: (entry: QuotaEntry) => void;
  onResetCodex: (entry: QuotaEntry) => void;
  onResetClaude: (entry: QuotaEntry) => void;
}

function ProviderSection({ group, enterDelay, now, displayName, onRefresh, onResetCodex, onResetClaude }: SectionProps) {
  const loaded = useMemo(() => group.states.map((state) => state.quota).filter((q): q is AccountQuota => Boolean(q)), [group]);
  const { columns, overflow } = useMemo(() => ledgerColumns(group.provider, loaded, 3), [group.provider, loaded]);
  const columnCount = Math.max(1, columns.length);
  return (
    <section className={`${styles.section} ${enterDelay === null ? '' : 'kit-enter'}`} style={enterStyle(enterDelay)}>
      <h2 className={styles.sectionTitle}>
        <ProviderIcon provider={group.provider} size={14} />
        {providerLabel(group.provider)}
        <span className={styles.sectionCount}>{group.states.length}</span>
      </h2>
      <div className={styles.rows} style={{ '--ledger-cols': columnCount } as CSSProperties}>
        {group.states.map((state, index) => (
          <LedgerRow
            key={state.entry.key}
            state={state}
            index={index}
            columns={columns}
            overflow={overflow}
            now={now}
            name={displayName(state.entry)}
            onRefresh={() => onRefresh(state.entry)}
            onResetCodex={() => onResetCodex(state.entry)}
            onResetClaude={() => onResetClaude(state.entry)}
          />
        ))}
      </div>
    </section>
  );
}

interface RowProps {
  state: QuotaEntryState;
  index: number;
  columns: LedgerColumn[];
  overflow: LedgerColumn[];
  now: number;
  name: string;
  onRefresh: () => void;
  onResetCodex: () => void;
  onResetClaude: () => void;
}

function LedgerRow({ state, index, columns, overflow, now, name, onRefresh, onResetCodex, onResetClaude }: RowProps) {
  const [expanded, setExpanded] = useState(false);
  const { entry, quota, status, fetching, error } = state;
  const urgentId = useMemo(() => pickUrgentRowId(collectQuotaRowInstants(quota), now), [quota, now]);
  const extra = overflow.filter((column) => quota?.windows.some((w) => w.id === column.id));
  const codexResets = quota?.codex?.manualResets.available ?? 0;
  const grants = quota?.claude?.resetGrants ?? null;
  const claudeBlocker = grants ? claudeResetBlocker(grants) : null;

  const renewal = quota?.codex?.renewsAtMs ?? null;
  const subline = [
    quota?.plan?.label,
    renewal ? `renews ${formatInstantShort(renewal)} · ${formatRelativeInstant(renewal, now)}` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <div className={`${styles.row} ${entry.disabled ? styles.rowDisabled : ''}`}>
      <div className={styles.identity}>
        <span className={styles.rowName} title={name}>
          {name}
        </span>
        <span className={styles.rowSub}>
          {entry.disabled ? 'Disabled' : subline || providerLabel(entry.provider)}
          {error && quota && (
            <span className={styles.rowWarn} title={error}>
              {' '}
              · refresh failed
            </span>
          )}
        </span>
      </div>

      {status === 'success' && quota && columns.length === 0 ? (
        <div className={styles.rowIdle}>{quota.note ?? 'No quota data available'}</div>
      ) : status === 'success' && quota ? (
        columns.map((column, columnIndex) =>
          column.id === MANUAL_RESETS_COLUMN ? (
            <ManualResetsCell key={column.id} quota={quota} now={now} />
          ) : (
            <WindowCell key={column.id} quota={quota} column={column} now={now} index={index + columnIndex} urgentId={urgentId} />
          ),
        )
      ) : status === 'loading' ? (
        (columns.length ? columns : [{ id: 'placeholder', label: '' }]).map((column) => (
          <div key={column.id} className={styles.cell} aria-busy="true">
            <span className={styles.skelLine} />
            <span className={styles.skelBar} />
          </div>
        ))
      ) : status === 'error' ? (
        <div className={styles.rowError} role="alert">
          Failed to load quota: {error}
        </div>
      ) : (
        <div className={styles.rowIdle}>
          <button type="button" className={styles.linkButton} onClick={onRefresh} disabled={entry.disabled}>
            {entry.disabled ? 'Credential is disabled' : 'Click to load quota'}
          </button>
        </div>
      )}

      <div className={styles.rowActions}>
        <div className={styles.actionButtons}>
          {extra.length > 0 && (
            <button type="button" className={styles.moreButton} onClick={() => setExpanded((v) => !v)} aria-expanded={expanded} title="More windows">
              +{extra.length}
              <IconChevronDown size={12} className={expanded ? styles.chevronOpen : undefined} />
            </button>
          )}
          {entry.provider === 'claude' && grants && grants.count > 0 && (
            <button type="button" className={styles.quietButton} onClick={onResetClaude} disabled={entry.disabled || fetching || claudeBlocker !== null} title={claudeBlocker ?? undefined}>
              <IconRefreshCw size={12} />
              Reset limits
            </button>
          )}
          {entry.provider === 'codex' && codexResets > 0 && (
            <button type="button" className={styles.quietButton} onClick={onResetCodex} disabled={entry.disabled || fetching}>
              <IconRefreshCw size={12} />
              Reset quota
            </button>
          )}
          <button type="button" className={styles.quietButton} onClick={onRefresh} disabled={entry.disabled || fetching}>
            <IconRefreshCw size={12} className={fetching ? 'kit-spin' : undefined} />
            Refresh quota
          </button>
        </div>
        {status === 'success' && <SourceTag quota={quota} now={now} fetching={fetching} />}
      </div>

      {expanded && quota && extra.length > 0 && (
        <div className={styles.overflow}>
          {extra.map((column, columnIndex) => (
            <WindowCell key={column.id} quota={quota} column={column} now={now} index={columnIndex} urgentId={urgentId} />
          ))}
        </div>
      )}
    </div>
  );
}

function WindowCell({ quota, column, now, index, urgentId }: { quota: AccountQuota; column: LedgerColumn; now: number; index: number; urgentId: string | null }) {
  const window = quota.windows.find((w) => w.id === column.id);
  if (!window) {
    return (
      <div className={styles.cell}>
        <div className={styles.cellHead}>
          <span className={styles.cellTitle}>{column.label}</span>
          <span className={styles.cellPercentMuted}>—</span>
        </div>
        <QuotaMeter percent={null} size="sm" />
        <span className={styles.cellFoot}>Not reported</span>
      </div>
    );
  }
  const display = buildResetDisplay(window.resetAtMs, now);
  const level = quotaLevel(window.remainingPercent);
  return (
    <div className={styles.cell} data-level={level}>
      <div className={styles.cellHead}>
        <span className={styles.cellTitle} title={window.label}>
          {window.label}
        </span>
        <span className={styles.cellPercent}>{formatRemaining(window.remainingPercent)}</span>
      </div>
      <QuotaMeter percent={window.remainingPercent} index={index} size="sm" />
      <span className={styles.cellFoot}>
        {display ? (
          <ResetLabel display={display} order="relative-first" soon={window.id === urgentId} />
        ) : window.stale ? (
          'Rolled over · refresh'
        ) : (
          'No reset pending'
        )}
      </span>
    </div>
  );
}

function ManualResetsCell({ quota, now }: { quota: AccountQuota; now: number }) {
  const resets = quota.codex?.manualResets;
  const next = resets?.credits[0];
  const display = next ? buildResetDisplay(next.expiresAtMs, now) : null;
  return (
    <div className={styles.cell}>
      <div className={styles.cellHead}>
        <span className={styles.cellTitle}>Manual resets</span>
      </div>
      <span className={styles.resetsValue}>
        {resets?.available === null || resets?.available === undefined ? (
          <span className={styles.cellPercentMuted}>--</span>
        ) : (
          <>
            <b>{resets.available}</b> available
          </>
        )}
      </span>
      <span className={styles.cellFoot}>
        {display ? (
          <>
            Reset 1 · <ResetLabel display={display} order="relative-first" />
          </>
        ) : resets?.available ? (
          'Expiry not listed'
        ) : (
          'None banked'
        )}
      </span>
    </div>
  );
}
