/** Request body readers with size limits. Errors surface as `HttpError`s (413 / 400). */
import type { IncomingMessage } from 'node:http';
import { HttpError } from './respond.ts';

/** Default limit for JSON bodies (analytics queries, price books). */
export const DEFAULT_JSON_LIMIT = 1024 * 1024;

export async function readBody(req: IncomingMessage, limitBytes: number): Promise<Buffer> {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > limitBytes) {
    req.resume();
    throw new HttpError(413, 'payload_too_large', `request body exceeds ${limitBytes} bytes`);
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > limitBytes) {
      req.resume();
      throw new HttpError(413, 'payload_too_large', `request body exceeds ${limitBytes} bytes`);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, size);
}

/**
 * Reads and parses a JSON body. An empty body yields `undefined`; callers validate the shape.
 * Rejects non-JSON content types other than a missing header.
 */
export async function readJson<T = unknown>(
  req: IncomingMessage,
  options: { limitBytes?: number } = {},
): Promise<T | undefined> {
  const type = req.headers['content-type'];
  if (type && !/^application\/([\w.+-]+\+)?json\b/i.test(type)) {
    req.resume();
    throw new HttpError(415, 'unsupported_media_type', 'expected an application/json body');
  }
  const body = await readBody(req, options.limitBytes ?? DEFAULT_JSON_LIMIT);
  if (body.length === 0) return undefined;
  try {
    return JSON.parse(body.toString('utf8')) as T;
  } catch {
    throw new HttpError(400, 'invalid_json', 'request body is not valid JSON');
  }
}
