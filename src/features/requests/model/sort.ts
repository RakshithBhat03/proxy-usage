import type { EventRow } from '@/lib/api/analytics';
import { eventOutputTps } from '@/lib/pricing';
import { cacheReadTokens, statusCodeOf } from './events';

export type SortKey = 'time' | 'status' | 'model' | 'input' | 'cache' | 'cacheWrite' | 'output' | 'latency' | 'ttft' | 'tps' | 'cost';
export interface SortState {
  key: SortKey;
  dir: 'asc' | 'desc';
}

export const DEFAULT_SORT: SortState = { key: 'time', dir: 'desc' };

type Value = number | string | null;

function valueOf(event: EventRow, key: SortKey, cost: (e: EventRow) => number | null): Value {
  switch (key) {
    case 'time':
      return event.timestamp_ms;
    case 'status':
      return statusCodeOf(event);
    case 'model':
      return (event.model || '').toLowerCase();
    case 'input':
      return event.input_tokens;
    case 'cache':
      return cacheReadTokens(event);
    case 'cacheWrite':
      return event.cache_creation_tokens ?? 0;
    case 'output':
      return event.output_tokens;
    case 'latency':
      return event.latency_ms ?? null;
    case 'ttft':
      return event.ttft_ms || null;
    case 'tps':
      return eventOutputTps(event);
    case 'cost':
      return cost(event);
  }
}

/** Client-side sort over loaded rows. Missing values always sink; ties fall back to newest first. */
export function sortRows(rows: EventRow[], sort: SortState, cost: (e: EventRow) => number | null): EventRow[] {
  if (sort.key === 'time' && sort.dir === 'desc') return rows;
  const factor = sort.dir === 'asc' ? 1 : -1;
  const keyed = rows.map((event) => ({ event, value: valueOf(event, sort.key, cost) }));
  keyed.sort((a, b) => {
    if (a.value === null && b.value === null) return b.event.timestamp_ms - a.event.timestamp_ms;
    if (a.value === null) return 1;
    if (b.value === null) return -1;
    const cmp =
      typeof a.value === 'string' && typeof b.value === 'string'
        ? a.value.localeCompare(b.value)
        : Number(a.value) - Number(b.value);
    return cmp !== 0 ? cmp * factor : b.event.timestamp_ms - a.event.timestamp_ms;
  });
  return keyed.map((k) => k.event);
}

export function nextSort(current: SortState, key: SortKey): SortState {
  if (current.key === key) return { key, dir: current.dir === 'desc' ? 'asc' : 'desc' };
  return { key, dir: key === 'model' ? 'asc' : 'desc' };
}
