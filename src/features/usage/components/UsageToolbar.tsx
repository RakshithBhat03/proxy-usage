import type { TimeRangeValue } from '@/lib/timeRange';
import { useEffect, useState } from 'react';
import { ProviderTabs, SearchField, SegmentedControl, TimeRangePicker, type TabItem } from '@/components/kit';
import { IconLayers } from '@/components/ui/extraIcons';
import { IconBot, IconKey, IconTimer, IconX } from '@/components/ui/icons';
import type { TimeRangeState } from '@/hooks/useTimeRange';
import { providerLabel } from '@/lib/providers';
import {
  CACHE_LABELS,
  LATENCY_OPTIONS,
  countActiveFilters,
  latencyLabel,
  tierLabel,
  type CacheFilter,
  type StatusFilter,
} from '../model/filters';
import type { UsageFilterState } from '../model/useUsageFilters';
import { ChoicePill } from './ChoicePill';
import { MultiSelect, type MultiOption } from './MultiSelect';
import styles from './UsageToolbar.module.scss';

interface UsageToolbarProps {
  time: TimeRangeState;
  state: UsageFilterState;
  providers: TabItem[];
  modelOptions: MultiOption[];
  credOptions: MultiOption[];
  tiers: string[];
  credLabel: (id: string) => string;
  onPreviewRange?: (value: TimeRangeValue) => void;
}

const STATUS_OPTIONS: Array<{ value: StatusFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'ok', label: 'Success' },
  { value: 'fail', label: 'Failed' },
];

export function UsageToolbar({ time, state, providers, modelOptions, credOptions, tiers, credLabel, onPreviewRange }: UsageToolbarProps) {
  const { filters, update, toggleIn, clearAll } = state;
  const [search, setSearch] = useState(filters.q);

  // Follow external changes (Clear all, back/forward) without fighting the user's typing.
  useEffect(() => setSearch(filters.q), [filters.q]);
  useEffect(() => {
    if (search === filters.q) return;
    const id = window.setTimeout(() => update({ q: search }), 350);
    return () => window.clearTimeout(id);
  }, [search, filters.q, update]);

  const chips: Array<{ key: string; label: string; onRemove: () => void }> = [];
  if (filters.provider !== 'all') chips.push({ key: 'p', label: `Provider: ${providerLabel(filters.provider)}`, onRemove: () => update({ provider: 'all' }) });
  filters.models.forEach((m) => chips.push({ key: `m-${m}`, label: m, onRemove: () => toggleIn('models', m) }));
  filters.creds.forEach((c) => chips.push({ key: `c-${c}`, label: credLabel(c), onRemove: () => toggleIn('creds', c) }));
  if (filters.status !== 'all') chips.push({ key: 'st', label: filters.status === 'ok' ? 'Success only' : 'Failed only', onRemove: () => update({ status: 'all' }) });
  if (filters.tier) chips.push({ key: 'tier', label: `Tier: ${tierLabel(filters.tier)} (models)`, onRemove: () => update({ tier: '' }) });
  if (filters.cache) chips.push({ key: 'cache', label: CACHE_LABELS[filters.cache], onRemove: () => update({ cache: '' }) });
  if (filters.minLatency > 0) chips.push({ key: 'lat', label: `Latency ${latencyLabel(filters.minLatency)}`, onRemove: () => update({ minLatency: 0 }) });
  if (filters.q.trim()) chips.push({ key: 'q', label: `“${filters.q.trim()}”`, onRemove: () => update({ q: '' }) });

  return (
    <div className={styles.toolbar} data-reveal>
      <div className={styles.rangeRow}>
        <TimeRangePicker state={time} showBucket onPreview={onPreviewRange} />
        <button
          type="button"
          className="kit-pill-button kit-pill-button--lg"
          aria-pressed={filters.compare}
          onClick={() => update({ compare: !filters.compare })}
          title="Show deltas against the previous period of the same length"
        >
          <span className={`${styles.compareDot} ${filters.compare ? styles.compareDotOn : ''}`} aria-hidden="true" />
          Compare to previous period
        </button>
      </div>

      {providers.length > 1 && (
        <ProviderTabs items={providers} active={filters.provider} onChange={(id) => update({ provider: id })} ariaLabel="Provider" />
      )}

      <div className={styles.filterRow}>
        <MultiSelect
          label="Models"
          icon={<IconBot size={13} />}
          options={modelOptions}
          selected={filters.models}
          onChange={(models) => update({ models })}
          searchPlaceholder="Search models"
        />
        <MultiSelect
          label="Credentials"
          icon={<IconKey size={13} />}
          options={credOptions}
          selected={filters.creds}
          onChange={(creds) => update({ creds })}
          searchPlaceholder="Search credentials"
        />
        <SegmentedControl size="sm" value={filters.status} options={STATUS_OPTIONS} onChange={(status) => update({ status })} ariaLabel="Status" />
        {tiers.length > 1 && (
          <ChoicePill
            label="Service tier"
            icon={<IconLayers size={13} />}
            value={filters.tier}
            neutral=""
            choices={[{ value: '', label: 'All tiers' }, ...tiers.map((t) => ({ value: t, label: tierLabel(t) }))]}
            onChange={(tier) => update({ tier })}
          />
        )}
        <ChoicePill<CacheFilter>
          label="Cache"
          value={filters.cache}
          neutral=""
          choices={[
            { value: '', label: 'Any cache status' },
            { value: 'hit', label: 'Cache hit' },
            { value: 'miss', label: 'Cache miss' },
            { value: 'read', label: 'Cache read' },
            { value: 'creation', label: 'Cache write' },
          ]}
          onChange={(cache) => update({ cache })}
        />
        <ChoicePill
          label="Latency"
          icon={<IconTimer size={13} />}
          value={String(filters.minLatency)}
          neutral="0"
          choices={LATENCY_OPTIONS.map((ms) => ({ value: String(ms), label: latencyLabel(ms) }))}
          onChange={(v) => update({ minLatency: Number(v) })}
        />
        <SearchField className={styles.search} value={search} onChange={setSearch} placeholder="Search model, credential, path, user agent…" />
      </div>

      {chips.length > 0 && (
        <div className={styles.chips} aria-label="Active filters">
          {chips.map((chip) => (
            <span key={chip.key} className={styles.chip}>
              <span className={styles.chipLabel}>{chip.label}</span>
              <button type="button" onClick={chip.onRemove} aria-label={`Remove ${chip.label}`}>
                <IconX size={12} />
              </button>
            </span>
          ))}
          <button type="button" className={styles.clearAll} onClick={clearAll}>
            Clear all{countActiveFilters(filters) > 1 ? ` (${countActiveFilters(filters)})` : ''}
          </button>
        </div>
      )}
    </div>
  );
}
