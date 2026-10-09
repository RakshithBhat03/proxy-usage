import { useCallback, useEffect, useMemo, useState } from 'react';
import { InkButton, PageHeader, ProviderTabs, RefreshIcon, SearchField, ShowEmailsToggle, type MetaPart, type TabItem } from '@/components/kit';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Select } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';
import { useCountUp, useRevealGroup } from '@/hooks/motion';
import { useHeaderRefresh } from '@/hooks/useHeaderRefresh';
import { useNow } from '@/hooks/useNow';
import { entryDisplayName, filterEntriesBySearch } from '@/lib/quota/files';
import { defaultQuotaView, type QuotaViewMode } from '@/lib/quota/ledger';
import { claimClaudeResetGrant, consumeCodexResetCredit, pickResetGrant } from '@/lib/quota/providers';
import { QUOTA_SORT_OPTIONS, sortQuotaEntries, type QuotaSortMode } from '@/lib/quota/schedule';
import { QUOTA_PROVIDERS, type QuotaEntry, type QuotaProvider } from '@/lib/quota/types';
import { providerLabel } from '@/lib/providers';
import { notify } from '@/stores/notifications';
import { useIdentity, usePrivacyStore } from '@/stores/privacy';
import { LedgerView, type ProviderGroup } from './LedgerView';
import { QuotaCard } from './QuotaCard';
import { QuotaTimeline } from './QuotaTimeline';
import { ResetConfirmModal, type ResetRequest } from './ResetConfirmModal';
import { useQuotaData } from './useQuotaData';
import styles from './QuotaPage.module.scss';

type TabId = 'all' | QuotaProvider;

const UI_STATE_KEY = 'quotaPage.uiState';
const VIEW_KEY = 'quota.view';
const CARD_ENTRANCE_BUDGET_MS = 360;
const TIMELINE_LANE_CAP = 20;
const SORT_IDS = new Set(QUOTA_SORT_OPTIONS.map((option) => option.value));

interface UiState {
  tab: TabId;
  sort: QuotaSortMode;
  includeDisabled: boolean;
}

function readUiState(): UiState {
  const fallback: UiState = { tab: 'all', sort: 'default', includeDisabled: false };
  try {
    const parsed = JSON.parse(sessionStorage.getItem(UI_STATE_KEY) ?? '{}') as Partial<UiState>;
    return {
      tab: parsed.tab === 'all' || (QUOTA_PROVIDERS as readonly string[]).includes(parsed.tab ?? '') ? (parsed.tab as TabId) : 'all',
      sort: parsed.sort && SORT_IDS.has(parsed.sort) ? parsed.sort : 'default',
      includeDisabled: parsed.includeDisabled === true,
    };
  } catch {
    return fallback;
  }
}

function readView(): QuotaViewMode {
  const stored = localStorage.getItem(VIEW_KEY);
  return stored === 'auto' || stored === 'cards' || stored === 'ledger' ? stored : 'ledger';
}

const VIEW_OPTIONS = [
  { value: 'auto', label: 'Auto' },
  { value: 'cards', label: 'Default' },
  { value: 'ledger', label: 'Ledger' },
];

