import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { EMPTY_FILTERS, KEYS, readFilters, readMetric, writeFilters, type ChartMetric, type UsageFilters } from './filters';

export interface UsageFilterState {
  filters: UsageFilters;
  metric: ChartMetric;
  update: (patch: Partial<UsageFilters>) => void;
  toggleIn: (key: 'models' | 'creds', value: string) => void;
  clearAll: () => void;
  setMetric: (metric: ChartMetric) => void;
}

export function useUsageFilters(): UsageFilterState {
  const [params, setParams] = useSearchParams();
  const filters = useMemo(() => readFilters(params), [params]);
  const metric = useMemo(() => readMetric(params), [params]);

  // Functional updates so concurrent writers (the range picker) never clobber each other.
  const update = useCallback(
    (patch: Partial<UsageFilters>) =>
      setParams((current) => writeFilters(current, { ...readFilters(current), ...patch }), { replace: true }),
    [setParams],
  );

  const toggleIn = useCallback(
    (key: 'models' | 'creds', value: string) =>
      setParams(
        (current) => {
          const state = readFilters(current);
          const list = state[key];
          const next = list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
          return writeFilters(current, { ...state, [key]: next });
        },
        { replace: true },
      ),
    [setParams],
  );

  const clearAll = useCallback(
    () =>
      setParams((current) => writeFilters(current, { ...readFilters(current), ...EMPTY_FILTERS }), { replace: true }),
    [setParams],
  );

  const setMetric = useCallback(
    (next: ChartMetric) =>
      setParams(
        (current) => {
          const updated = new URLSearchParams(current);
          if (next === 'requests') updated.delete(KEYS.metric);
          else updated.set(KEYS.metric, next);
          return updated;
        },
        { replace: true },
      ),
    [setParams],
  );

  return { filters, metric, update, toggleIn, clearAll, setMetric };
}
