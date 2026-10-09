/**
 * `--dev`: serve the UI through Vite in middleware mode on the same port as the API, with HMR over
 * this server's WebSocket upgrade. Vite is a devDependency and is only imported here, so the
 * production image does not need it.
 */
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { Config } from '../config.ts';
import { viteAllowedHosts } from './hostCheck.ts';

export interface DevMiddleware {
  handle(req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void): void;
  close(): Promise<void>;
}

export async function createDevMiddleware(config: Config, httpServer: Server): Promise<DevMiddleware> {
  const { createServer } = await import('vite');
  const vite = await createServer({
    root: config.rootDir,
    appType: 'spa',
    server: {
      middlewareMode: true,
      // The server's own host check runs first; Vite re-checks the same list for its HMR socket.
      allowedHosts: viteAllowedHosts(config.allowedHosts),
      hmr: { server: httpServer, clientPort: config.hmrClientPort },
      watch: { ignored: ['**/data/**', '**/server/**', '**/*.sqlite*'] },
    },
  });
  return {
    handle: (req, res, next) => vite.middlewares(req, res, next),
    close: () => vite.close(),
  };
}
