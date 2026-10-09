import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';

import { estimateEventCost } from '../../shared/cost.ts';
import { loadConfig } from '../config.ts';
import { openDatabase } from '../db/open.ts';
import { HttpError } from '../http/respond.ts';
import { createLogger } from '../log.ts';
import { mockFetch, TEST_URLS } from './fixtures.test.ts';
import { startPricing, type PricingOptions } from './index.ts';
import { getMeta, getMetaInt, loadBook, META_LAST_SYNC, META_REVISION, setMeta, transaction, writeBook } from './store.ts';

const config = loadConfig({ PRICE_SYNC_INTERVAL_HOURS: '0' }, []);
const log = createLogger('error');

let seq = 0;
function insertEvent(db: DatabaseSync, model: string, input = 1_000_000, output = 1_000_000, extra: { resolved?: string; tier?: string } = {}) {
  seq++;
  db.prepare(
    `INSERT INTO events (event_hash, timestamp_ms, timestamp, received_at_ms, created_at_ms, model, analytics_model,
       resolved_model, service_tier, input_tokens, output_tokens, total_tokens)
     VALUES (?, ?, '2026-01-01T00:00:00Z', 0, 0, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(`h${seq}`, seq, model, model, extra.resolved ?? null, extra.tier ?? null, input, output, input + output);
}

function costs(db: DatabaseSync): Array<{ model: string; cost_usd: number | null; cost_revision: number }> {
  return (db.prepare('SELECT analytics_model AS model, cost_usd, cost_revision FROM events ORDER BY id').all() as Array<{
    model: string;
    cost_usd: number | null;
    cost_revision: number;
  }>).map((r) => ({ ...r }));
}

async function start(db: DatabaseSync, options: PricingOptions = {}) {
  return startPricing({ config, log, db }, { fetch: mockFetch(), urls: TEST_URLS, autoSync: false, batch: 3, ...options });
}

/** Lets the startup recompute check (setImmediate) and recompute batches run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 50; i++) await new Promise((resolve) => setImmediate(resolve));
}

describe('pricing service', () => {
  it('syncs requested + runtime models, imports unambiguous matches and reports the rest', async () => {
    const db = openDatabase(':memory:');
    insertEvent(db, 'claude-sonnet-4-5');
    insertEvent(db, 'gpt-4o-mini', 1000, 1000, { resolved: 'gpt-4o-mini-2024-07-18' });
    const pricing = await start(db);
    const result = await pricing.sync({ models: ['gpt-5', 'claude-sonet-4-5x', 'zzzz-unknown-9'], includeRuntimeModels: true });

    assert.equal(result.source, 'multi');
    assert.deepEqual(result.sources, ['models.dev', 'litellm', 'openrouter']);
    assert.equal(result.runtimeModelCount, 3);
    assert.deepEqual(Object.keys(result.matched ?? {}).sort(), ['claude-sonnet-4-5', 'gpt-4o-mini', 'gpt-4o-mini-2024-07-18', 'gpt-5']);
    assert.equal(result.imported, 4);
    assert.deepEqual(result.candidates?.map((c) => c.model), ['claude-sonet-4-5x']);
    assert.deepEqual(result.unmatched, ['zzzz-unknown-9']);
    assert.equal(result.prices['gpt-5'].prompt, 1.25);
    assert.equal(result.prices['gpt-5'].source, 'models.dev');
    assert.equal(result.prices['claude-sonnet-4-5'].sourceModelId, 'anthropic/claude-sonnet-4-5');
    assert.deepEqual(result.sourceResults?.map((s) => [s.source, s.models > 0, s.error]), [
      ['models.dev', true, undefined],
      ['litellm', true, undefined],
      ['openrouter', true, undefined],
    ]);
    // Persisted and reloaded identically.
    assert.deepEqual(loadBook(db), pricing.book());
    assert.ok(getMetaInt(db, META_LAST_SYNC));
    assert.equal(pricing.stats().models, 4);
    assert.equal(pricing.stats().last_sync_ms, pricing.stats().last_sync_at_ms);
    await pricing.stop();
  });

  it('never overwrites manual entries and keeps them through PUT round trips', async () => {
    const db = openDatabase(':memory:');
    const pricing = await start(db);
    pricing.replace({ 'gpt-5': { prompt: 9, completion: 9, cache: 0, promptConfigured: true, completionConfigured: true, source: 'manual' } });
    const result = await pricing.sync({ models: ['gpt-5', 'gpt-4o-mini'] });
    assert.equal(result.imported, 1);
    assert.equal(result.matched?.['gpt-5'], undefined);
    assert.equal(result.prices['gpt-5'].prompt, 9);
    assert.equal(result.prices['gpt-5'].source, 'manual');
    assert.equal(result.prices['gpt-4o-mini'].source, 'litellm');
    assert.equal(pricing.stats().manual_models, 1);
    assert.equal(pricing.stats().synced_models, 1);
    await pricing.stop();
  });

  it('preserves prices from a failed preferred source instead of downgrading them', async () => {
    const db = openDatabase(':memory:');
    const pricing = await start(db);
    await pricing.sync({ models: ['gpt-5'] });
    assert.equal(pricing.book()['gpt-5'].source, 'models.dev');
    const failing = await start(db, { fetch: mockFetch({ fail: [TEST_URLS['models.dev']] }) });
    const result = await failing.sync({ models: ['gpt-5'] });
    assert.deepEqual(result.preserved, ['gpt-5']);
    assert.equal(result.prices['gpt-5'].source, 'models.dev');
    assert.match(result.sourceResults?.[0].error ?? '', /503/);
    await pricing.stop();
    await failing.stop();
  });

  it('fails with 502 and keeps the book when every source fails', async () => {
    const db = openDatabase(':memory:');
    const pricing = await start(db, { fetch: mockFetch({ fail: Object.values(TEST_URLS) }) });
    pricing.replace({ a: { prompt: 1, completion: 1, cache: 0 } });
    await assert.rejects(pricing.sync({ models: ['gpt-5'] }), (err: unknown) => err instanceof HttpError && err.status === 502);
    assert.deepEqual(Object.keys(pricing.book()), ['a']);
    assert.match(pricing.stats().last_sync_error ?? '', /existing prices were not changed/);
    await pricing.stop();
  });

  it('validates PUT bodies', async () => {
    const db = openDatabase(':memory:');
    const pricing = await start(db);
    assert.throws(() => pricing.replace([]), (err: unknown) => err instanceof HttpError && err.status === 400);
    assert.throws(() => pricing.replace({ m: { prompt: -1, completion: 0, cache: 0 } }), /non-negative/);
    assert.throws(
      () => pricing.replace({ m: { prompt: 1, completion: 1, cache: 0, contextTiers: [{ thresholdTokens: 0, prompt: 1, promptConfigured: true }] } }),
      /threshold/,
    );
    const book = pricing.replace({
      ' m ': {
        prompt: 1,
        completion: 2,
        cache: 0,
        serviceTiers: [{ mode: 'Fast', serviceTier: 'Priority', prompt: 2, promptConfigured: true }],
        extra: 'dropped',
      },
    });
    assert.deepEqual(Object.keys(book), ['m']);
    assert.equal(book.m.serviceTiers?.[0].mode, 'fast');
    assert.equal((book.m as unknown as Record<string, unknown>).extra, undefined);
    await pricing.stop();
  });

  it('recomputes cost_usd on a book change and leaves NULL when unpriced', async () => {
    const db = openDatabase(':memory:');
    for (let i = 0; i < 4; i++) insertEvent(db, 'm-a');
    insertEvent(db, 'm-b', 1_000_000, 0, { tier: 'priority' });
    insertEvent(db, 'unknown-model');
    const pricing = await start(db);
    assert.equal(pricing.revision(), 0);
    await settle();

    pricing.replace({
      'm-a': { prompt: 2, completion: 4, cache: 0 },
      'm-b': { prompt: 1, completion: 1, cache: 0, serviceTiers: [{ mode: 'fast', serviceTier: 'priority', prompt: 3, promptConfigured: true }] },
    });
    assert.equal(pricing.revision(), 1);
    await settle();
    const rows = costs(db);
    assert.deepEqual(rows.map((r) => r.cost_usd), [6, 6, 6, 6, 3, null]);
    assert.ok(rows.every((r) => r.cost_revision === 1));
    assert.equal(getMeta(db, META_REVISION), '1');
    assert.equal(pricing.stats().stale_cost_events, 0);
    assert.equal(pricing.stats().unpriced_events, 1);

    // The UDF and the shared implementation agree.
    const book = pricing.book();
    assert.equal(
      estimateEventCost(book, {
        model: 'm-a', analytics_model: 'm-a', resolved_model: undefined, requested_model: undefined, input_tokens: 1_000_000,
        output_tokens: 1_000_000, cached_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0, service_tier: undefined,
      }),
      6,
    );

    // Saving the same book again does not bump the revision.
    pricing.replace(pricing.book());
    assert.equal(pricing.revision(), 1);
    await pricing.stop();
  });

  it('resumes an interrupted recompute and bumps the revision for external book edits', async () => {
    const db = openDatabase(':memory:');
    for (let i = 0; i < 7; i++) insertEvent(db, 'm-a');
    const first = await start(db);
    first.replace({ 'm-a': { prompt: 1, completion: 0, cache: 0 } });
    await first.stop(); // stops before (or during) the recompute
    // Simulate an import script editing model_prices directly.
    transaction(db, () => writeBook(db, { 'm-a': { prompt: 2, completion: 0, cache: 0 } }));
    setMeta(db, META_REVISION, '1');

    const second = await start(db);
    assert.equal(second.revision(), 2);
    await settle();
    assert.deepEqual(costs(db).map((r) => [r.cost_usd, r.cost_revision]), Array.from({ length: 7 }, () => [2, 2]));
    await second.stop();
  });

  it('noteModels schedules an auto-sync only for models the book cannot price', async () => {
    const db = openDatabase(':memory:');
    const fetchImpl = mockFetch();
    const autoConfig = loadConfig({ PRICE_SYNC_INTERVAL_HOURS: '24' }, []);
    // Recently synced, so no startup sync is due.
    setMeta(db, META_LAST_SYNC, String(Date.now()));
    const pricing = await startPricing({ config: autoConfig, log, db }, { fetch: fetchImpl, urls: TEST_URLS });
    pricing.replace({ 'gpt-5': { prompt: 1, completion: 1, cache: 0 } });
    pricing.noteModels(['gpt-5', 'openai/gpt-5']);
    await settle();
    assert.equal(fetchImpl.calls.length, 0);
    await pricing.stop();
  });

  it('auto-syncs at startup when never synced, and after an unknown model is noted', async () => {
    const db = openDatabase(':memory:');
    insertEvent(db, 'gpt-5');
    const fetchImpl = mockFetch();
    const autoConfig = loadConfig({ PRICE_SYNC_INTERVAL_HOURS: '24' }, []);
    const pricing = await startPricing(
      { config: autoConfig, log, db },
      { fetch: fetchImpl, urls: TEST_URLS, startupDelayMs: 0, newModelDelayMs: 0 },
    );
    const waitFor = async (check: () => boolean) => {
      for (let i = 0; i < 200 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
      assert.ok(check());
    };
    await waitFor(() => !!pricing.book()['gpt-5']);
    assert.equal(fetchImpl.calls.length, 3);
    assert.ok(pricing.stats().last_sync_ms);
    // Within the hour after a sync, a new model only schedules (no immediate fetch).
    pricing.noteModels(['gpt-4o-mini']);
    await settle();
    assert.equal(fetchImpl.calls.length, 3);
    await pricing.stop();
  });
});
