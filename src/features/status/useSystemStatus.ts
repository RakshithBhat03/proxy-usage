import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api/client';
import type { SystemResponse } from '@shared/system-types.ts';

export type { SystemResponse } from '@shared/system-types.ts';

export const SYSTEM_QUERY_KEY = ['system-status'] as const;

/** `GET /api/system`; `refresh` forces a new CLIProxyAPI update check (the server rate-limits it). */
export function fetchSystem(signal?: AbortSignal, refresh = false): Promise<SystemResponse> {
  return api<SystemResponse>('/api/system', { signal, query: { refresh: refresh ? 1 : undefined } });
}

export function useSystemStatus() {
  return useQuery({
    queryKey: SYSTEM_QUERY_KEY,
    queryFn: ({ signal }) => fetchSystem(signal),
    staleTime: 10_000,
    refetchInterval: 15_000,
    retry: false,
  });
}
