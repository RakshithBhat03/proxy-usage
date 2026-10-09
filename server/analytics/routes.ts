/**
 * Analytics routes (all authenticated):
 *   POST /api/analytics               AnalyticsRequest → AnalyticsResponse (shared/analytics-types.ts)
 *   POST /api/account-window-usage    per-credential usage inside quota windows (accountWindow.ts)
 *
 * Bodies are validated on the main thread (400 on bad input); queries run on the worker pool and
 * come back as JSON text, sent as-is (gzipped when accepted).
 */
import type { ServerResponse } from 'node:http';
import type { AppContext } from '../context.ts';
import { readJson } from '../http/body.ts';
import { HttpError, sendJsonText } from '../http/respond.ts';
import { withAuth } from '../http/withAuth.ts';
import { parseAccountWindowRequest } from './accountWindow.ts';
import { validateAnalyticsRequest, ValidationError } from './validate.ts';

function validated<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof ValidationError) throw new HttpError(400, err.code, err.message);
    throw err;
  }
}

/** Aborts when the client goes away before the response is written. */
function abortOnClose(res: ServerResponse): AbortSignal {
  const controller = new AbortController();
  res.once('close', () => {
    if (!res.writableFinished) controller.abort();
  });
  return controller.signal;
}

export function registerAnalyticsRoutes(ctx: AppContext): void {
  const pool = () => {
    if (!ctx.analytics) throw new HttpError(503, 'analytics_unavailable', 'analytics is not ready');
    return ctx.analytics;
  };

  ctx.router.post(
    '/api/analytics',
    withAuth(ctx, async ({ req, res }) => {
      const body = await readJson(req);
      const request = validated(() => validateAnalyticsRequest(body));
      const json = await pool().run<string>('analytics', request, abortOnClose(res));
      await sendJsonText(req, res, 200, json);
    }),
  );

  ctx.router.post(
    '/api/account-window-usage',
    withAuth(ctx, async ({ req, res }) => {
      const body = await readJson(req);
      const targets = validated(() => parseAccountWindowRequest(body));
      const json = await pool().run<string>('account-window', targets, abortOnClose(res));
      await sendJsonText(req, res, 200, json);
    }),
  );
}
