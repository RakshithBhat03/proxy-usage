/** Synthetic source payloads and a mock fetch shared by the pricing tests (defines no tests). */
import type { FetchLike } from './sources.ts';

export const MODELS_DEV_CATALOG = {
  models: {
    'anthropic/claude-sonnet-4-5': { id: 'anthropic/claude-sonnet-4-5' },
    'openai/gpt-5': { id: 'openai/gpt-5' },
    'google/gemini-2.5-pro': { id: 'google/gemini-2.5-pro' },
  },
  providers: {
    anthropic: {
      models: {
        'claude-sonnet-4-5': {
          id: 'claude-sonnet-4-5',
          cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
          experimental: { modes: { fast: { cost: { input: 6, output: 30 }, provider: { body: { speed: 'fast' } } } } },
        },
        'claude-sonnet-4-5-20250929': {
          id: 'claude-sonnet-4-5-20250929',
          cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
        },
      },
    },
    openai: {
      models: {
        'gpt-5': {
          id: 'gpt-5',
          cost: { input: 1.25, output: 10, cache_read: 0.125 },
          experimental: {
            modes: {
              fast: { cost: { input: 2.5, output: 20, cache_read: 0.25 }, provider: { body: { service_tier: 'priority' } } },
              flex: { cost: { input: 0.625, output: 5 }, provider: { body: { service_tier: 'flex' } } },
            },
          },
        },
        'no-cost': { id: 'no-cost' },
      },
    },
    google: {
      models: {
        'gemini-2.5-pro': {
          id: 'gemini-2.5-pro',
          cost: {
            input: 1.25,
            output: 10,
            cache_read: 0.125,
            tiers: [{ input: 2.5, output: 15, cache_read: 0.25, tier: { type: 'context', size: 200000 } }],
          },
        },
      },
    },
    // A reseller listing the same ids at different prices; must never win over the vendor.
    reseller: {
      models: {
        'gpt-5': { id: 'gpt-5', cost: { input: 99, output: 99 } },
        'claude-sonnet-4-5': { id: 'claude-sonnet-4-5', cost: { input: 99, output: 99 } },
        'mystery-model': { id: 'mystery-model', cost: { input: 7, output: 7 } },
      },
    },
  },
};

/** The older models.dev api.json root: providers at the top level, no canonical list. */
export const MODELS_DEV_API = {
  anthropic: MODELS_DEV_CATALOG.providers.anthropic,
  openai: MODELS_DEV_CATALOG.providers.openai,
  reseller: MODELS_DEV_CATALOG.providers.reseller,
};

export const LITELLM = {
  sample_spec: { input_cost_per_token: 0, output_cost_per_token: 0 },
  'gpt-5': { input_cost_per_token: 0.00000125, output_cost_per_token: 0.00001, cache_read_input_token_cost: 1.25e-7 },
  'gpt-4o-mini': { input_cost_per_token: 1.5e-7, output_cost_per_token: 6e-7, cache_read_input_token_cost: 7.5e-8 },
  'deepseek-chat': { input_cost_per_token: 2.7e-7, output_cost_per_token: 0.0000011 },
  'azure/grok-4': { input_cost_per_token: 0.000005, output_cost_per_token: 0.00002 },
  'xai/grok-4': { input_cost_per_token: 0.000003, output_cost_per_token: 0.000015 },
  'gw-a/acme-1': { input_cost_per_token: 0.000001, output_cost_per_token: 0.000002 },
  'gw-b/acme-1': { input_cost_per_token: 0.000001, output_cost_per_token: 0.000002 },
  'gw-a/acme-2': { input_cost_per_token: 0.000001, output_cost_per_token: 0.000002 },
  'gw-b/acme-2': { input_cost_per_token: 0.000009, output_cost_per_token: 0.000002 },
  'embedding-only': { output_vector_size: 1536 },
};

export const OPENROUTER = {
  data: [
    { id: 'anthropic/claude-sonnet-4.5', pricing: { prompt: '0.000003', completion: '0.000015', input_cache_read: '0.0000003', input_cache_write: '0.00000375' } },
    { id: 'qwen/qwen3-coder', pricing: { prompt: '0.0000002', completion: '0.0000008' } },
    { id: 'openrouter/auto', pricing: { prompt: '-1', completion: '-1' } },
    { id: 'no-pricing' },
  ],
};

export const TEST_URLS = {
  'models.dev': 'https://models.test/catalog.json',
  litellm: 'https://litellm.test/prices.json',
  openrouter: 'https://openrouter.test/models',
} as const;

export interface MockFetch extends FetchLike {
  calls: string[];
}

/** Serves fixtures by URL; `fail` makes a source answer 503, `hang` never answers. */
export function mockFetch(options: { fail?: string[]; hang?: string[]; bodies?: Record<string, unknown> } = {}): MockFetch {
  const bodies: Record<string, unknown> = {
    [TEST_URLS['models.dev']]: MODELS_DEV_CATALOG,
    [TEST_URLS.litellm]: LITELLM,
    [TEST_URLS.openrouter]: OPENROUTER,
    ...options.bodies,
  };
  const calls: string[] = [];
  const fn = (async (url: string, init?: RequestInit) => {
    calls.push(url);
    if (options.hang?.includes(url)) {
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason ?? new Error('aborted')));
      });
    }
    if (options.fail?.includes(url)) return new Response('unavailable', { status: 503, statusText: 'Service Unavailable' });
    if (!(url in bodies)) return new Response('not found', { status: 404 });
    return new Response(JSON.stringify(bodies[url]), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as MockFetch;
  fn.calls = calls;
  return fn;
}