export default function QuotaPage() {
  const now = useNow();
  const revealRef = useRevealGroup<HTMLDivElement>();
  const { entries, states, filesQuery, refreshOne, refreshAll, refreshing } = useQuotaData(now);

  const [ui, setUi] = useState(readUiState);
  const updateUi = useCallback((patch: Partial<UiState>) => {
    setUi((prev) => {
      const next = { ...prev, ...patch };
      try {
        sessionStorage.setItem(UI_STATE_KEY, JSON.stringify(next));
      } catch {
        /* non-persistent is fine */
      }
      return next;
    });
  }, []);
  const [view, setView] = useState<QuotaViewMode>(readView);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  useEffect(() => {
    const id = window.setTimeout(() => setSearch(searchInput), 350);
    return () => window.clearTimeout(id);
  }, [searchInput]);

  // Identity masking: memoized on the privacy switch so derived lists stay referentially stable.
  const showEmails = usePrivacyStore((state) => state.showEmails);
  const identityFn = useIdentity();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const identity = useMemo(() => identityFn, [showEmails]);
  const displayName = useCallback((entry: QuotaEntry) => identity(entryDisplayName(entry)), [identity]);

  /* ---------- filter / sort ---------- */

  const disabledCount = useMemo(() => entries.filter((entry) => entry.disabled).length, [entries]);
  const visibleEntries = useMemo(() => entries.filter((entry) => ui.includeDisabled || !entry.disabled), [entries, ui.includeDisabled]);
  const countsByProvider = useMemo(() => {
    const counts = Object.fromEntries(QUOTA_PROVIDERS.map((provider) => [provider, 0])) as Record<QuotaProvider, number>;
    visibleEntries.forEach((entry) => (counts[entry.provider] += 1));
    return counts;
  }, [visibleEntries]);
  // Only providers with credentials get a tab; the active one stays so a remembered selection isn't orphaned.
  const tabs: TabItem[] = useMemo(
    () => [
      { id: 'all', label: 'All', count: visibleEntries.length },
      ...QUOTA_PROVIDERS.filter((provider) => countsByProvider[provider] > 0 || provider === ui.tab).map((provider) => ({ id: provider, count: countsByProvider[provider] })),
    ],
    [visibleEntries.length, countsByProvider, ui.tab],
  );

  const quotaFor = useCallback((entry: QuotaEntry) => states.get(entry.key)?.quota ?? null, [states]);
  const sortedEntries = useMemo(() => {
    const inTab = ui.tab === 'all' ? visibleEntries : visibleEntries.filter((entry) => entry.provider === ui.tab);
    return sortQuotaEntries(filterEntriesBySearch(inTab, search), ui.sort, quotaFor, now);
  }, [visibleEntries, ui.tab, ui.sort, search, quotaFor, now]);

  const resolvedView = view === 'auto' ? defaultQuotaView(countsByProvider) : view;

  /* ---------- meta ---------- */

  const { loadedCount, attentionCount } = useMemo(() => {
    let loaded = 0;
    let attention = 0;
    visibleEntries.forEach((entry) => {
      const state = states.get(entry.key);
      if (state?.hasLive) loaded += 1;
      if (state?.error) attention += 1;
    });
    return { loadedCount: loaded, attentionCount: attention };
  }, [visibleEntries, states]);
  const animatedLoaded = useCountUp(loadedCount);

  const meta: MetaPart[] = [
    { text: `${visibleEntries.length} credential${visibleEntries.length === 1 ? '' : 's'}` },
    { text: `${animatedLoaded} loaded`, tone: loadedCount > 0 ? 'live' : 'muted' },
  ];
  if (attentionCount > 0) meta.push({ text: `${attentionCount} need${attentionCount === 1 ? 's' : ''} attention`, tone: 'attention' });
  if (disabledCount > 0) {
    meta.push({
      tone: 'muted',
      text: (
        <button
          type="button"
          className={styles.metaToggle}
          aria-pressed={ui.includeDisabled}
          onClick={() => updateUi({ includeDisabled: !ui.includeDisabled })}
          title={ui.includeDisabled ? 'Hide disabled credentials' : 'Include disabled credentials'}
        >
          {disabledCount} disabled{ui.includeDisabled ? ' · shown' : ''}
        </button>
      ),
    });
  }

  /* ---------- actions ---------- */

  const handleRefreshAll = useCallback(async () => {
    await refreshAll();
  }, [refreshAll]);
  useHeaderRefresh(handleRefreshAll);

  const handleRefresh = useCallback(
    async (entry: QuotaEntry) => {
      const outcome = await refreshOne(entry);
      if (!outcome) return;
      const name = identity(entry.name);
      if (outcome.error) notify(`Failed to refresh quota for "${name}": ${outcome.error}`, 'error');
      else notify(`Quota refreshed for "${name}"`, 'success');
    },
    [refreshOne, identity],
  );

  const [resetRequest, setResetRequest] = useState<ResetRequest | null>(null);
  const openReset = useCallback(
    (kind: ResetRequest['kind'], entry: QuotaEntry) => setResetRequest({ kind, key: entry.key, name: identity(entry.name), quota: states.get(entry.key)?.quota ?? null }),
    [identity, states],
  );

  const confirmReset = useCallback(
    async (request: ResetRequest) => {
      const entry = entries.find((candidate) => candidate.key === request.key);
      if (!entry) return;
      try {
        if (request.kind === 'codex') {
          await consumeCodexResetCredit(entry.file);
          notify(`Codex quota reset for "${request.name}"`, 'success');
        } else {
          const grants = states.get(entry.key)?.quota?.claude?.resetGrants;
          const grant = grants ? pickResetGrant(grants) : null;
          if (!grant) throw new Error('No reset grant is available.');
          const result = await claimClaudeResetGrant(entry.file, grant.id);
          notify(result.message, result.ok ? 'success' : 'warning');
        }
        setResetRequest(null);
      } catch (error: unknown) {
        notify(`Reset failed for "${request.name}": ${error instanceof Error ? error.message : 'Request failed'}`, 'error');
        setResetRequest(null);
      }
      // Re-read either way: a failed or unknown outcome may still have spent the reset.
      void refreshOne(entry);
    },
    [entries, states, refreshOne],
  );

  /* ---------- entrance (first data only) ---------- */

  const listLoading = filesQuery.isPending;
  const [entered, setEntered] = useState(false);
  const animateEntrance = !entered && !listLoading && sortedEntries.length > 0;
  useEffect(() => {
    if (animateEntrance) setEntered(true);
  }, [animateEntrance]);
  const cardDelay = (index: number): number | null => {
    if (!animateEntrance || index >= 20) return null;
    const count = Math.min(20, sortedEntries.length);
    return count <= 1 ? 0 : Math.round((index / (count - 1)) * CARD_ENTRANCE_BUDGET_MS);
  };

  /* ---------- derived view data ---------- */

  const groups: ProviderGroup[] = useMemo(
    () =>
      QUOTA_PROVIDERS.map((provider) => ({
        provider,
        states: sortedEntries.filter((entry) => entry.provider === provider).map((entry) => states.get(entry.key)).filter((state) => state !== undefined),
      })).filter((group) => group.states.length > 0),
    [sortedEntries, states],
  );

  const timelineLanes = useMemo(
    () =>
      sortedEntries.slice(0, TIMELINE_LANE_CAP).map((entry) => ({
        name: entry.key,
        displayName: identity(entryDisplayName(entry)),
        provider: entry.provider,
        quota: states.get(entry.key)?.quota ?? null,
      })),
    [sortedEntries, states, identity],
  );

  const listError = filesQuery.error ? (filesQuery.error instanceof Error ? filesQuery.error.message : 'Failed to load credentials') : null;
  const isEmpty = !listLoading && sortedEntries.length === 0;
  const trimmedSearch = search.trim();

  return (
    <div className={`kit-page ${styles.page}`} ref={revealRef}>
      <PageHeader
        title="Quota Management"
        meta={meta}
        actions={
          <>
            <ShowEmailsToggle />
            <InkButton icon={<RefreshIcon size={14} />} spinning={refreshing} onClick={() => void handleRefreshAll()} disabled={filesQuery.isFetching}>
              Refresh all credentials
            </InkButton>
          </>
        }
      />

      <section className={styles.workbench}>
        <div className={styles.tabsRow} data-reveal>
          <ProviderTabs items={tabs} active={ui.tab} onChange={(id) => updateUi({ tab: id as TabId })} ariaLabel="Provider" />
          <div className={styles.viewSelect}>
            <Select
              value={view}
              options={VIEW_OPTIONS.map((option) =>
                option.value === 'auto' ? { ...option, label: `Auto · ${resolvedView === 'ledger' ? 'Ledger' : 'Default'}` } : option,
              )}
              onChange={(value) => {
                const next = value as QuotaViewMode;
                setView(next);
                try {
                  localStorage.setItem(VIEW_KEY, next);
                } catch {
                  /* non-persistent is fine */
                }
              }}
              ariaLabel="View"
              size="sm"
            />
          </div>
        </div>

        <div className={`kit-toolbar ${styles.toolbar}`} data-reveal>
          <SearchField value={searchInput} onChange={setSearchInput} placeholder="Search by filename or email" className={styles.search} />
          <div className={styles.sort}>
            <Select value={ui.sort} options={QUOTA_SORT_OPTIONS} onChange={(value) => updateUi({ sort: value as QuotaSortMode })} ariaLabel="Sort" size="sm" />
          </div>
        </div>

        {listError && (
          <div className="kit-error-banner" role="alert">
            Could not load credentials: {listError}
          </div>
        )}

        {listLoading ? (
          resolvedView === 'ledger' && view !== 'auto' ? (
            <div className={styles.skeletonStack} aria-hidden="true">
              <Skeleton height={176} rounded={14} />
              <Skeleton height={22} width={140} rounded={6} />
              <Skeleton height={220} rounded={14} />
            </div>
          ) : (
            <div className={styles.grid} aria-hidden="true">
              {Array.from({ length: 4 }, (_, index) => (
                <Skeleton key={index} height={196} rounded={14} />
              ))}
            </div>
          )
        ) : isEmpty ? (
          trimmedSearch ? (
            <EmptyState
              title="No credentials match your search"
              description="Search matches file names and emails."
              action={
                <Button variant="secondary" size="sm" onClick={() => setSearchInput('')}>
                  Clear search
                </Button>
              }
            />
          ) : ui.tab !== 'all' ? (
            <EmptyState
              title={`No ${providerLabel(ui.tab)} credentials`}
              description="Connect one in CPA to track its quota here."
              action={
                <Button variant="secondary" size="sm" onClick={() => updateUi({ tab: 'all' })}>
                  Show all
                </Button>
              }
            />
          ) : listError ? null : (
            <EmptyState title="No quota-capable credentials" description="Connect an Antigravity, Claude, Codex, xAI, Kimi, Devin or Muse credential to track its quota here." />
          )
        ) : resolvedView === 'ledger' ? (
          <LedgerView
            groups={groups}
            now={now}
            displayName={displayName}
            animateEntrance={animateEntrance}
            onRefresh={(entry) => void handleRefresh(entry)}
            onResetCodex={(entry) => openReset('codex', entry)}
            onResetClaude={(entry) => openReset('claude', entry)}
          />
        ) : (
          <div className={styles.grid}>
            {sortedEntries.map((entry, index) => {
              const state = states.get(entry.key);
              if (!state) return null;
              return (
                <QuotaCard
                  key={entry.key}
                  state={state}
                  displayName={displayName(entry)}
                  now={now}
                  entranceDelayMs={cardDelay(index)}
                  onRefresh={() => void handleRefresh(entry)}
                  onResetCodex={() => openReset('codex', entry)}
                  onResetClaude={() => openReset('claude', entry)}
                />
              );
            })}
          </div>
        )}

        {!listLoading && sortedEntries.length > 0 && <QuotaTimeline lanes={timelineLanes} now={now} />}
      </section>

      <ResetConfirmModal request={resetRequest} now={now} onClose={() => setResetRequest(null)} onConfirm={confirmReset} />
    </div>
  );
}
