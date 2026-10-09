import { useCallback, useMemo, useRef } from 'react';
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { AUTH_FILES_QUERY_KEY, useAuthFiles } from '@/lib/api/authFiles';
import { resolveQuotaErrorMessage } from '@/lib/quota/apiCall';
import { classifyQuotaFiles } from '@/lib/quota/files';
import { LIVE_STALE_MS, liveLimiter, readStoredLive, storeLive, toLiveAccount } from '@/lib/quota/live';
import { mergeCachedQuota, resolveDisplayQuota } from '@/lib/quota/model';
import { fetchLiveQuota } from '@/lib/quota/providers';
import { quotaFromSignals } from '@/lib/quota/signals';
import { querySnapshots } from '@/lib/quota/snapshots';
import { statusOfError, type AccountQuota, type QuotaData, type QuotaEntry } from '@/lib/quota/types';

export type CardStatus = 'idle' | 'loading' | 'success' | 'error';

/** Everything the views need for one credential, derived from the single react-query store. */
export interface QuotaEntryState {
  entry: QuotaEntry;
  /** Best available numbers: live answer, else newest cached (signals / snapshot). */
  quota: AccountQuota | null;
  status: CardStatus;
  /** A live request for this credential is in flight. */
  fetching: boolean;
  /** Last live attempt failed (numbers may still be cached). */
  error: string | null;
  hasLive: boolean;
}

const liveKey = (entry: QuotaEntry) => ['quota', 'live', entry.key, entry.authIndex ?? ''] as const;

/**
 * One normalized store: the auth-file list, optional Manager snapshots and one live query per
 * credential, all in react-query. Live queries paint from the last stored answer and only re-ask
 * the provider when that answer is older than LIVE_STALE_MS; nothing polls.
 */
export function useQuotaData(now: number) {
  const queryClient = useQueryClient();
  const filesQuery = useAuthFiles();
  const entries = useMemo(() => classifyQuotaFiles(filesQuery.data ?? []), [filesQuery.data]);
  const activeEntries = useMemo(() => entries.filter((entry) => !entry.disabled), [entries]);
  const liveKeys = useMemo(() => new Set(entries.map((entry) => entry.key)), [entries]);
  const liveKeysRef = useRef(liveKeys);
  liveKeysRef.current = liveKeys;
  /** Keys whose next live fetch may run side-effecting probes (explicit single-card clicks only). */
  const probeKeysRef = useRef(new Set<string>());

  const snapshotSignature = activeEntries.map((entry) => `${entry.key}:${entry.authIndex}`).join('|');
  const snapshotsQuery = useQuery({
    queryKey: ['quota', 'snapshots', snapshotSignature],
    queryFn: ({ signal }) => querySnapshots(activeEntries, signal).catch((): Record<string, AccountQuota> => ({})),
    enabled: activeEntries.length > 0,
    staleTime: LIVE_STALE_MS,
    retry: false,
    refetchOnWindowFocus: false,
  });

  const liveResults = useQueries({
    queries: activeEntries.map((entry) => {
      return {
        queryKey: liveKey(entry),
        queryFn: async ({ signal }: { signal: AbortSignal }): Promise<QuotaData> => {
          const allowProbe = probeKeysRef.current.delete(entry.key);
          const data = await liveLimiter(() => fetchLiveQuota(entry, { signal, allowProbe }), signal);
          storeLive(entry.key, data, liveKeysRef.current);
          return data;
        },
        // Lazy: storage is only read when the query is first created, not on every render.
        initialData: () => readStoredLive(entry.key)?.data,
        initialDataUpdatedAt: () => readStoredLive(entry.key)?.at,
        staleTime: LIVE_STALE_MS,
        gcTime: 30 * 60_000,
        retry: false,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
      };
    }),
  });

  const liveByKey = useMemo(() => {
    const map = new Map<string, (typeof liveResults)[number]>();
    activeEntries.forEach((entry, index) => map.set(entry.key, liveResults[index]));
    return map;
  }, [activeEntries, liveResults]);

  const snapshots = snapshotsQuery.data;
  const states = useMemo(() => {
    const map = new Map<string, QuotaEntryState>();
    for (const entry of entries) {
      const result = liveByKey.get(entry.key);
      const cached = mergeCachedQuota(quotaFromSignals(entry, now), snapshots?.[entry.key]);
      const live = result?.data ? toLiveAccount(result.data, result.dataUpdatedAt) : null;
      const quota = resolveDisplayQuota(live, cached);
      const fetching = result?.fetchStatus === 'fetching';
      const rawError = result?.error;
      // A newer success clears an older failure (react-query keeps both around).
      const failedLast = Boolean(rawError) && (result?.errorUpdatedAt ?? 0) >= (result?.dataUpdatedAt ?? 0);
      const error = failedLast && rawError ? resolveQuotaErrorMessage(statusOfError(rawError), rawError.message || 'Request failed') : null;
      const status: CardStatus = quota ? 'success' : fetching ? 'loading' : error ? 'error' : 'idle';
      map.set(entry.key, { entry, quota, status, fetching, error, hasLive: Boolean(live) });
    }
    return map;
  }, [entries, liveByKey, snapshots, now]);

  /** Re-reads one credential live. Null when skipped (already loading / unknown credential). */
  const refreshOne = useCallback(
    async (entry: QuotaEntry): Promise<{ error: string | null } | null> => {
      const result = liveByKey.get(entry.key);
      if (!result || result.fetchStatus === 'fetching') return null;
      probeKeysRef.current.add(entry.key);
      const outcome = await result.refetch({ cancelRefetch: false });
      probeKeysRef.current.delete(entry.key);
      if (outcome.error) return { error: resolveQuotaErrorMessage(statusOfError(outcome.error), outcome.error.message || 'Request failed') };
      return { error: null };
    },
    [liveByKey],
  );

  /** "Refresh all credentials": re-read the list, then every enabled credential live. */
  const refreshAll = useCallback(async () => {
    await queryClient.refetchQueries({ queryKey: AUTH_FILES_QUERY_KEY });
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['quota', 'snapshots'] }),
      queryClient.refetchQueries({ queryKey: ['quota', 'live'], type: 'active' }),
    ]);
  }, [queryClient]);

  const refreshing = filesQuery.isFetching || liveResults.some((result) => result.fetchStatus === 'fetching');

  return {
    entries,
    states,
    filesQuery,
    refreshOne,
    refreshAll,
    refreshing,
  };
}
