/**
 * Route registration. Each module owns its routes file; this only wires them up plus `/healthz`.
 */
import { registerAnalyticsRoutes } from './analytics/routes.ts';
import { registerAuthRoutes } from './auth/routes.ts';
import type { AppContext } from './context.ts';
import { sendJson } from './http/respond.ts';
import { registerPricingRoutes } from './pricing/routes.ts';

export function registerRoutes(ctx: AppContext): void {
  // Liveness for Docker: no auth, no CPA round trip, no secrets.
  ctx.router.get('/healthz', ({ req, res }) => sendJson(req, res, 200, { ok: true }));
  registerAuthRoutes(ctx);
  registerPricingRoutes(ctx);
  registerAnalyticsRoutes(ctx);
}
