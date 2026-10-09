/**
 * Client for the analytics query endpoint. The request/response types live in
 * `shared/analytics-types.ts` so the server can use them too; they are re-exported here.
 */
import { api } from './client';
import type { AnalyticsRequest, AnalyticsResponse } from '@shared/analytics-types.ts';

export type * from '@shared/analytics-types.ts';

export function queryAnalytics(request: AnalyticsRequest, signal?: AbortSignal): Promise<AnalyticsResponse> {
  return api<AnalyticsResponse>('/api/analytics', { method: 'POST', body: request, signal });
}

/** The browser's IANA zone; buckets, heatmaps and day boundaries align to it server-side. */
export const LOCAL_TIME_ZONE = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
})();
