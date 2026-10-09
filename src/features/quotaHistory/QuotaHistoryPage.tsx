import { useCallback, useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { PageHeader, PillButton, ProviderIcon, ProviderTabs, ShowEmailsToggle, StatTile, type MetaPart, type TabItem } from '@/components/kit';
import { EmptyState } from '@/components/ui/EmptyState';
import { Select } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';
import { IconEye } from '@/components/ui/icons';
import { useRevealGroup } from '@/hooks/motion';
import { useHeaderRefresh } from '@/hooks/useHeaderRefresh';
import { useNow } from '@/hooks/useNow';
import { formatCost, formatInt } from '@/lib/format';
import { normalizeProvider, providerLabel } from '@/lib/providers';
import type { HistoryCredential } from '@/lib/quotaHistory/types';
import type { CredentialHistory } from './useQuotaHistory';
import { hiddenWindowKey, useHiddenWindowsStore } from '@/stores/hiddenWindows';
import { useIdentity } from '@/stores/privacy';
import { credMatches, providerMatches, QUOTA_HISTORY_ROOT, useHistoryCredentials, useQuotaHistory } from './useQuotaHistory';
import { estimateGroup, groupWindows, WindowCard, type WindowEstimate, type WindowGroup } from './WindowCard';
import { formatSpanLength } from './format';
import styles from './QuotaHistoryPage.module.scss';

/** Long enough to reach back past a quiet week to the last weekly window that saw usage. */
const RANGE = '14d';

interface Section {
  row: CredentialHistory;
  cards: Array<{ group: WindowGroup; estimate: WindowEstimate | null }>;
}

const toneFor = (used: number) => (used >= 70 ? 'attention' : used >= 30 ? 'amber' : 'live');

/** Headline figures across every open window on the page. */
function summarize(sections: Section[], now: number) {
  let tightest: { used: number; label: string; cred: HistoryCredential } | null = null;
  let nextReset: { endMs: number; label: string; cred: HistoryCredential } | null = null;
  const atRisk: Array<{ label: string; cred: HistoryCredential }> = [];
  let spent = 0;
  let byReset = 0;
  let forecastAll = true;
  for (const { row, cards } of sections) {
    const open = cards.filter((c) => c.group.current);
    for (const { group, estimate } of open) {
      const w = group.current!;
      if (w.lastUsed !== null && (!tightest || w.lastUsed > tightest.used)) tightest = { used: w.lastUsed, label: group.label, cred: row.cred };
      if (w.endMs > now && (!nextReset || w.endMs < nextReset.endMs)) nextReset = { endMs: w.endMs, label: group.label, cred: row.cred };
      if (estimate?.forecast?.exhausted || estimate?.forecast?.average?.runsOutAtMs) atRisk.push({ label: group.label, cred: row.cred });
    }
    // Windows of one credential overlap, so spend counts only its shortest open window.
    const shortest = [...open].sort((a, b) => a.group.current!.endMs - a.group.current!.startMs - (b.group.current!.endMs - b.group.current!.startMs))[0];
    if (shortest) {
      const u = row.usage[shortest.group.current!.uid];
      if (u?.matched) spent += u.cost;
      if (shortest.estimate?.atReset) byReset += shortest.estimate.atReset.cost;
      else forecastAll = false;
    }
  }
  return { tightest, nextReset, atRisk, spent, byReset: forecastAll && byReset > 0 ? byReset : null };
}

function CardSkeleton() {
  return (
    <div className={styles.card} aria-hidden="true">
      <Skeleton width="40%" height={14} />
      <Skeleton width="25%" height={30} />
      <Skeleton height={5} rounded={999} />
      <Skeleton height={52} rounded={8} />
      <Skeleton height={96} rounded={8} />
    </div>
  );
}

export default function QuotaHistoryPage() {
  const [params, setParams] = useSearchParams();
  const provider = params.get('p')?.toLowerCase() || 'all';
  const picked = params.get('cred') ?? 'all';
  const identity = useIdentity();
  const now = useNow(30_000);
  const queryClient = useQueryClient();
  const revealRef = useRevealGroup<HTMLDivElement>();
  const hidden = useHiddenWindowsStore((state) => state.hidden);
  const hideWindow = useHiddenWindowsStore((state) => state.hide);
  const showWindow = useHiddenWindowsStore((state) => state.show);

  const { allCreds } = useHistoryCredentials(true);
  const providerCreds = useMemo(
    () => allCreds.filter((c) => providerMatches(c, provider)),
    [allCreds, provider],
  );
  const credential = picked !== 'all' && providerCreds.some((c) => credMatches(c, [picked])) ? picked : 'all';
  const credKeys = useMemo(() => (credential === 'all' ? null : [credential]), [credential]);
  const history = useQuotaHistory({ credKeys, provider, range: RANGE, now, enabled: true });

  const setParam = (key: string, value: string | null) =>
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        if (value) next.set(key, value);
        else next.delete(key);
        return next;
      },
      { replace: true },
    );

  const pickProvider = (id: string) =>
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        if (id === 'all') next.delete('p');
        else next.set('p', id);
        next.delete('cred');
        return next;
      },
      { replace: true },
    );

  const headerRefresh = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: QUOTA_HISTORY_ROOT });
  }, [queryClient]);
  useHeaderRefresh(headerRefresh);

  const tabs = useMemo<TabItem[]>(() => {
    const counts = new Map<string, number>();
    allCreds.filter((c) => !c.disabled).forEach((c) => counts.set(normalizeProvider(c.provider), (counts.get(normalizeProvider(c.provider)) ?? 0) + 1));
    return [{ id: 'all', label: 'All', count: [...counts.values()].reduce((s, v) => s + v, 0) }, ...[...counts.entries()].map(([id, count]) => ({ id, label: providerLabel(id), count }))];
  }, [allCreds]);

  const credOptions = useMemo(() => {
    const label = (c: HistoryCredential) => `${identity(c.email ?? c.name)} · ${providerLabel(c.provider)}${c.disabled ? ' (disabled)' : ''}`;
    return [
      { value: 'all', label: 'All active credentials' },
      ...[...providerCreds].sort((a, b) => Number(a.disabled) - Number(b.disabled)).map((c) => ({ value: c.key, label: label(c) })),
    ];
  }, [providerCreds, identity]);

  // "All" shows active credentials only; a disabled one is still reachable through the picker.
  const rows = history.rows.filter((r) => (credential === 'all' ? !r.cred.disabled : true));
  const withWindows = rows.filter((r) => r.windows.length > 0);
  const withoutWindows = rows.filter((r) => r.windows.length === 0);

  // Hidden windows drop out of the summary too; a credential with nothing left showing drops out entirely.
  const sections = useMemo(
    () =>
      withWindows
        .map((row) => ({
          row,
          cards: groupWindows(row.windows, row.usage)
            .filter((group) => !(hiddenWindowKey(row.cred.provider, group.windowId) in hidden))
            .map((group) => ({ group, estimate: estimateGroup(group, row.usage, row.usageAtReading, now) })),
        }))
        .filter((section) => section.cards.length > 0),
    [withWindows, now, hidden],
  );
  const hiddenEntries = Object.entries(hidden).filter(([key]) => provider === 'all' || key.startsWith(`${provider}|`));
  const summary = useMemo(() => summarize(sections, now), [sections, now]);
  const windowCount = sections.reduce((n, s) => n + s.cards.length, 0);

  const meta: MetaPart[] = [
    { text: `${withWindows.length} credential${withWindows.length === 1 ? '' : 's'}` },
    { text: `${windowCount} window${windowCount === 1 ? '' : 's'}` },
    ...(summary.atRisk.length > 0 ? [{ text: `${summary.atRisk.length} at risk`, tone: 'attention' as const }] : [{ text: 'none at risk', tone: 'live' as const }]),
  ];
  const who = (c: HistoryCredential) => `${providerLabel(c.provider)} · ${identity(c.email ?? c.name)}`;

  return (
    <div className={`kit-page ${styles.page}`} ref={revealRef}>
      <PageHeader title="Quota history" meta={meta} actions={<ShowEmailsToggle />} />

      <div className={styles.tabsRow} data-reveal>
        <ProviderTabs items={tabs} active={provider} onChange={pickProvider} ariaLabel="Provider" />
        <div className={styles.credSelect}>
          <Select size="sm" value={credential} options={credOptions} onChange={(v) => setParam('cred', v === 'all' ? null : v)} ariaLabel="Credential" />
        </div>
      </div>

      {history.error && <div className="kit-error-banner">Could not load quota readings: {history.error.message}</div>}
      {history.usageError && <div className="kit-error-banner">Could not load per-window usage: {history.usageError.message}</div>}

      {!history.loading && sections.length > 0 && (
        <div className={`kit-stat-grid ${styles.summary}`}>
          <StatTile
            label="Tightest window"
            value={summary.tightest?.used ?? null}
            format={(v) => `${Math.round(v)}%`}
            tone={summary.tightest ? toneFor(summary.tightest.used) : 'default'}
            hint={summary.tightest ? `${summary.tightest.label} · ${who(summary.tightest.cred)}` : 'no active window'}
          />
          <StatTile
            label="Forecast to run out"
            value={summary.atRisk.length}
            format={(v) => formatInt(v)}
            tone={summary.atRisk.length > 0 ? 'attention' : 'live'}
            hint={summary.atRisk.length > 0 ? summary.atRisk.map((r) => `${r.label} (${providerLabel(r.cred.provider)})`).join(', ') : 'every window lasts to its reset'}
          />
          <StatTile
            label="Next reset"
            value={summary.nextReset ? summary.nextReset.endMs - now : null}
            format={(v) => formatSpanLength(v)}
            hint={summary.nextReset ? `${summary.nextReset.label} · ${who(summary.nextReset.cred)}` : 'nothing running'}
          />
          <StatTile
            label="Spent in open windows"
            value={summary.spent}
            format={(v) => formatCost(v)}
            hint={summary.byReset !== null ? `~${formatCost(summary.byReset)} by their resets` : 'shortest window per credential'}
          />
        </div>
      )}

      {history.loading ? (
        <div className={styles.grid}>
          <CardSkeleton />
          <CardSkeleton />
        </div>
      ) : withWindows.length === 0 ? (
        <EmptyState
          title="No quota windows yet"
          description="Windows appear once a credential serves traffic or the Quota page reads it."
        />
      ) : (
        sections.map(({ row, cards }) => (
          <section key={row.cred.key} className={styles.cred} data-reveal>
            <div className={styles.credHead}>
              <ProviderIcon provider={row.cred.provider} size={18} />
              <span className={styles.credName}>{identity(row.cred.email ?? row.cred.name)}</span>
              <span className={styles.credCount}>{cards.length}</span>
              <span className={styles.credSub}>
                {providerLabel(row.cred.provider)}
                {row.cred.disabled ? ' · disabled' : ''}
              </span>
            </div>
            <div className={styles.grid}>
              {cards.map(({ group, estimate }) => (
                <WindowCard
                  key={group.windowId}
                  group={group}
                  estimate={estimate}
                  scope={row.scopes[group.windowId] ?? { kind: 'all' }}
                  usage={row.usage}
                  now={now}
                  usageLoading={history.usageLoading}
                  onHide={() => hideWindow(hiddenWindowKey(row.cred.provider, group.windowId), group.label)}
                />
              ))}
            </div>
          </section>
        ))
      )}

      {hiddenEntries.length > 0 && (
        <div className={styles.hiddenRow}>
          <span>Hidden</span>
          {hiddenEntries.map(([key, label]) => (
            <PillButton key={key} icon={<IconEye size={13} />} onClick={() => showWindow(key)} title={`Show ${label} again`}>
              {provider === 'all' ? `${providerLabel(key.split('|')[0])} · ${label}` : label}
            </PillButton>
          ))}
        </div>
      )}
      {!history.loading && withoutWindows.length > 0 && (
        <p className={styles.footnote}>No quota readings yet for {withoutWindows.map((r) => identity(r.cred.email ?? r.cred.name)).join(', ')}.</p>
      )}
      {!history.loading && withWindows.length > 0 && (
        <p className={styles.footnote}>
          Previous is the latest ended window that saw usage. Forecasts carry the pace so far to the reset. Requests, tokens and cost are this proxy's traffic only.
        </p>
      )}
    </div>
  );
}
