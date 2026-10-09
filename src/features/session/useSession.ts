import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api/client';
import type { SessionResponse, StatusResponse } from '@shared/session-types.ts';

export type { CollectorStatus, SessionResponse, StatusResponse } from '@shared/session-types.ts';

export const SESSION_QUERY_KEY = ['session'] as const;
export const STATUS_QUERY_KEY = ['server-status'] as const;

/** `GET /api/session`: the server's collector, database and price-book health. */
export function fetchSession(signal?: AbortSignal, managementKey?: string): Promise<SessionResponse> {
  return api<SessionResponse>('/api/session', { signal, managementKey });
}

/** `GET /api/status` (public): CLIProxyAPI host, reachability and version for the sign-in screen. */
export function fetchStatus(signal?: AbortSignal): Promise<StatusResponse> {
  return api<StatusResponse>('/api/status', { signal });
}

export function useSession(enabled = true) {
  return useQuery({
    queryKey: SESSION_QUERY_KEY,
    queryFn: ({ signal }) => fetchSession(signal),
    enabled,
    staleTime: 15_000,
    refetchInterval: 30_000,
    retry: false,
  });
}

export function useServerStatus() {
  return useQuery({
    queryKey: STATUS_QUERY_KEY,
    queryFn: ({ signal }) => fetchStatus(signal),
    staleTime: 15_000,
    refetchInterval: 30_000,
    retry: false,
  });
}

const timeOf = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

/**
 * One short sentence when the server is not recording new requests (or might not be), else null.
 * Healthy and transient states (`starting`, `running`, a backoff without an error) say nothing.
 */
export function sessionProblem(session: SessionResponse | undefined): string | null {
  if (!session) return null;
  const { collector } = session;
  if (collector.state === 'disabled') {
    const reason = collector.disabled_reason?.replace(/\.$/, '');
    return `New requests are not being recorded: ${reason || 'the collector is disabled'}. Existing history is still shown.`;
  }
  if (collector.state === 'auth_failed') {
    const retry = collector.next_retry_at_ms ? ` Next attempt at ${timeOf(collector.next_retry_at_ms)}.` : '';
    return `New requests are not being recorded: CLIProxyAPI rejected the server's management key (CPA_MANAGEMENT_KEY).${retry}`;
  }
  if (collector.state === 'backoff' && collector.last_error) {
    const retry = collector.next_retry_at_ms ? ` Retrying at ${timeOf(collector.next_retry_at_ms)}.` : '';
    return `Lost the connection to CLIProxyAPI: ${collector.last_error.replace(/\.$/, '')}.${retry}`;
  }
  if (collector.usage_statistics_enabled === false) {
    return 'Usage statistics are turned off in CLIProxyAPI (usage-statistics-enabled: false), so new requests are not recorded.';
  }
  return null;
}

/**
 * When recorded history begins after `fromMs`, returns when it begins (so a page can say the start
 * of its range is empty because nothing was recorded yet, not because there was no traffic).
 * Null while unknown, when the range is fully covered, or for open-ended ranges like "All time".
 */
export function useHistoryStart(fromMs: number | null): number | null {
  const session = useSession();
  const oldest = session.data?.db.oldest_event_ms ?? null;
  if (fromMs === null || oldest === null) return null;
  // A minute of slack so a range that starts right at the first event does not trigger it.
  return oldest > fromMs + 60_000 ? oldest : null;
}
