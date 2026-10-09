import { api } from '@/lib/api/client';
import { useAuthStore } from '@/stores/auth';
import { isRecord } from './parse';
import { QuotaStatusError } from './types';

/**
 * `POST /v0/management/api-call`: CPA performs the upstream request with the credential's own
 * token (literal `$TOKEN$` is substituted server-side), so the browser never sees provider secrets.
 */
export interface ApiCallRequest {
  authIndex: string;
  method: 'GET' | 'POST';
  url: string;
  header?: Record<string, string>;
  data?: string;
}

export interface ApiCallResult {
  statusCode: number;
  header: Record<string, string[]>;
  bodyText: string;
  body: unknown;
}

const normalizeBody = (input: unknown): { bodyText: string; body: unknown } => {
  if (input === undefined || input === null) return { bodyText: '', body: null };
  if (typeof input === 'string') {
    const trimmed = input.trim();
    if (!trimmed) return { bodyText: input, body: null };
    try {
      return { bodyText: input, body: JSON.parse(trimmed) };
    } catch {
      return { bodyText: input, body: input };
    }
  }
  try {
    return { bodyText: JSON.stringify(input), body: input };
  } catch {
    return { bodyText: String(input), body: input };
  }
};

/** Aborts the request after `timeoutMs` (optional upstream calls must not hold a card hostage). */
function withTimeout(signal: AbortSignal | undefined, timeoutMs: number | undefined): AbortSignal | undefined {
  if (!timeoutMs) return signal;
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export async function apiCall(
  payload: ApiCallRequest,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<ApiCallResult> {
  const response = await api<Record<string, unknown> | null>('/v0/management/api-call', {
    method: 'POST',
    body: payload,
    signal: withTimeout(options.signal, options.timeoutMs),
  });
  const record = response ?? {};
  const { bodyText, body } = normalizeBody(record.body);
  const header = (isRecord(record.header) ? record.header : isRecord(record.headers) ? record.headers : {}) as Record<
    string,
    string[]
  >;
  return { statusCode: Number(record.status_code ?? record.statusCode ?? 0), header, bodyText, body };
}

export const isOk = (result: ApiCallResult) => result.statusCode >= 200 && result.statusCode < 300;

export function getApiCallErrorMessage(result: ApiCallResult): string {
  const { statusCode: status, body, bodyText } = result;
  let message = '';
  if (isRecord(body)) {
    const error = body.error;
    if (isRecord(error) && typeof error.message === 'string') message = error.message;
    else if (typeof error === 'string') message = error;
    if (!message && typeof body.message === 'string') message = body.message;
  } else if (typeof body === 'string') {
    message = body;
  }
  if (!message && bodyText) message = bodyText;
  message = message.slice(0, 240);
  if (status && message) return `${status} ${message}`.trim();
  if (status) return `HTTP ${status}`;
  return message || 'Request failed';
}

/** Throws a status-carrying error for a non-2xx upstream answer. */
export function assertOk(result: ApiCallResult): void {
  if (!isOk(result)) throw new QuotaStatusError(getApiCallErrorMessage(result), result.statusCode);
}

/** CPAMC's friendlier wording for the two statuses users can act on. */
export function resolveQuotaErrorMessage(status: number | undefined, message: string): string {
  if (status === 404) return 'Please update the CPA version or check for updates';
  if (status === 403) return 'Please check the credential status';
  return message;
}

/**
 * Downloads an auth file's raw JSON. Only Kimi (domain) and Meta (dca_token) need it; the text is
 * read for one request and never stored.
 */
export async function downloadAuthFileText(name: string, signal?: AbortSignal): Promise<string> {
  const key = useAuthStore.getState().managementKey;
  const response = await fetch(`/v0/management/auth-files/download?name=${encodeURIComponent(name)}`, {
    headers: key ? { Authorization: `Bearer ${key}` } : undefined,
    signal,
  });
  if (!response.ok) throw new QuotaStatusError(`Download failed (${response.status})`, response.status);
  return response.text();
}
