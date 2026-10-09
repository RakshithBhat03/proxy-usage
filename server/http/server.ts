/**
 * HTTP entry point. Per request: host allowlist → security headers → router → API 404 → UI (Vite
 * middleware in dev, dist/ in production).
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AppContext } from '../context.ts';
import { createDevMiddleware, type DevMiddleware } from './dev.ts';
import { applySecurityHeaders } from './headers.ts';
import { createHostCheck } from './hostCheck.ts';
import { HttpError, sendError, sendHttpError } from './respond.ts';
import { createStaticHandler } from './static.ts';

/** Paths that belong to the API: unmatched requests here get a JSON 404, never the SPA. */
function isApiPath(pathname: string): boolean {
  return pathname === '/healthz' || pathname.startsWith('/api/') || pathname === '/api' || pathname.startsWith('/v0/');
}

export interface HttpHandle {
  server: Server;
  /** Stops accepting connections and waits for in-flight requests (bounded by `timeoutMs`). */
  close(timeoutMs?: number): Promise<void>;
}

export async function startHttp(ctx: AppContext): Promise<HttpHandle> {
  const { config } = ctx;
  const log = ctx.log.child('http');
  const hostAllowed = createHostCheck(config.allowedHosts);
  const server = createServer();
  server.keepAliveTimeout = 65_000;

  let dev: DevMiddleware | null = null;
  const serveStatic = config.dev ? null : createStaticHandler(config.distDir);
  if (config.dev) dev = await createDevMiddleware(config, server);

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    applySecurityHeaders(res);
    if (!hostAllowed(req.headers.host)) {
      await sendError(req, res, 403, 'host_not_allowed', 'host not allowed; add it to ALLOWED_HOSTS');
      return;
    }

    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://localhost');
    } catch {
      await sendError(req, res, 400, 'bad_request', 'malformed request URL');
      return;
    }
    const method = req.method ?? 'GET';

    const match = ctx.router.match(method, url.pathname);
    if (match.kind === 'found') {
      await match.handler({ req, res, url, params: match.params });
      if (!res.headersSent && !res.writableEnded) {
        log.error('handler returned without responding', { method, path: url.pathname });
        await sendError(req, res, 500, 'internal_error', 'internal error');
      }
      return;
    }
    if (match.kind === 'method_not_allowed') {
      await sendError(req, res, 405, 'method_not_allowed', `method ${method} not allowed`, undefined, {
        Allow: match.allow.join(', '),
      });
      return;
    }
    if (isApiPath(url.pathname)) {
      await sendError(req, res, 404, 'not_found', 'not found');
      return;
    }

    if (dev) {
      dev.handle(req, res, (err) => {
        if (err) log.error('vite middleware error', { error: err });
        if (!res.headersSent) void sendError(req, res, err ? 500 : 404, err ? 'internal_error' : 'not_found', err ? 'internal error' : 'not found');
      });
      return;
    }
    if (serveStatic && (await serveStatic(req, res, url))) return;
    await sendError(req, res, 404, 'not_found', 'not found');
  };

  server.on('request', (req: IncomingMessage, res: ServerResponse) => {
    handle(req, res).catch(async (err: unknown) => {
      if (err instanceof HttpError) {
        if (!res.headersSent) await sendHttpError(req, res, err).catch(() => res.destroy());
        else res.end();
        return;
      }
      log.error('unhandled request error', { method: req.method, path: req.url?.split('?')[0], error: err });
      if (!res.headersSent) await sendError(req, res, 500, 'internal_error', 'internal error').catch(() => res.destroy());
      else res.destroy();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  log.info(`listening on http://${config.host}:${config.port}`, { mode: config.dev ? 'dev (vite middleware)' : 'production (dist)' });

  return {
    server,
    async close(timeoutMs = 10_000) {
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeIdleConnections();
      const timer = setTimeout(() => server.closeAllConnections(), timeoutMs);
      timer.unref();
      if (dev) await dev.close().catch((err: unknown) => log.warn('vite close failed', { error: err }));
      await closed;
      clearTimeout(timer);
    },
  };
}
