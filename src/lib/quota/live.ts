import { isRecord } from './parse';
import type { AccountQuota, QuotaData } from './types';

/**
 * Live-refresh plumbing: a small concurrency limiter for `api-call` (CPA proxies each one to a
 * provider; bursts look like abuse upstream), and a localStorage copy of the last live answers so a
 * reload paints real numbers instantly and only re-asks when they are stale.
 */

export const LIVE_CONCURRENCY = 3;
/** Live answers younger than this are reused on mount instead of hitting the provider again. */
export const LIVE_STALE_MS = 5 * 60_000;

export function createLimiter(concurrency: number) {
  let active = 0;
  const queue: Array<() => void> = [];
  const next = () => {
    while (active < concurrency && queue.length > 0) {
      active += 1;
      queue.shift()?.();
    }
  };
  return function run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const start = () => {
        if (signal?.aborted) {
          active -= 1;
          next();
          reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
          return;
        }
        task().then(resolve, reject).finally(() => {
          active -= 1;
          next();
        });
      };
      queue.push(start);
      next();
    });
  };
}

export const liveLimiter = createLimiter(LIVE_CONCURRENCY);

const STORAGE_KEY = 'proxy-usage.quota.live.v1';
const MAX_AGE_MS = 7 * 24 * 3_600_000;

interface StoredLive {
  data: QuotaData;
  at: number;
}

function readAll(): Record<string, StoredLive> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
    return isRecord(parsed) ? (parsed as Record<string, StoredLive>) : {};
  } catch {
    return {};
  }
}

export function readStoredLive(key: string): StoredLive | undefined {
  const entry = readAll()[key];
  if (!entry || typeof entry.at !== 'number' || !isRecord(entry.data) || !Array.isArray(entry.data.windows)) return undefined;
  if (Date.now() - entry.at > MAX_AGE_MS) return undefined;
  return entry;
}

/** Quota numbers only (no tokens or emails); keys of removed credentials are pruned. */
export function storeLive(key: string, data: QuotaData, liveKeys?: Set<string>) {
  try {
    const all = readAll();
    all[key] = { data, at: Date.now() };
    for (const existing of Object.keys(all)) {
      if ((liveKeys && !liveKeys.has(existing) && existing !== key) || Date.now() - all[existing].at > MAX_AGE_MS) delete all[existing];
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {
    /* storage unavailable: the next mount simply refetches */
  }
}

export const toLiveAccount = (data: QuotaData, at: number): AccountQuota => ({ ...data, source: 'live', observedAtMs: at });
