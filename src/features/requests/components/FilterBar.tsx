import { useEffect, useState, type KeyboardEvent, type ReactNode } from 'react';
import { SegmentedControl } from '@/components/kit';
import { IconX } from '@/components/ui/icons';
import { providerLabel } from '@/lib/providers';
import {
  CACHE_OPTIONS,
  STATUS_OPTIONS,
  STREAM_OPTIONS,
  type CacheFilter,
  type RequestFilters,
  type StatusFilter,
  type StreamFilter,
} from '../model/filters';
import styles from './FilterBar.module.scss';

export interface Option {
  value: string;
  label: string;
}

interface FilterBarProps {
  filters: RequestFilters;
  onChange: (patch: Partial<RequestFilters>) => void;
  onClearAll: () => void;
  modelOptions: Option[];
  credentialOptions: Option[];
  tierOptions: Option[];
  /** Resolves a credential id (auth_index) to its masked display label for chips. */
  credentialName: (id: string) => string;
}

function PillSelect({
  label,
  value,
  options,
  onChange,
  allLabel,
  wide,
}: {
  label: string;
  value: string;
  options: Option[];
  onChange: (value: string) => void;
  allLabel: string;
  wide?: boolean;
}) {
  const known = value === '' || options.some((o) => o.value === value);
  return (
    <label className={`${styles.pill} ${value ? styles.pillActive : ''}`}>
      <span className={styles.pillLabel}>{label}</span>
      <select
        className={`${styles.select} ${wide ? styles.selectWide : ''}`}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">{allLabel}</option>
        {!known && <option value={value}>{value}</option>}
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

const toSeconds = (ms: number | null) => (ms === null ? '' : String(Math.round((ms / 1000) * 10) / 10));
const fromSeconds = (value: string) => {
  const n = Number(value);
  return value.trim() !== '' && Number.isFinite(n) && n > 0 ? Math.round(n * 1000) : null;
};

/** Min latency is applied by the server; max latency only exists client-side. */
function LatencyPill({
  min,
  max,
  onChange,
}: {
  min: number | null;
  max: number | null;
  onChange: (patch: Pick<RequestFilters, 'minLatencyMs' | 'maxLatencyMs'>) => void;
}) {
  const [draftMin, setDraftMin] = useState(toSeconds(min));
  const [draftMax, setDraftMax] = useState(toSeconds(max));
  useEffect(() => setDraftMin(toSeconds(min)), [min]);
  useEffect(() => setDraftMax(toSeconds(max)), [max]);
  const commit = () => {
    const nextMin = fromSeconds(draftMin);
    const nextMax = fromSeconds(draftMax);
    if (nextMin !== min || nextMax !== max) onChange({ minLatencyMs: nextMin, maxLatencyMs: nextMax });
  };
  const onKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') commit();
  };
  return (
    <div className={`${styles.pill} ${min !== null || max !== null ? styles.pillActive : ''}`}>
      <span className={styles.pillLabel}>Latency</span>
      <span className={styles.latency}>
        <span className={styles.op}>≥</span>
        <input
          className={styles.num}
          inputMode="decimal"
          placeholder="0"
          value={draftMin}
          onChange={(e) => setDraftMin(e.target.value)}
          onBlur={commit}
          onKeyDown={onKey}
          aria-label="Minimum latency in seconds"
        />
        <span className={styles.op}>≤</span>
        <input
          className={styles.num}
          inputMode="decimal"
          placeholder="∞"
          value={draftMax}
          onChange={(e) => setDraftMax(e.target.value)}
          onBlur={commit}
          onKeyDown={onKey}
          aria-label="Maximum latency in seconds"
        />
        <span className={styles.unit}>s</span>
      </span>
    </div>
  );
}

interface Chip {
  key: string;
  label: ReactNode;
  clientOnly?: boolean;
  clear: Partial<RequestFilters>;
}

export function FilterBar({
  filters,
  onChange,
  onClearAll,
  modelOptions,
  credentialOptions,
  tierOptions,
  credentialName,
}: FilterBarProps) {
  const chips: Chip[] = [];
  if (filters.search) chips.push({ key: 'q', label: <>Search “{filters.search}”</>, clear: { search: '' } });
  if (filters.provider !== 'all')
    chips.push({ key: 'provider', label: <>Provider · {providerLabel(filters.provider)}</>, clear: { provider: 'all' } });
  if (filters.status !== 'all') {
    const option = STATUS_OPTIONS.find((o) => o.value === filters.status);
    chips.push({
      key: 'status',
      label: <>Status · {option?.label}</>,
      clientOnly: !['success', 'failed'].includes(filters.status),
      clear: { status: 'all' },
    });
  }
  if (filters.model) chips.push({ key: 'model', label: <>Model · {filters.model}</>, clear: { model: '' } });
  if (filters.credential)
    chips.push({ key: 'cred', label: <>Credential · {credentialName(filters.credential)}</>, clear: { credential: '' } });
  if (filters.minLatencyMs !== null)
    chips.push({ key: 'minlat', label: <>Latency ≥ {toSeconds(filters.minLatencyMs)} s</>, clear: { minLatencyMs: null } });
  if (filters.maxLatencyMs !== null)
    chips.push({
      key: 'maxlat',
      label: <>Latency ≤ {toSeconds(filters.maxLatencyMs)} s</>,
      clientOnly: true,
      clear: { maxLatencyMs: null },
    });
  if (filters.cache)
    chips.push({ key: 'cache', label: CACHE_OPTIONS.find((o) => o.value === filters.cache)?.label, clear: { cache: '' } });
  if (filters.stream !== 'all')
    chips.push({
      key: 'stream',
      label: STREAM_OPTIONS.find((o) => o.value === filters.stream)?.label,
      clientOnly: true,
      clear: { stream: 'all' },
    });
  if (filters.tier) chips.push({ key: 'tier', label: <>Tier · {filters.tier}</>, clientOnly: true, clear: { tier: '' } });

  return (
    <div className={styles.root}>
      <div className={styles.row}>
        <SegmentedControl<StatusFilter>
          size="sm"
          ariaLabel="Status"
          value={filters.status}
          options={STATUS_OPTIONS.map((o) => ({ value: o.value, label: o.label, title: o.title }))}
          onChange={(status) => onChange({ status })}
        />
        <PillSelect
          label="Model"
          allLabel="All"
          wide
          value={filters.model}
          options={modelOptions}
          onChange={(model) => onChange({ model })}
        />
        <PillSelect
          label="Credential"
          allLabel="All"
          wide
          value={filters.credential}
          options={credentialOptions}
          onChange={(credential) => onChange({ credential })}
        />
        <LatencyPill min={filters.minLatencyMs} max={filters.maxLatencyMs} onChange={onChange} />
        <PillSelect
          label="Cache"
          allLabel="Any"
          value={filters.cache}
          options={CACHE_OPTIONS.filter((o) => o.value !== '')}
          onChange={(cache) => onChange({ cache: cache as CacheFilter })}
        />
        <PillSelect
          label="Mode"
          allLabel="Any"
          value={filters.stream === 'all' ? '' : filters.stream}
          options={STREAM_OPTIONS.filter((o) => o.value !== 'all')}
          onChange={(stream) => onChange({ stream: (stream || 'all') as StreamFilter })}
        />
        <PillSelect
          label="Tier"
          allLabel="Any"
          value={filters.tier}
          options={tierOptions}
          onChange={(tier) => onChange({ tier })}
        />
      </div>

      {chips.length > 0 && (
        <div className={styles.chips} aria-label="Active filters">
          {chips.map((chip) => (
            <span
              key={chip.key}
              className={`${styles.chip} ${chip.clientOnly ? styles.chipClient : ''}`}
              title={chip.clientOnly ? 'Refined in the browser over loaded rows; KPIs and chart use the server scope' : undefined}
            >
              <span className={styles.chipLabel}>{chip.label}</span>
              <button type="button" className={styles.chipRemove} onClick={() => onChange(chip.clear)} aria-label="Remove filter">
                <IconX size={11} />
              </button>
            </span>
          ))}
          {chips.length > 1 && (
            <button type="button" className={styles.clearAll} onClick={onClearAll}>
              Clear all
            </button>
          )}
        </div>
      )}
    </div>
  );
}
