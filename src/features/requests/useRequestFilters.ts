import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { CLEARED_FILTERS, readFilters, writeFilters, type RequestFilters } from './model/filters';

const SEARCH_DEBOUNCE_MS = 350;

/**
 * Filter state in the URL. The search box is local and debounced into `?q=` so typing does not
 * fire a request per keystroke.
 */
export function useRequestFilters() {
  const [params, setParams] = useSearchParams();
  const filters = useMemo(() => readFilters(params), [params]);
  const [searchDraft, setSearchDraft] = useState(filters.search);

  const update = useCallback(
    (patch: Partial<RequestFilters>) => setParams((current) => writeFilters(current, patch), { replace: true }),
    [setParams],
  );

  // Debounce the draft into the URL.
  useEffect(() => {
    if (searchDraft.trim() === filters.search.trim()) return;
    const id = window.setTimeout(() => update({ search: searchDraft.trim() }), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(id);
  }, [searchDraft, filters.search, update]);

  // External URL changes (back/forward, chip removal) win over the draft.
  const [lastUrlSearch, setLastUrlSearch] = useState(filters.search);
  if (lastUrlSearch !== filters.search) {
    setLastUrlSearch(filters.search);
    if (searchDraft.trim() !== filters.search) setSearchDraft(filters.search);
  }

  const clearAll = useCallback(() => {
    setSearchDraft('');
    update({ ...CLEARED_FILTERS, search: '' });
  }, [update]);

  const view = params.get('view') ?? 'stream';
  const setView = useCallback(
    (next: string) =>
      setParams(
        (current) => {
          const updated = new URLSearchParams(current);
          if (next === 'stream') updated.delete('view');
          else updated.set('view', next);
          return updated;
        },
        { replace: true },
      ),
    [setParams],
  );

  return { filters, update, searchDraft, setSearchDraft, clearAll, view, setView };
}
