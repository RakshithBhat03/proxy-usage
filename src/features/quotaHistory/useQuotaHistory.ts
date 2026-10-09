import { useEffect, useMemo } from 'react';
import { keepPreviousData, useQueries, useQuery } from '@tanstack/react-query';
import { AUTH_FILES_QUERY_KEY, fetchAuthFiles } from '@/lib/api/authFiles';
import { DAY_MS, MINUTE_MS } from '@/lib/quota/parse';
import { fetchHeaderHistory, fetchWindowUsage, type UsageTarget } from '@/lib/quotaHistory/api';
import { buildWindows } from '@/lib/quotaHistory/build';
import { logObservations, readLoggedObservations } from '@/lib/quotaHistory/log';
import { HEADER_QUOTA_PROVIDERS, historyCredentials, observationsFromSignals, observationsFromStoredLive, windowModelScope, type WindowModelScope } from '@/lib/quotaHistory/sources';
import { normalizeProvider } from '@/lib/providers';
import type { HistoryCredential, HistoryWindow, QuotaObservation, WindowUsage } from '@/lib/quotaHistory/types';
import { USAGE_QUERY_ROOT } from '@/features/usage/useUsageData';

export type HistoryRange = '7d' | '14d' | '30d' | '90d';
export const RANGE_DAYS: Record<HistoryRange, number> = { '7d': 7, '14d': 14, '30d': 30, '90d': 90 };

export const QUOTA_HISTORY_ROOT = [USAGE_QUERY_ROOT, 'quota-history'] as const;
const ROOT = QUOTA_HISTORY_ROOT;
const POLL_MS = 60_000;

export interface CredentialHistory {
  cred: HistoryCredential;
  /** Oldest first, every window id mixed; already limited to the range. */
  windows: HistoryWindow[];
  usage: Record<string, WindowUsage>;
  /** Usage of each current window up to its latest quota reading (for the capacity estimate). */
  usageAtReading: Record<string, WindowUsage>;
  /** Which models each window id meters; usage is only fetched for known scopes. */
  scopes: Record<string, WindowModelScope>;
  earliestReadingMs: number | null;
  truncatedBeforeMs: number | null;
  headerError: Error | null;
}

export const usageKey = (cred: HistoryCredential, window: HistoryWindow) => `${cred.key}|${window.uid}`;
const readingKey = (cred: HistoryCredential, window: HistoryWindow) => `${cred.key}|${window.uid}|reading`;

interface Params {
  /** Restrict to these auth-file names or auth indexes; null = every credential. */
  credKeys: string[] | null;
  /** Normalized provider id, or 'all'. */
  provider?: string;
  range: HistoryRange;
  now: number;
  enabled: boolean;
}

/** True when `keys` names this credential by auth-file name or auth index. */
export const credMatches = (cred: HistoryCredential, keys: readonly string[]) =>
  keys.includes(cred.key) || (cred.authIndex !== null && keys.includes(cred.authIndex));

export const providerMatches = (cred: HistoryCredential, provider: string) => provider === 'all' || normalizeProvider(cred.provider) === provider;

/** Every credential a history can be shown for (the auth-file list). */
export function useHistoryCredentials(enabled: boolean) {
  const files = useQuery({
    queryKey: AUTH_FILES_QUERY_KEY,
    queryFn: ({ signal }) => fetchAuthFiles(signal),
    staleTime: 30_000,
    refetchInterval: enabled ? POLL_MS : false,
    enabled,
  });
  const allCreds = useMemo(() => historyCredentials(files.data ?? []), [files.data]);
  return { files, allCreds };
}

