import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { LITELLM, MODELS_DEV_API, MODELS_DEV_CATALOG, mockFetch, OPENROUTER, TEST_URLS } from './fixtures.test.ts';
import { decodeLiteLLM, decodeModelsDev, decodeOpenRouter, fetchSources, SourceCache } from './sources.ts';

describe('decodeModelsDev', () => {
  it('decodes the catalog root with canonical metadata, context tiers and service tiers', () => {
    const { prices, skipped, metadata } = decodeModelsDev(MODELS_DEV_CATALOG, 1000);
    assert.equal(skipped, 1); // openai/no-cost
    assert.ok(prices['anthropic/claude-sonnet-4-5']);
    const sonnet = prices['anthropic/claude-sonnet-4-5'];
    assert.equal(sonnet.prompt, 3);
    assert.equal(sonnet.completion, 15);
    assert.equal(sonnet.cacheRead, 0.3);
    assert.equal(sonnet.cache, 0.3);
    assert.equal(sonnet.cacheCreation, 3.75);
    assert.equal(sonnet.source, 'models.dev');
    assert.equal(sonnet.sourceModelId, 'anthropic/claude-sonnet-4-5');
    assert.equal(sonnet.syncedAtMs, 1000);
    assert.deepEqual(sonnet.serviceTiers?.map((t) => [t.mode, t.serviceTier, t.prompt, t.completion]), [['fast', 'priority', 6, 30]]);

    const gpt5 = prices['openai/gpt-5'];
    assert.equal(gpt5.cacheCreationConfigured, undefined);
    assert.deepEqual(
      gpt5.serviceTiers?.map((t) => [t.mode, t.serviceTier, t.prompt]),
      [
        ['fast', 'priority', 2.5],
        ['flex', 'flex', 0.625],
      ],
    );
    assert.deepEqual(prices['google/gemini-2.5-pro'].contextTiers?.map((t) => [t.thresholdTokens, t.prompt, t.completion]), [[200000, 2.5, 15]]);

    assert.equal(metadata?.canonicalByIdentity.get('gpt-5'), 'openai/gpt-5');
    assert.ok(metadata?.official.has('openai/gpt-5'));
    assert.ok(!metadata?.official.has('reseller/gpt-5'));
  });

  it('decodes the api.json root (providers at top level, no canonical list)', () => {
    const { prices, metadata } = decodeModelsDev(MODELS_DEV_API);
    assert.equal(prices['openai/gpt-5'].prompt, 1.25);
    assert.equal(prices['reseller/mystery-model'].prompt, 7);
    assert.equal(metadata?.canonicalByIdentity.size, 0);
  });

  it('rejects a catalog without canonical models or usable prices', () => {
    assert.throws(() => decodeModelsDev({ providers: {}, models: {} }), /no canonical models/);
    assert.throws(() => decodeModelsDev({ x: { models: { a: { id: 'a' } } } }), /no usable prices/);
  });
});

describe('decodeLiteLLM', () => {
  it('scales per-token prices to per-1M and skips entries without prices', () => {
    const { prices, skipped } = decodeLiteLLM(LITELLM);
    assert.equal(skipped, 2); // sample_spec, embedding-only
    assert.deepEqual(
      [prices['gpt-5'].prompt, prices['gpt-5'].completion, prices['gpt-5'].cacheRead],
      [1.25, 10, 0.125],
    );
    assert.equal(prices['gpt-4o-mini'].prompt, 0.15);
    assert.equal(prices['deepseek-chat'].completion, 1.1);
    assert.equal(prices['deepseek-chat'].cacheReadConfigured, undefined);
    assert.equal(prices['gpt-5'].source, 'litellm');
  });
});

describe('decodeOpenRouter', () => {
  it('reads string prices, treats negative (variable) prices as missing', () => {
    const { prices, skipped } = decodeOpenRouter(OPENROUTER);
    assert.equal(skipped, 2); // openrouter/auto, no-pricing
    const sonnet = prices['anthropic/claude-sonnet-4.5'];
    assert.deepEqual([sonnet.prompt, sonnet.completion, sonnet.cacheRead, sonnet.cacheCreation], [3, 15, 0.3, 3.75]);
    assert.equal(sonnet.source, 'openrouter');
  });
});

describe('fetchSources', () => {
  it('fetches in parallel and reports a failing source without failing the others', async () => {
    const fetchImpl = mockFetch({ fail: [TEST_URLS.litellm] });
    const outcomes = await fetchSources({ fetchImpl, urls: TEST_URLS });
    assert.deepEqual(outcomes.map((o) => o.source), ['models.dev', 'litellm', 'openrouter']);
    assert.ok(outcomes[0].decoded);
    assert.match(outcomes[1].error ?? '', /503/);
    assert.ok(outcomes[2].decoded);
  });

  it('times out a hanging source', async () => {
    const fetchImpl = mockFetch({ hang: [TEST_URLS.openrouter] });
    const outcomes = await fetchSources({ fetchImpl, urls: TEST_URLS, timeoutMs: 50 });
    assert.match(outcomes[2].error ?? '', /timed out/);
    assert.ok(outcomes[0].decoded && outcomes[1].decoded);
  });

  it('reuses a cached decode on 304 Not Modified', async () => {
    const cache = new SourceCache();
    let calls = 0;
    const fetchImpl = async (_url: string, init?: RequestInit) => {
      calls++;
      const headers = new Headers(init?.headers);
      if (headers.get('if-none-match') === '"v1"') return new Response(null, { status: 304 });
      return new Response(JSON.stringify(LITELLM), { status: 200, headers: { etag: '"v1"' } });
    };
    const urls = { 'models.dev': '', openrouter: '', litellm: TEST_URLS.litellm };
    const first = await fetchSources({ fetchImpl, urls, cache });
    const second = await fetchSources({ fetchImpl, urls, cache });
    assert.equal(calls, 2);
    assert.equal(second[1].decoded, first[1].decoded);
    assert.match(second[0].error ?? '', /missing source URL/);
  });
});
