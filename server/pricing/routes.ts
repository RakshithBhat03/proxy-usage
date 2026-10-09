/**
 * Price book routes (all authenticated):
 *   GET  /api/model-prices        → { prices: PriceBook }
 *   PUT  /api/model-prices        { prices } → { prices }   (replaces the whole book)
 *   POST /api/model-prices/sync   { models?, includeRuntimeModels? } → SyncResult
 */
import type { AppContext } from '../context.ts';
import { readJson } from '../http/body.ts';
import { HttpError, sendJson } from '../http/respond.ts';
import { withAuth } from '../http/withAuth.ts';
import type { PricingHandle } from './types.ts';

/** Price books carry raw source JSON per entry, so allow more than the default body limit. */
export const PRICE_BOOK_LIMIT_BYTES = 8 * 1024 * 1024;

function pricing(ctx: AppContext): PricingHandle {
  if (!ctx.pricing) throw new HttpError(503, 'pricing_unavailable', 'model prices are not available yet');
  return ctx.pricing;
}

const isObj = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export function registerPricingRoutes(ctx: AppContext): void {
  ctx.router.get(
    '/api/model-prices',
    withAuth(ctx, ({ req, res }) => sendJson(req, res, 200, { prices: pricing(ctx).book() })),
  );

  ctx.router.put(
    '/api/model-prices',
    withAuth(ctx, async ({ req, res }) => {
      const body = await readJson(req, { limitBytes: PRICE_BOOK_LIMIT_BYTES });
      if (!isObj(body) || !('prices' in body)) {
        throw new HttpError(400, 'invalid_model_prices', 'body must be { "prices": { [model]: price } }');
      }
      const prices = pricing(ctx).replace(body.prices);
      await sendJson(req, res, 200, { prices });
    }),
  );

  ctx.router.post(
    '/api/model-prices/sync',
    withAuth(ctx, async ({ req, res }) => {
      const body = (await readJson(req)) ?? {};
      if (!isObj(body)) throw new HttpError(400, 'invalid_request', 'body must be a JSON object');
      const { models, includeRuntimeModels } = body;
      if (models !== undefined && models !== null && (!Array.isArray(models) || models.some((m) => typeof m !== 'string'))) {
        throw new HttpError(400, 'invalid_request', 'models must be an array of strings');
      }
      if (includeRuntimeModels !== undefined && typeof includeRuntimeModels !== 'boolean') {
        throw new HttpError(400, 'invalid_request', 'includeRuntimeModels must be a boolean');
      }
      const result = await pricing(ctx).sync({
        models: (models as string[] | null | undefined) ?? [],
        includeRuntimeModels: includeRuntimeModels === true,
      });
      await sendJson(req, res, 200, result);
    }),
  );
}