export function useQuotaHistory({ credKeys, provider = 'all', range, now, enabled }: Params) {
  const { files, allCreds } = useHistoryCredentials(enabled);
  const creds = useMemo(
    () =>
      allCreds.filter((c) => providerMatches(c, provider) && (credKeys === null || credMatches(c, credKeys))),
    [allCreds, credKeys, provider],
  );

  // A 10-minute-aligned range start keeps query keys stable between renders.
  const fromMs = Math.floor((now - RANGE_DAYS[range] * DAY_MS) / (10 * MINUTE_MS)) * 10 * MINUTE_MS;
  const headerCreds = creds.filter((c) => HEADER_QUOTA_PROVIDERS.has(c.provider) && c.authIndex);
  const headers = useQueries({
    queries: headerCreds.map((cred) => ({
      queryKey: [...ROOT, 'headers', cred.authIndex, range],
      queryFn: ({ signal }: { signal: AbortSignal }) => fetchHeaderHistory(cred, fromMs, signal),
      enabled,
      staleTime: 30_000,
      refetchInterval: enabled ? POLL_MS : (false as const),
      placeholderData: keepPreviousData,
    })),
  });
  const headerByKey = new Map(headerCreds.map((cred, i) => [cred.key, headers[i]]));
  const headerStamp = headers.map((h) => `${h.dataUpdatedAt}:${h.errorUpdatedAt}`).join(',');

  /* Passive readings: auth-file signals and the Quota page's live cache (header readings and our own log join below). */
  const passive = useMemo(() => {
    const map = new Map<string, QuotaObservation[]>();
    for (const cred of creds) {
      map.set(cred.key, [...observationsFromSignals(cred), ...observationsFromStoredLive(cred)]);
    }
    return map;
  }, [creds]);

  useEffect(() => {
    if (!enabled || passive.size === 0) return;
    logObservations(passive, new Set(allCreds.map((c) => c.key)));
  }, [enabled, passive, allCreds]);

  const built = useMemo(() => {
    return creds.map((cred) => {
      const header = headerByKey.get(cred.key)?.data;
      const observations = [...(passive.get(cred.key) ?? []), ...readLoggedObservations(cred.key), ...(header?.observations ?? [])];
      const windows = buildWindows(observations, {
        provider: cred.provider,
        now,
        scheduleBackToMs: fromMs,
      }).filter((w) => w.endMs > fromMs);
      const earliest = observations.reduce((min, o) => Math.min(min, o.observedAtMs), Infinity);
      const scopes: Record<string, WindowModelScope> = {};
      for (const w of windows) scopes[w.windowId] ??= windowModelScope(cred, w.windowId);
      return {
        cred,
        windows,
        scopes,
        earliestReadingMs: Number.isFinite(earliest) ? earliest : null,
        truncatedBeforeMs: header?.truncatedBeforeMs ?? null,
        headerError: (headerByKey.get(cred.key)?.error as Error | null | undefined) ?? null,
      };
    });
    // headerStamp stands in for the per-query results array, which is a new object every render.
  }, [creds, passive, headerStamp, now, fromMs]);

  const targets = useMemo(() => {
    const list: UsageTarget[] = [];
    for (const { cred, windows, scopes } of built) {
      for (const window of windows) {
        const scope = scopes[window.windowId];
        // Counting an unknown scope account-wide would report other models' traffic as this window's.
        if (scope.kind === 'unknown') continue;
        const models = scope.kind === 'models' ? scope.models : undefined;
        const current = window.status === 'current';
        list.push({ key: usageKey(cred, window), cred, windowId: window.windowId, period: current ? 'current' : 'previous', fromMs: window.startMs, toMs: current ? null : window.endMs, models });
        const at = window.lastObservedAtMs;
        if (current && at !== null && at > window.startMs + MINUTE_MS && at < now - MINUTE_MS) {
          list.push({ key: readingKey(cred, window), cred, windowId: window.windowId, period: 'current', fromMs: window.startMs, toMs: at, models });
        }
      }
    }
    return list;
  }, [built, now]);
  const targetSignature = targets.map((t) => `${t.key}:${Math.floor(t.fromMs)}:${t.toMs === null ? 'open' : Math.floor(t.toMs)}:${t.models?.join(',') ?? '*'}`);

  const usage = useQuery({
    queryKey: [...ROOT, 'usage', targetSignature],
    queryFn: ({ signal }) => fetchWindowUsage(targets, signal),
    enabled: enabled && targets.length > 0,
    staleTime: 30_000,
    refetchInterval: enabled ? POLL_MS : false,
    placeholderData: keepPreviousData,
  });

  const rows = useMemo<CredentialHistory[]>(() => {
    const data = usage.data ?? {};
    return built.map((entry) => {
      const usageByUid: Record<string, WindowUsage> = {};
      const atReading: Record<string, WindowUsage> = {};
      const windows = entry.windows.filter((window) => {
        const u = data[usageKey(entry.cred, window)];
        if (u) usageByUid[window.uid] = u;
        const r = data[readingKey(entry.cred, window)];
        if (r) atReading[window.uid] = r;
        // Schedule-extrapolated weeks only earn a row when traffic actually happened in them.
        return window.boundary !== 'schedule' || (u !== undefined && u.requests > 0);
      });
      return { ...entry, windows, usage: usageByUid, usageAtReading: atReading };
    });
  }, [built, usage.data]);

  const headerPending = headers.some((h) => h.isPending && h.fetchStatus !== 'idle');
  return {
    allCreds,
    rows,
    fromMs,
    loading: files.isPending || headerPending,
    usageLoading: usage.isPending && targets.length > 0,
    fetching: files.isFetching || usage.isFetching || headers.some((h) => h.isFetching),
    error: (files.error as Error | null) ?? null,
    usageError: usage.error as Error | null,
  };
}
