import type { AuthOk } from '../auth/types.ts';
import type { AppContext } from '../context.ts';
import { sendError } from './respond.ts';
import type { RequestContext, RouteHandler } from './router.ts';

export type AuthedHandler = (rc: RequestContext, auth: AuthOk) => unknown;

/**
 * Wraps a route handler so it only runs for an authenticated request. Failures answer with
 * `{ error, code, retry_after_s? }` (+ `Retry-After`) using the status from `ctx.requireAuth`.
 * `ctx.requireAuth` is read per request, so it can be swapped after routes are registered.
 */
export function withAuth(ctx: Pick<AppContext, 'requireAuth'>, handler: AuthedHandler): RouteHandler {
  return async (rc) => {
    const result = await ctx.requireAuth(rc.req);
    if (!result.ok) {
      const retry = result.retryAfterS;
      await sendError(
        rc.req,
        rc.res,
        result.status,
        result.code,
        result.error,
        retry !== undefined ? { retry_after_s: retry } : undefined,
        retry !== undefined ? { 'Retry-After': String(Math.ceil(retry)) } : undefined,
      );
      return;
    }
    return handler(rc, result);
  };
}
