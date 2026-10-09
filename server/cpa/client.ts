/**
 * CLIProxyAPI management API helpers used by the collector: config, the usage-statistics toggle,
 * auth files and the HTTP usage queue. Every call sends the management key as a Bearer token and
 * nothing else from the browser (no XFF, cookies or origin).
 *
 * Never log the key or raw response bodies: CPA error bodies are reduced to a short, redacted
 * message on `CpaHttpError`.
 */
import http from 'node:http';
import https from 'node:https';

export interface CpaClientOptions {
  baseUrl: string;
  managementKey: string;
  tlsInsecure?: boolean;
  /** Default per-request timeout. */
  timeoutMs?: number;
}

export interface CpaResponse {
  status: number;
  /** `X-CPA-VERSION` response header, when present. */
  version: string | null;
  body: string;
}

/** A non-2xx response from CPA. */
export class CpaHttpError extends Error {
  readonly status: number;
  readonly path: string;
  constructor(status: number, path: string, detail: string) {
    super(`${path}: HTTP ${status}${detail ? ` ${detail}` : ''}`);
    this.name = 'CpaHttpError';
    this.status = status;
    this.path = path;
  }
}

/** HTTP queue endpoint missing (CPA without `usage-queue`). */
export function isUnsupportedStatus(status: number): boolean {
  return status === 404 || status === 405 || status === 501;
}

const MAX_BODY_BYTES = 64 * 1024 * 1024;

function shortDetail(body: string): string {
  let text = body.trim();
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const candidate = parsed?.error ?? parsed?.message;
    if (typeof candidate === 'string') text = candidate;
  } catch {
    // plain text
  }
  text = text.replace(/\s+/g, ' ').replace(/(bearer\s+)\S+/gi, '$1[redacted]');
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
}

export class CpaClient {
  readonly baseUrl: string;
  private readonly key: string;
  private readonly timeoutMs: number;
  private readonly agent: http.Agent | https.Agent;
  private readonly secure: boolean;
  /** Last `X-CPA-VERSION` seen on any response. */
  lastVersion: string | null = null;

  constructor(options: CpaClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.key = options.managementKey;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.secure = this.baseUrl.startsWith('https:');
    this.agent = this.secure
      ? new https.Agent({ keepAlive: true, maxSockets: 4, rejectUnauthorized: !options.tlsInsecure })
      : new http.Agent({ keepAlive: true, maxSockets: 4 });
  }

