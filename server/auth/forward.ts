/**
 * Forwards the allowlisted CLIProxyAPI management calls with the caller's own key.
 *
 *  - Upstream requests carry only Authorization (the caller's key), Accept, Accept-Encoding and,
 *    for POST, Content-Type — never Cookie, Origin, Host, X-Forwarded-For or hop-by-hop headers.
 *  - Responses stream back with CPA's status and headers, minus hop-by-hop headers, Set-Cookie and
 *    CORS headers. A CPA 401 becomes our `invalid_management_key` 401 (the UI signs out) and the
 *    key is dropped from the verifier's positive cache.
 *  - 60 s to get response headers, and 60 s socket idle while streaming.
 */
import type { IncomingMessage, OutgoingHttpHeaders } from 'node:http';
import { pipeline } from 'node:stream/promises';
import type { AuthOk } from './types.ts';
import type { AppContext } from '../context.ts';
import { readBody } from '../http/body.ts';
import { HttpError, sendError } from '../http/respond.ts';
import type { RequestContext } from '../http/router.ts';
import { CpaNetworkError, cpaRequest, noteCpaVersion } from './cpa.ts';
import type { AuthVerifierControls } from './verify.ts';

export const FORWARD_TIMEOUT_MS = 60_000;

const DROPPED_RESPONSE_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'set-cookie',
  'set-cookie2',
]);

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** CPA response headers that are safe to pass to the browser. */
export function filterResponseHeaders(upstream: IncomingMessage, alreadySet: (name: string) => boolean): OutgoingHttpHeaders {
  const connectionListed = new Set(
    (firstHeader(upstream.headers.connection) ?? '')
      .split(',')
      .map((name) => name.trim().toLowerCase())
      .filter(Boolean),
  );
  const out: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(upstream.headers)) {
    const lower = name.toLowerCase();
    if (value === undefined) continue;
    if (DROPPED_RESPONSE_HEADERS.has(lower) || connectionListed.has(lower)) continue;
    if (lower.startsWith('access-control-')) continue;
    // Keep this server's own security headers.
    if (alreadySet(lower)) continue;
    out[lower] = value;
  }
  if (!out['cache-control']) out['cache-control'] = 'no-store';
  return out;
}

export interface ForwardTarget {
  method: 'GET' | 'POST';
  /** Fixed CPA path; only the query string comes from the client. */
  path: string;
  /** Max request body for POST. */
  bodyLimitBytes?: number;
}

export async function forwardToCpa(ctx: AppContext, rc: RequestContext, auth: AuthOk, target: ForwardTarget): Promise<void> {
  const { req, res, url } = rc;
  const log = ctx.log.child('cpa-forward');

  const headers: OutgoingHttpHeaders = {
    Authorization: `Bearer ${auth.key}`,
    Accept: firstHeader(req.headers.accept) ?? '*/*',
  };
  const acceptEncoding = firstHeader(req.headers['accept-encoding']);
  if (acceptEncoding) headers['Accept-Encoding'] = acceptEncoding;

  let body: Buffer | undefined;
  if (target.method === 'POST') {
    const type = firstHeader(req.headers['content-type']);
    if (type && !/^application\/([\w.+-]+\+)?json\b/i.test(type)) {
      req.resume();
      throw new HttpError(415, 'unsupported_media_type', 'expected an application/json body');
    }
    body = await readBody(req, target.bodyLimitBytes ?? 1024 * 1024);
    headers['Content-Type'] = 'application/json';
  }

  const abort = new AbortController();
  const onClose = () => {
    if (!res.writableFinished) abort.abort();
  };
  res.on('close', onClose);

  let upstream: IncomingMessage;
  try {
    upstream = await cpaRequest(ctx.config, {
      method: target.method,
      path: target.path + url.search,
      headers,
      body,
      timeoutMs: FORWARD_TIMEOUT_MS,
      signal: abort.signal,
    });
  } catch (err) {
    res.off('close', onClose);
    if (abort.signal.aborted) return;
    const message = err instanceof CpaNetworkError ? err.message : 'cannot reach CLIProxyAPI';
    log.warn('forward failed', { path: target.path, error: message });
    await sendError(req, res, 502, 'cpa_unreachable', message);
    return;
  }
  noteCpaVersion(ctx.config.cpaUrl, upstream.headers);
  const status = upstream.statusCode ?? 502;

  if (status === 401) {
    upstream.resume();
    res.off('close', onClose);
    (ctx.requireAuth as Partial<AuthVerifierControls>).invalidate?.(auth.key);
    await sendError(req, res, 401, 'invalid_management_key', 'CLIProxyAPI rejected the management key');
    return;
  }

  res.writeHead(status, filterResponseHeaders(upstream, (name) => res.hasHeader(name)));
  if (req.method === 'HEAD') {
    upstream.resume();
    res.end();
    return;
  }
  try {
    await pipeline(upstream, res);
  } catch (err) {
    if (!abort.signal.aborted) log.warn('forward stream interrupted', { path: target.path, error: err });
    res.destroy();
  } finally {
    res.off('close', onClose);
  }
}
