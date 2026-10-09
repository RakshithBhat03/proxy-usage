import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { deriveResponseHeaderColumns, isResponseHeaderAllowed, parseResponseHeaderMetadata } from './headers.ts';

const BASE = Date.UTC(2025, 11, 31, 23, 50, 0);

describe('response header metadata', () => {
  it('parses Codex quota windows, retry-after and traceparent', () => {
    const metadata = parseResponseHeaderMetadata(
      {
        'X-Codex-Plan-Type': ['plus'],
        'x-codex-primary-used-percent': '42.5',
        'x-codex-primary-window-minutes': '300',
        'x-codex-primary-reset-after-seconds': '600',
        'x-codex-secondary-used-percent': ['80'],
        'x-codex-secondary-window-minutes': '10080',
        'x-codex-secondary-reset-at': '1767225600',
        'retry-after': '30',
        traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
        Authorization: 'Bearer should-not-appear',
        'x-api-token': 'nope',
        'set-cookie': 'sid=nope',
      },
      BASE,
    );
    assert.ok(metadata);
    assert.deepEqual(metadata.quota, {
      plan_type: 'plus',
      summary_window_kind: 'weekly',
      summary_window_source: 'secondary',
      primary: { used_percent: 42.5, reset_at_ms: BASE + 600_000, reset_after_seconds: 600, window_minutes: 300 },
      secondary: { used_percent: 80, reset_at_ms: Date.UTC(2026, 0, 1), window_minutes: 10080 },
      recover_at_ms: Date.UTC(2026, 0, 1),
      used_percent: 80,
    });
    assert.deepEqual(metadata.errors, {
      kind: 'rate_limit',
      code: 'retry_after',
      retry_after_seconds: 30,
      retry_after_recover_at_ms: BASE + 30_000,
    });
    assert.equal(metadata.trace?.primary_trace_id, '0af7651916cd43dd8448eb211c80319c');

    const derived = deriveResponseHeaderColumns(metadata);
    assert.equal(derived.quotaPlanType, 'plus');
    assert.equal(derived.quotaUsedPercent, 80);
    assert.equal(derived.quotaRecoverAtMs, Date.UTC(2026, 0, 1));
    assert.equal(derived.errorKind, 'rate_limit');
    assert.equal(derived.traceId, '0af7651916cd43dd8448eb211c80319c');
    assert.ok(derived.metadataJson && !/nope|should-not-appear/.test(derived.metadataJson));
    // Key order follows the Go structs (stable JSON for CPAMP parity).
    assert.ok(derived.metadataJson.indexOf('"quota"') < derived.metadataJson.indexOf('"errors"'));
  });

  it('marks a reached window and classifies auth errors', () => {
    const metadata = parseResponseHeaderMetadata(
      {
        'x-codex-primary-used-percent': '100',
        'x-codex-primary-window-minutes': '300',
        'x-codex-primary-reset-at': '2026-01-01T01:00:00Z',
        'x-codex-rate-limit-reached-type': 'primary',
        'x-openai-ide-error-code': 'token_revoked',
        'x-ratelimit-limit-tokens': '1000',
        'x-ratelimit-remaining-tokens': '-1',
        'x-zero-data-retention': 'true',
      },
      BASE,
    );
    assert.equal(metadata?.quota?.reached_window_kind, 'five_hour');
    assert.equal(metadata?.quota?.reached_window_source, 'primary');
    assert.equal(metadata?.errors?.kind, 'auth');
    assert.equal(metadata?.errors?.code, 'token_revoked');
    assert.deepEqual(metadata?.rate_limit, { tokens: { limit: 1000 } });
    assert.deepEqual(metadata?.data_policy, { zero_retention: true });
  });

  it('allowlists headers and returns nothing for empty input', () => {
    assert.equal(isResponseHeaderAllowed('x-openai-authorization-error'), true);
    assert.equal(isResponseHeaderAllowed('x-ratelimit-remaining-tokens'), true);
    assert.equal(isResponseHeaderAllowed('x-session-token'), false);
    assert.equal(isResponseHeaderAllowed('authorization'), false);
    assert.equal(parseResponseHeaderMetadata({ 'x-unknown': '1' }, BASE), undefined);
    assert.equal(parseResponseHeaderMetadata(null, BASE), undefined);
    assert.equal(deriveResponseHeaderColumns(undefined).metadataJson, null);
  });

  it('redacts secrets inside allowed header values', () => {
    const metadata = parseResponseHeaderMetadata({ server: `proxy sk-ant-${'z'.repeat(30)}` }, BASE);
    assert.equal(metadata?.routing?.server, 'proxy [redacted]');
  });
});
