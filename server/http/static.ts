/**
 * Production static file server for the built SPA in `dist/`.
 *  - Path traversal guard (resolved path must stay inside dist/), no dotfiles.
 *  - `/assets/*` (content-hashed by Vite) is cached immutably; index.html is `no-cache`.
 *  - GET/HEAD requests that accept HTML and match no file get index.html (client-side routing).
 *  - Text responses over 1 KB are gzipped on the fly when accepted.
 */
import { createReadStream, type Stats } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { acceptsGzip, GZIP_MIN_BYTES } from './respond.ts';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

const COMPRESSIBLE = new Set(['.html', '.js', '.mjs', '.css', '.json', '.map', '.svg', '.txt', '.webmanifest']);

/** Serves a request from dist/. Resolves `true` when it wrote a response. */
export type StaticHandler = (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<boolean>;

function acceptsHtml(req: IncomingMessage): boolean {
  return (req.headers.accept ?? '').includes('text/html');
}

async function fileStat(file: string): Promise<Stats | null> {
  try {
    const info = await stat(file);
    return info.isFile() ? info : null;
  } catch {
    return null;
  }
}

/** Resolves a URL pathname inside `root`, or null when it escapes root or is otherwise unsafe. */
export function resolveInside(root: string, pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return null;
  if (decoded.split('/').some((segment) => segment.startsWith('.') && segment.length > 0)) return null;
  const resolved = path.resolve(root, `.${path.posix.normalize(`/${decoded}`)}`);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;
  return resolved;
}

export function createStaticHandler(distDir: string): StaticHandler {
  const root = path.resolve(distDir);
  const indexFile = path.join(root, 'index.html');

  const send = async (req: IncomingMessage, res: ServerResponse, file: string, info: Stats, cacheControl: string) => {
    const ext = path.extname(file).toLowerCase();
    const etag = `W/"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`;
    const headers: OutgoingHttpHeaders = {
      'Content-Type': TYPES[ext] ?? 'application/octet-stream',
      'Cache-Control': cacheControl,
      'Last-Modified': info.mtime.toUTCString(),
      ETag: etag,
    };
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers);
      res.end();
      return;
    }
    const compress = COMPRESSIBLE.has(ext) && info.size > GZIP_MIN_BYTES && acceptsGzip(req);
    if (COMPRESSIBLE.has(ext)) headers.Vary = 'Accept-Encoding';
    if (compress) headers['Content-Encoding'] = 'gzip';
    else headers['Content-Length'] = info.size;
    res.writeHead(200, headers);
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    const stream = createReadStream(file);
    try {
      if (compress) await pipeline(stream, createGzip(), res);
      else await pipeline(stream, res);
    } catch {
      // Client went away mid-transfer; nothing else to do.
      res.destroy();
    }
  };

  return async (req, res, url) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    const file = resolveInside(root, url.pathname);
    if (file && file !== root) {
      const info = await fileStat(file);
      if (info) {
        const immutable = url.pathname.startsWith('/assets/');
        const isIndex = file === indexFile;
        await send(req, res, file, info, immutable ? 'public, max-age=31536000, immutable' : isIndex ? 'no-cache' : 'public, max-age=3600');
        return true;
      }
    }
    // Missing hashed assets must 404, never fall back to HTML (it would break with a MIME error).
    if (!acceptsHtml(req) || url.pathname.startsWith('/assets/')) return false;
    const index = await fileStat(indexFile);
    if (!index) return false;
    await send(req, res, indexFile, index, 'no-cache');
    return true;
  };
}
