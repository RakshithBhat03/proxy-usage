/**
 * Minimal HTTP client for the CLIProxyAPI calls the auth module makes: key verification, the
 * unauthenticated reachability probe and the management forwarding allowlist.
 *
 * Requests are built from scratch: only the headers passed in are sent (Host comes from CPA_URL),
 * so client headers such as Cookie, Origin or X-Forwarded-For can never leak through.
 */
import http, { type IncomingHttpHeaders, type IncomingMessage, type OutgoingHttpHeaders } from 'node:http';
import https from 'node:https';
import type { Config } from '../config.ts';

const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 16 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 16 });
const insecureHttpsAgent = new https.Agent({ keepAlive: true, maxSockets: 16, rejectUnauthorized: false });

/** Network failure or timeout talking to CPA (no HTTP response). */
export class CpaNetworkError extends Error {
  readonly timeout: boolean;
  constructor(message: string, timeout: boolean) {
    super(message);
    this.name = 'CpaNetworkError';
    this.timeout = timeout;
  }
}

export interface CpaRequestOptions {
  method: 'GET' | 'POST';
  /** Path (and optional `?query`) relative to CPA_URL, starting with `/`. */
  path: string;
  headers?: OutgoingHttpHeaders;
  body?: Buffer;
  /** Fails with a timeout when no response headers arrive in time; also the socket idle timeout. */
  timeoutMs: number;
  /** Aborts the upstream request (e.g. the client went away). */
  signal?: AbortSignal;
}

/** Sends one request to CPA and resolves with the (unconsumed) response. */
export function cpaRequest(config: Pick<Config, 'cpaUrl' | 'cpaTlsInsecure'>, options: CpaRequestOptions): Promise<IncomingMessage> {
  const target = new URL(config.cpaUrl + options.path);
  const isHttps = target.protocol === 'https:';
  const transport = isHttps ? https : http;
  const agent = isHttps ? (config.cpaTlsInsecure ? insecureHttpsAgent : httpsAgent) : httpAgent;
  const headers: OutgoingHttpHeaders = { ...options.headers };
  if (options.body) headers['Content-Length'] = options.body.length;

  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    const req = transport.request(target, { method: options.method, headers, agent, signal: options.signal }, (res) => {
      if (settled) {
        res.resume();
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(res);
    });
    const timer = setTimeout(() => {
      fail(new CpaNetworkError(`CLIProxyAPI did not respond within ${Math.round(options.timeoutMs / 1000)}s`, true));
      req.destroy();
    }, options.timeoutMs);
    req.setTimeout(options.timeoutMs, () => {
      fail(new CpaNetworkError('CLIProxyAPI connection timed out', true));
      req.destroy();
    });
    req.on('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      fail(new CpaNetworkError(`cannot reach CLIProxyAPI (${err.code ?? err.message})`, false));
    });
    req.end(options.body);
  });
}

/** Reads a (small) response body, giving up silently beyond `limitBytes`. */
export async function readCpaBody(res: IncomingMessage, limitBytes = 64 * 1024): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of res) {
      size += (chunk as Buffer).length;
      if (size > limitBytes) {
        res.destroy();
        break;
      }
      chunks.push(chunk as Buffer);
    }
  } catch {
    // Truncated body: use what arrived.
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** CPA's `{ "error": "..." }` message (or the raw text), trimmed for display. */
export function cpaErrorMessage(body: string): string {
  let message = body.trim();
  try {
    const parsed = JSON.parse(body) as unknown;
    if (parsed && typeof parsed === 'object') {
      const value = (parsed as Record<string, unknown>).error ?? (parsed as Record<string, unknown>).message;
      if (typeof value === 'string') message = value;
    }
  } catch {
    // Not JSON.
  }
  message = message.replace(/\s+/g, ' ');
  return message.length > 200 ? `${message.slice(0, 200)}…` : message;
}

// --- CPA build seen on responses (management responses carry X-CPA-VERSION/-COMMIT/-BUILD-DATE) ---

export interface CpaBuild {
  version: string;
  commit: string | null;
  buildDate: string | null;
}

const builds = new Map<string, CpaBuild>();

function shortHeader(headers: IncomingHttpHeaders, name: string): string | null {
  const raw = headers[name];
  const value = (Array.isArray(raw) ? raw[0] : raw)?.trim();
  return value && value.length <= 64 ? value : null;
}

export function noteCpaVersion(cpaUrl: string, headers: IncomingHttpHeaders): void {
  const version = shortHeader(headers, 'x-cpa-version');
  if (!version) return;
  builds.set(cpaUrl, {
    version,
    commit: shortHeader(headers, 'x-cpa-commit'),
    buildDate: shortHeader(headers, 'x-cpa-build-date'),
  });
}

export function knownCpaVersion(cpaUrl: string): string | null {
  return builds.get(cpaUrl)?.version ?? null;
}

export function knownCpaBuild(cpaUrl: string): CpaBuild | null {
  return builds.get(cpaUrl) ?? null;
}

/** host[:port] of CPA_URL (no scheme, credentials or path). */
export function cpaHost(cpaUrl: string): string {
  try {
    return new URL(cpaUrl).host;
  } catch {
    return '';
  }
}
