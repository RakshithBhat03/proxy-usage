import { DAY_MS, MINUTE_MS } from '@/lib/quota/parse';
import type { QuotaObservation } from './types';

/**
 * Browser-side quota log. The Manager keeps only the current and previous cycle per window, and
 * Claude responses do not carry quota headers into the event store, so every reading this page sees
 * (traffic signals, snapshots, Quota page live reads) is kept here. History then grows for as long
 * as the app is used, instead of being limited to what the server still has.
 * Rows hold only window ids, timestamps and percentages, keyed by auth-file name like the Quota
 * page's live cache.
 */

const STORAGE_KEY = 'proxy-usage.quota-history.v1';
const MAX_AGE_MS = 120 * DAY_MS;
const MAX_PER_WINDOW = 12;
const MAX_PER_CREDENTIAL = 1500;

/** [windowId, durationMs|null, resetAtMs, usedPercent, observedAtMs] */
type Row = [string, number | null, number, number, number];
type Store = Record<string, Row[]>;

function read(): Store {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Store = {};
    for (const [key, rows] of Object.entries(parsed as Record<string, unknown>)) {
      if (!Array.isArray(rows)) continue;
      out[key] = rows.filter(
        (r): r is Row =>
          Array.isArray(r) && r.length === 5 && typeof r[0] === 'string' && typeof r[2] === 'number' && typeof r[3] === 'number' && typeof r[4] === 'number',
      );
    }
    return out;
  } catch {
    return {};
  }
}

export function readLoggedObservations(credKey: string): QuotaObservation[] {
  return (read()[credKey] ?? []).map(([windowId, durationMs, resetAtMs, usedPercent, observedAtMs]) => ({
    windowId,
    durationMs,
    resetAtMs,
    usedPercent,
    observedAtMs,
    source: 'log' as const,
  }));
}

/** Keeps the first, last and highest readings of each window plus an even spread of the rest. */
function compact(rows: Row[]): Row[] {
  const groups = new Map<string, Row[]>();
  for (const row of rows) {
    const key = `${row[0]}|${Math.round(row[2] / (10 * MINUTE_MS))}`;
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }
  const out: Row[] = [];
  for (const list of groups.values()) {
    list.sort((a, b) => a[4] - b[4]);
    if (list.length <= MAX_PER_WINDOW) {
      out.push(...list);
      continue;
    }
    const keep = new Set<number>([0, list.length - 1]);
    let peak = 0;
    list.forEach((r, i) => {
      if (r[3] > list[peak][3]) peak = i;
    });
    keep.add(peak);
    const step = (list.length - 1) / (MAX_PER_WINDOW - 3);
    for (let i = 1; i <= MAX_PER_WINDOW - 4; i++) keep.add(Math.round(i * step));
    out.push(...[...keep].sort((a, b) => a - b).map((i) => list[i]));
  }
  return out.sort((a, b) => a[4] - b[4]).slice(-MAX_PER_CREDENTIAL);
}

/** Merges readings into the log; returns true when anything new was written. */
export function logObservations(byCredential: Map<string, QuotaObservation[]>, liveKeys: Set<string>, now = Date.now()): boolean {
  try {
    const store = read();
    let changed = false;
    for (const [credKey, observations] of byCredential) {
      const existing = store[credKey] ?? [];
      const seen = new Set(existing.map((r) => `${r[0]}|${r[4]}`));
      const added: Row[] = [];
      for (const o of observations) {
        if (o.source === 'log' || o.source === 'headers') continue;
        const id = `${o.windowId}|${o.observedAtMs}`;
        if (seen.has(id)) continue;
        seen.add(id);
        added.push([o.windowId, o.durationMs, o.resetAtMs, Math.round(o.usedPercent * 100) / 100, o.observedAtMs]);
      }
      if (added.length === 0) continue;
      store[credKey] = compact([...existing, ...added]);
      changed = true;
    }
    for (const key of Object.keys(store)) {
      const fresh = store[key].filter((r) => now - r[4] < MAX_AGE_MS);
      if (!liveKeys.has(key) && fresh.length === 0) {
        delete store[key];
        changed = true;
      } else if (fresh.length !== store[key].length) {
        store[key] = fresh;
        changed = true;
      }
    }
    if (changed) localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
    return changed;
  } catch {
    return false;
  }
}