  /** Raw request; resolves for any status (callers decide). Rejects on network errors / timeouts. */
  request(
    method: 'GET' | 'PUT' | 'PATCH',
    path: string,
    options: { body?: unknown; timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<CpaResponse> {
    const url = new URL(this.baseUrl + path);
    const payload = options.body === undefined ? undefined : Buffer.from(JSON.stringify(options.body));
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.key}`,
      Accept: 'application/json',
    };
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(payload.length);
    }
    const transport = this.secure ? https : http;
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    return new Promise((resolve, reject) => {
      const req = transport.request(url, { method, headers, agent: this.agent, signal: options.signal }, (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_BODY_BYTES) {
            req.destroy(new Error(`${path}: response exceeds ${MAX_BODY_BYTES} bytes`));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          const raw = res.headers['x-cpa-version'];
          const version = (Array.isArray(raw) ? raw[0] : raw)?.trim() || null;
          if (version) this.lastVersion = version;
          resolve({ status: res.statusCode ?? 0, version, body: Buffer.concat(chunks).toString('utf8') });
        });
        res.on('error', reject);
      });
      req.setTimeout(timeoutMs, () => req.destroy(new Error(`${method} ${path} timed out after ${timeoutMs} ms`)));
      req.on('error', reject);
      req.end(payload);
    });
  }

  /** Request that must succeed with 2xx and a JSON body. */
  async json<T = unknown>(
    method: 'GET' | 'PUT' | 'PATCH',
    path: string,
    options: { body?: unknown; timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<{ data: T; version: string | null }> {
    const res = await this.request(method, path, options);
    if (res.status < 200 || res.status >= 300) throw new CpaHttpError(res.status, path, shortDetail(res.body));
    try {
      return { data: (res.body.trim() ? JSON.parse(res.body) : null) as T, version: res.version };
    } catch {
      throw new Error(`${path}: invalid JSON response`);
    }
  }

  /** `GET /v0/management/config` (contains secrets: read fields, never log it). */
  getConfig(signal?: AbortSignal): Promise<{ data: Record<string, unknown>; version: string | null }> {
    return this.json<Record<string, unknown>>('GET', '/v0/management/config', { timeoutMs: 10_000, signal });
  }

  /** `GET /v0/management/usage-statistics-enabled` → the flag (null when the body has no flag). */
  async getUsageStatisticsEnabled(signal?: AbortSignal): Promise<boolean | null> {
    const { data } = await this.json<Record<string, unknown>>('GET', '/v0/management/usage-statistics-enabled', {
      timeoutMs: 10_000,
      signal,
    });
    const value = data?.['usage-statistics-enabled'] ?? data?.value;
    return typeof value === 'boolean' ? value : null;
  }

  /** `PUT /v0/management/usage-statistics-enabled {"value":…}`. */
  async setUsageStatisticsEnabled(value: boolean, signal?: AbortSignal): Promise<void> {
    await this.json('PUT', '/v0/management/usage-statistics-enabled', { body: { value }, timeoutMs: 10_000, signal });
  }

  /** `GET /v0/management/auth-files` → the raw file objects. */
  async getAuthFiles(options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<Array<Record<string, unknown>>> {
    const { data } = await this.json<unknown>('GET', '/v0/management/auth-files', {
      timeoutMs: options.timeoutMs ?? 5_000,
      signal: options.signal,
    });
    return authFilesFromJson(data);
  }

  /**
   * `GET /v0/management/usage-queue?count=N` pops up to N records (destructive). Returns the raw
   * JSON text of each record, or null when CPA has no HTTP queue (404/405/501).
   */
  async popUsageQueue(count: number, signal?: AbortSignal): Promise<string[] | null> {
    const path = `/v0/management/usage-queue?count=${Math.max(1, Math.trunc(count))}`;
    const res = await this.request('GET', path, { signal });
    if (isUnsupportedStatus(res.status)) return null;
    if (res.status < 200 || res.status >= 300) throw new CpaHttpError(res.status, '/v0/management/usage-queue', shortDetail(res.body));
    return usageQueueItems(res.body);
  }

  close(): void {
    this.agent.destroy();
  }
}

/** Accepts `{files:[…]}` and the other shapes CPA versions have used. */
export function authFilesFromJson(data: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(data)) return data.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object');
  if (data && typeof data === 'object') {
    const record = data as Record<string, unknown>;
    for (const key of ['files', 'auth_files', 'authFiles', 'items', 'data']) {
      if (Array.isArray(record[key])) return authFilesFromJson(record[key]);
    }
  }
  return [];
}

/** Queue items are JSON objects or JSON strings holding a JSON object; nulls are skipped. */
export function usageQueueItems(body: string): string[] {
  const trimmed = body.trim();
  if (!trimmed) return [];
  const parsed = JSON.parse(trimmed) as unknown;
  if (!Array.isArray(parsed)) throw new Error('usage-queue: expected a JSON array');
  const items: string[] = [];
  for (const entry of parsed) {
    if (entry === null || entry === undefined) continue;
    if (typeof entry === 'string') {
      if (entry.trim()) items.push(entry);
      continue;
    }
    if (typeof entry === 'object' && !Array.isArray(entry)) {
      items.push(JSON.stringify(entry));
      continue;
    }
    throw new Error('usage-queue: unexpected item type');
  }
  return items;
}
