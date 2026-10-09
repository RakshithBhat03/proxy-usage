/**
 * Response helpers. JSON bodies over 1 KB are gzipped when the client accepts it. Errors always use
 * the `{ error, code }` shape (plus optional extra fields such as `retry_after_s`).
 */
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http';
import { promisify } from 'node:util';
import { gzip as gzipCallback } from 'node:zlib';

const gzip = promisify(gzipCallback);

/** Minimum body size worth compressing. */
export const GZIP_MIN_BYTES = 1024;

/** Thrown by handlers (and helpers like `readJson`) to send a `{ error, code }` response. */
export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly extra: Record<string, unknown> | undefined;
  readonly headers: OutgoingHttpHeaders | undefined;

  constructor(
    status: number,
    code: string,
    message: string,
    extra?: Record<string, unknown>,
    headers?: OutgoingHttpHeaders,
  ) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.extra = extra;
    this.headers = headers;
  }
}

export function acceptsGzip(req: IncomingMessage): boolean {
  const header = req.headers['accept-encoding'];
  const value = Array.isArray(header) ? header.join(',') : (header ?? '');
  return /\bgzip\b/i.test(value) && !/\bgzip\s*;\s*q\s*=\s*0(\.0*)?\b/i.test(value);
}

/**
 * Sends an already-serialized JSON document. Use this when the body was produced elsewhere (e.g. a
 * worker thread) to avoid a parse/stringify round trip.
 */
export async function sendJsonText(
  req: IncomingMessage,
  res: ServerResponse,
  status: number,
  json: string,
  headers: OutgoingHttpHeaders = {},
): Promise<void> {
  if (res.headersSent) {
    res.end();
    return;
  }
  let body: Buffer = Buffer.from(json, 'utf8');
  const out: OutgoingHttpHeaders = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    Vary: 'Accept-Encoding',
    ...headers,
  };
  if (body.length > GZIP_MIN_BYTES && acceptsGzip(req)) {
    body = await gzip(body);
    out['Content-Encoding'] = 'gzip';
  }
  out['Content-Length'] = body.length;
  res.writeHead(status, out);
  res.end(req.method === 'HEAD' ? undefined : body);
}

export function sendJson(
  req: IncomingMessage,
  res: ServerResponse,
  status: number,
  value: unknown,
  headers?: OutgoingHttpHeaders,
): Promise<void> {
  return sendJsonText(req, res, status, JSON.stringify(value), headers);
}

export function sendError(
  req: IncomingMessage,
  res: ServerResponse,
  status: number,
  code: string,
  error: string,
  extra?: Record<string, unknown>,
  headers?: OutgoingHttpHeaders,
): Promise<void> {
  return sendJson(req, res, status, { error, code, ...extra }, headers);
}

export function sendHttpError(req: IncomingMessage, res: ServerResponse, err: HttpError): Promise<void> {
  return sendError(req, res, err.status, err.code, err.message, err.extra, err.headers);
}

/** 501 for routes whose owning module has not been implemented yet. */
export function notImplemented(feature: string): HttpError {
  return new HttpError(501, 'not_implemented', `${feature} is not implemented yet`);
}
