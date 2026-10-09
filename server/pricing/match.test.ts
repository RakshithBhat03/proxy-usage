import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { LITELLM, MODELS_DEV_API, MODELS_DEV_CATALOG, OPENROUTER } from './fixtures.test.ts';
import {
  collectionFrom,
  identityVariants,
  modelSimilarity,
  PriceMatcher,
  preserveFailedSourcePrices,
  selectPrices,
  vendorNamespaces,
} from './match.ts';
import { decodeLiteLLM, decodeModelsDev, decodeOpenRouter } from './sources.ts';

function collection(modelsDevRoot: unknown = MODELS_DEV_CATALOG) {
  const md = decodeModelsDev(modelsDevRoot);
  return collectionFrom([
    { source: 'models.dev', prices: md.prices, metadata: md.metadata },
    { source: 'litellm', prices: decodeLiteLLM(LITELLM).prices },
    { source: 'openrouter', prices: decodeOpenRouter(OPENROUTER).prices },
  ]);
}

describe('PriceMatcher.findAutomatic', () => {
  const matcher = new PriceMatcher(collection());
  const pick = (model: string) => {
    const m = matcher.findAutomatic(model);
    return m ? [m.price.source, m.price.sourceModelId, m.reason] : null;
  };

  it('prefers the models.dev official entry over resellers and lower-priority sources', () => {
    assert.deepEqual(pick('gpt-5'), ['models.dev', 'openai/gpt-5', 'models.dev-official']);
    assert.deepEqual(pick('claude-sonnet-4-5'), ['models.dev', 'anthropic/claude-sonnet-4-5', 'models.dev-official']);
    assert.deepEqual(pick('GPT-5'), ['models.dev', 'openai/gpt-5', 'models.dev-official']);
  });

  it('uses the family vendor namespace for non-canonical models.dev entries', () => {
    assert.deepEqual(pick('claude-sonnet-4-5-20250929'), ['models.dev', 'anthropic/claude-sonnet-4-5-20250929', 'models.dev-vendor']);
  });

  it('falls back to LiteLLM, then OpenRouter', () => {
    assert.deepEqual(pick('gpt-4o-mini'), ['litellm', 'gpt-4o-mini', 'exact']);
    assert.deepEqual(pick('qwen3-coder'), ['openrouter', 'qwen/qwen3-coder', 'provider-prefix']);
  });

  it('never auto-matches a non-official models.dev reseller entry by bare id', () => {
    assert.equal(pick('mystery-model'), null);
    assert.deepEqual(pick('reseller/mystery-model'), ['models.dev', 'reseller/mystery-model', 'exact']);
  });

  it('breaks an ambiguous provider-prefix match with the vendor namespace', () => {
    assert.deepEqual(pick('grok-4'), ['litellm', 'xai/grok-4', 'provider-prefix-vendor']);
  });

  it('accepts ambiguous matches only when they all carry the same price', () => {
    assert.deepEqual(pick('acme-1'), ['litellm', 'gw-a/acme-1', 'provider-prefix-consensus']);
    assert.equal(pick('acme-2'), null);
  });

  it('tries identity fallbacks only when the raw id has no match', () => {
    assert.deepEqual(pick('gpt-5(high)'), ['models.dev', 'openai/gpt-5', 'models.dev-official-normalized']);
    assert.deepEqual(pick('gpt-4o-mini-2024-07-18'), ['litellm', 'gpt-4o-mini', 'exact-normalized']);
    assert.deepEqual(identityVariants('claude-x-latest(8192)'), ['claude-x-latest(8192)', 'claude-x-latest', 'claude-x']);
  });

  it('decodes api.json (no canonical list) and still prefers the vendor', () => {
    const m = new PriceMatcher(collection(MODELS_DEV_API));
    assert.equal(m.findAutomatic('gpt-5')?.price.sourceModelId, 'openai/gpt-5');
    assert.equal(m.findAutomatic('gpt-5')?.price.prompt, 1.25);
  });
});

describe('selectPrices', () => {
  it('splits requested models into matched, candidates and unmatched', () => {
    const selection = selectPrices(collection(), ['gpt-5', 'claude-sonet-4-5x', 'zzzz-unknown-9', 'gpt-5'], true);
    assert.deepEqual(Object.keys(selection.prices), ['gpt-5']);
    assert.equal(selection.prices['gpt-5'].prompt, 1.25);
    assert.deepEqual(selection.candidates.map((c) => c.model), ['claude-sonet-4-5x']);
    const first = selection.candidates[0].candidates[0];
    assert.ok(first.score >= 0.55 && first.score < 1);
    assert.equal(first.price.source, 'models.dev');
    assert.deepEqual(selection.unmatched, ['zzzz-unknown-9']);
  });

  it('skips candidates when not requested (auto-sync)', () => {
    const selection = selectPrices(collection(), ['claude-sonet-4-5x'], false);
    assert.deepEqual(selection.candidates, []);
    assert.deepEqual(selection.unmatched, ['claude-sonet-4-5x']);
  });
});

describe('preserveFailedSourcePrices', () => {
  it('keeps an existing models.dev price when models.dev failed and only LiteLLM matched', () => {
    const c = collectionFrom([{ source: 'litellm', prices: decodeLiteLLM(LITELLM).prices }]);
    const selection = selectPrices(c, ['gpt-5', 'gpt-4o-mini'], false);
    const existing = {
      'gpt-5': { prompt: 1.25, completion: 10, cache: 0, source: 'models.dev' },
      'gpt-4o-mini': { prompt: 1, completion: 1, cache: 0, source: 'litellm' },
    };
    const preserved = preserveFailedSourcePrices(selection, existing, new Set(['models.dev']), ['gpt-5', 'gpt-4o-mini']);
    assert.deepEqual(preserved, ['gpt-5']);
    assert.deepEqual(Object.keys(selection.prices), ['gpt-4o-mini']);
  });
});

describe('similarity helpers', () => {
  it('scores provider-prefixed and token-shared ids', () => {
    assert.deepEqual(modelSimilarity('claude-sonnet-4-5', 'anthropic/claude-sonnet-4.5'), [0.94, 'same-model-with-provider-prefix']);
    assert.equal(modelSimilarity('qwen3-max', 'qwen-plus')[1], 'same-model-family');
    assert.deepEqual(vendorNamespaces('o3-mini'), ['openai']);
    assert.deepEqual(vendorNamespaces('models/gemini-2.5-flash'), ['google', 'gemini']);
  });
});
