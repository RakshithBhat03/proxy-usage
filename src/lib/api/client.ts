import { useAuthStore } from '@/stores/auth';

export class ApiError extends Error {
  readonly status: number;
  /** Machine-readable `code` from the server's error body (e.g. `invalid_management_key`). */
  readonly code?: string;
  /** Seconds to wait before retrying, for rate-limited responses (`retry_after_s`). */
  readonly retryAfterS?: number;
  readonly body?: unknown;

  constructor(message: string, status: number, code?: string, body?: unknown, retryAfterS?: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.body = body;
    this.retryAfterS = retryAfterS;
  }
}

export type QueryValue = string | number | boolean | null | undefined | Array<string | number>;
export type Query = Record<string, QueryValue>;

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  query?: Query;
  body?: unknown;
  signal?: AbortSignal;
  /** Override the stored management key (used by the login form to validate a candidate key). */
  managementKey?: string;
  headers?: Record<string, string>;
}

export function buildQuery(query?: Query): string {
  if (!query) return '';
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      for (const item of value) params.append(key, String(item));
    } else {
      params.append(key, String(value));
    }
  }
  const text = params.toString();
  return text ? `?${text}` : '';
}

/**
 * Fetches JSON from this app's server (same origin). A 401 clears the stored key so the app falls
 * back to the login screen instead of rendering a wall of errors; calls that pass an explicit
 * `managementKey` (login validation) never log out.
 */
export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const key = options.managementKey ?? useAuthStore.getState().managementKey;
  const headers: Record<string, string> = { Accept: 'application/json', ...options.headers };
  if (key) headers.Authorization = `Bearer ${key}`;
  let body: BodyInit | undefined;
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.body);
  }

  const response = await fetch(`${path}${buildQuery(options.query)}`, {
    method: options.method ?? (body ? 'POST' : 'GET'),
    headers,
    body,
    signal: options.signal,
  });

  const text = await response.text();
  let data: unknown = undefined;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  if (!response.ok) {
    if (response.status === 401 && options.managementKey === undefined) useAuthStore.getState().logout();
    const record = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
    const message =
      (typeof record.error === 'string' && record.error) ||
      (typeof record.message === 'string' && record.message) ||
      (typeof data === 'string' && data.slice(0, 200)) ||
      `Request failed (${response.status})`;
    const retryAfter = Number(record.retry_after_s ?? response.headers.get('Retry-After'));
    throw new ApiError(
      message,
      response.status,
      typeof record.code === 'string' ? record.code : undefined,
      data,
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
    );
  }
  return data as T;
}
