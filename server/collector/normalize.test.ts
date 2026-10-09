/**
 * Synthetic fixtures only (example.com / RFC 5737 addresses, fake keys).
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import {
  SEARCH_COLUMNS,
  buildEventHash,
  buildSearchText,
  classifyControlPayload,
  normalizeRecord,
  readTimestamp,
} from './normalize.ts';
import { maskSource, redactPayloadForStorage, storedFailSummary } from './redact.ts';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const NOW = Date.UTC(2026, 2, 4, 12, 0, 0);

const FAKE_CLIENT_KEY = 'sk-test-client-0000000000000000000000000000';

/** A CPA v8 usage record (Claude, cache read + creation, streaming). */
function claudeRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    timestamp: '2026-03-04T10:20:30.123456789+05:30',
    latency_ms: 1234,
    ttft_ms: 321,
    source: 'user@example.com',
    auth_index: 'a1b2c3d4e5f60718',
    access_token_sha256: 'ab'.repeat(32),
    client_ip: '192.0.2.10',
    resolved_client_ip: '192.0.2.10',
    x_forwarded_for: '',
    user_agent: 'test-cli/1.0\t(synthetic)\n',
    tokens: {
      input_tokens: 100,
      output_tokens: 50,
      reasoning_tokens: 0,
      cached_tokens: 0,
      cache_read_tokens: 2000,
      cache_read_tokens_present: true,
      cache_creation_tokens: 300,
      total_tokens: 2450,
    },
    failed: false,
    generate: true,
    stream: true,
    fail: { status_code: 200, body: '' },
    accounting_version: 2,
    token_breakdown: { input: 100 },
    provider: 'claude',
    executor_type: 'ClaudeExecutor',
    model: 'claude-test-4',
    alias: 'claude-test-4',
    endpoint: 'POST /v1/messages',
    auth_type: 'oauth',
    api_key: FAKE_CLIENT_KEY,
    request_id: 'req-0001',
    session_id: 'sess-abc',
    is_fork: false,
    reasoning_effort: 'high',
    service_tier: 'standard',
    response_headers: { 'Content-Type': ['text/event-stream'], 'X-Request-Id': ['req_upstream_1'], 'Set-Cookie': ['sid=1'] },
    ...overrides,
  };
}

describe('normalizeRecord', () => {
  it('maps a CPA v8 Claude record', () => {
    const row = normalizeRecord(JSON.stringify(claudeRecord()), NOW);
    assert.equal(row.timestamp, '2026-03-04T04:50:30.123456789Z');
    assert.equal(row.timestamp_ms, Date.UTC(2026, 2, 4, 4, 50, 30, 123));
    assert.equal(row.model, 'claude-test-4');
    assert.equal(row.requested_model, 'claude-test-4');
    assert.equal(row.resolved_model, 'claude-test-4');
    assert.equal(row.analytics_model, 'claude-test-4');
    assert.equal(row.method, 'POST');
    assert.equal(row.path, '/v1/messages');
    assert.equal(row.source, 'use***@example.com');
    assert.equal(row.source_hash, sha('user@example.com'));
    assert.equal(row.cache_input_mode, 'separate_from_input');
    // Claude reports cache buckets separately: normalized input = 100 + 2000 + 300.
    assert.equal(row.input_tokens, 2400);
    assert.equal(row.normalized_uncached_input_tokens, 100);
    assert.equal(row.cache_read_tokens, 2000);
    assert.equal(row.cache_creation_tokens, 300);
    assert.equal(row.cached_tokens, 0);
    assert.equal(row.total_tokens, 2450);
    assert.equal(row.service_tier, 'standard');
    assert.equal(row.latency_ms, 1234);
    assert.equal(row.ttft_ms, 321);
    assert.equal(row.failed, 0);
    assert.equal(row.fail_status_code, 200);
    assert.equal(row.fail_summary, '');
    assert.equal(row.generate, 1);
    assert.equal(row.stream, 1);
    assert.equal(row.is_fork, 0);
    assert.equal(row.is_compaction, null);
    assert.equal(row.user_agent, 'test-cli/1.0 (synthetic)');
    assert.equal(row.session_id, 'sess-abc');
    assert.equal(row.header_trace_id, 'req_upstream_1');
    assert.deepEqual(JSON.parse(row.response_metadata_json ?? '{}'), {
      trace: { primary_trace_id: 'req_upstream_1', request_id: 'req_upstream_1' },
      response: { content_type: 'text/event-stream' },
    });
    assert.equal(JSON.parse(row.raw_tokens_json ?? '{}').cache_read_tokens, 2000);
  });

  it('computes event_hash exactly like CPA Manager Plus buildEventHash', () => {
    const row = normalizeRecord(JSON.stringify(claudeRecord()), NOW);
    // request_id|timestamp(UTC RFC3339Nano)|endpoint|model|auth_index|sha256(source)|input|output|
    // reasoning|max(cached,cache)|failed|latency — raw (not normalized) token counts.
    const expected = sha(
      ['req-0001', '2026-03-04T04:50:30.123456789Z', 'POST /v1/messages', 'claude-test-4', 'a1b2c3d4e5f60718', sha('user@example.com'), '100', '50', '0', '0', 'false', '1234'].join(
        '|',
      ),
    );
    assert.equal(row.event_hash, expected);

    // No latency → no trailing part; Z timestamps without fraction keep no fraction.
    const bare = normalizeRecord(
      JSON.stringify({ timestamp: '2026-01-02T03:04:05Z', model: 'm', tokens: { input_tokens: 1, cached_tokens: 2, cache_tokens: 7 }, failed: true }),
      NOW,
    );
    assert.equal(bare.event_hash, sha(['', '2026-01-02T03:04:05Z', '-', 'm', '', '', '1', '0', '0', '7', 'true'].join('|')));
  });

  it('hashes and drops the client API key', () => {
    const row = normalizeRecord(JSON.stringify(claudeRecord()), NOW);
    assert.equal(row.api_key_hash, sha(FAKE_CLIENT_KEY));
    assert.ok(!JSON.stringify(row).includes(FAKE_CLIENT_KEY));
    assert.ok(!JSON.stringify(row).includes('sk-test-client'));
  });

  it('masks credential-looking sources', () => {
    const secret = `sk-ant-api03-${'A'.repeat(40)}`;
    const row = normalizeRecord(JSON.stringify(claudeRecord({ source: secret })), NOW);
    assert.equal(row.source, `h:${sha(secret)}`);
    assert.ok(!JSON.stringify(row).includes(secret));
    assert.equal(maskSource('abcdefghijklmnopqrstuvwxyz0123456789'), 'm:abcd...6789');
    assert.equal(maskSource('my-label'), 'my-label');
  });

  it('applies Go "first present key" semantics', () => {
    const row = normalizeRecord(JSON.stringify({ source: null, api_key: 'k-1', model: 'x' }), NOW);
    assert.equal(row.source, '');
    assert.equal(row.source_hash, '');
    assert.equal(row.api_key_hash, sha('k-1'));
    const alias = normalizeRecord(JSON.stringify({ alias: '', requested_model: 'ignored', model: 'resolved-1' }), NOW);
    assert.equal(alias.requested_model, '');
    assert.equal(alias.model, 'resolved-1');
  });

  it('keeps Codex request tier and OpenAI-style cached input', () => {
    const row = normalizeRecord(
      JSON.stringify({
        timestamp: '2026-03-04T00:00:00Z',
        provider: 'codex',
        executor_type: 'CodexExecutor',
        model: 'gpt-test-5(high)',
        request_service_tier: 'priority',
        response_service_tier: 'default',
        tokens: { input_tokens: 1000, output_tokens: 10, cached_tokens: 800 },
      }),
      NOW,
    );
    assert.equal(row.service_tier, 'priority');
    assert.equal(row.cache_input_mode, 'included_in_input');
    assert.equal(row.input_tokens, 1000);
    assert.equal(row.cached_tokens, 800);
    assert.equal(row.analytics_model, 'gpt-test-5');
    assert.equal(row.total_tokens, 1010);
  });

  it('reduces failure bodies to a redacted summary', () => {
    const body = JSON.stringify({
      error: { message: `bad key sk-ant-${'x'.repeat(30)} for someone@example.com`, details: 'y'.repeat(2000) },
      authorization: 'Bearer abcdefghijklmnop',
    });
    const row = normalizeRecord(JSON.stringify(claudeRecord({ failed: true, fail: { status_code: 401, body } })), NOW);
    assert.equal(row.failed, 1);
    assert.equal(row.fail_status_code, 401);
    assert.ok(row.fail_summary.length <= 500);
    assert.ok(!row.fail_summary.includes('sk-ant-'));
    assert.ok(!row.fail_summary.includes('abcdefghijklmnop'));
    assert.ok(row.fail_summary.includes('s***@example.com'));
    assert.ok(row.fail_summary.includes('[redacted]'));
    assert.equal(storedFailSummary('  '), '');
  });

  it('defaults endpoint and model to "-" and rejects non-objects', () => {
    const row = normalizeRecord('{}', NOW);
    assert.equal(row.endpoint, '-');
    assert.equal(row.model, '-');
    assert.equal(row.timestamp_ms, NOW);
    assert.throws(() => normalizeRecord('[1,2]', NOW), /not a JSON object/);
    assert.throws(() => normalizeRecord('{oops', NOW), /invalid JSON/);
  });

  it('builds endpoint from method + path', () => {
    const row = normalizeRecord(JSON.stringify({ method: 'post', path: '/v1/chat/completions', model: 'm' }), NOW);
    assert.equal(row.endpoint, 'POST /v1/chat/completions');
  });
});

describe('readTimestamp', () => {
  it('handles RFC 3339, zone-less, epoch seconds and epoch ms', () => {
    assert.deepEqual(readTimestamp({ timestamp: '2026-01-02T03:04:05.120+00:00' }, NOW), {
      ms: Date.UTC(2026, 0, 2, 3, 4, 5, 120),
      text: '2026-01-02T03:04:05.12Z',
    });
    assert.equal(readTimestamp({ timestamp: '2026-01-02 03:04:05' }, NOW).text, '2026-01-02T03:04:05Z');
    assert.equal(readTimestamp({ timestamp: '2026-01-01T23:30:00-01:00' }, NOW).text, '2026-01-02T00:30:00Z');
    assert.equal(readTimestamp({ timestamp: 1767225600 }, NOW).text, '2026-01-01T00:00:00Z');
    assert.equal(readTimestamp({ time: '1767225600250' }, NOW).text, '2026-01-01T00:00:00.25Z');
    assert.equal(readTimestamp({ timestamp: 'not a time' }, NOW).ms, NOW);
  });
});

describe('search text and control payloads', () => {
  it('joins the search columns lower-cased with U+001F', () => {
    const row = normalizeRecord(JSON.stringify(claudeRecord()), NOW);
    const text = buildSearchText(row);
    assert.equal(text.split('\u001f').length, SEARCH_COLUMNS.length);
    assert.ok(text.includes('claude-test-4'));
    assert.ok(text.includes('use***@example.com'));
    assert.equal(text, text.toLowerCase());
  });

  it('recognizes refresh frames', () => {
    assert.equal(classifyControlPayload('{"refresh":true}'), 'refresh');
    assert.equal(classifyControlPayload(' {"support_refresh":true} '), 'support_refresh');
    assert.equal(classifyControlPayload('{"refresh":true,"model":"x"}'), null);
    assert.equal(classifyControlPayload('{"model":"x"}'), null);
  });

  it('buildEventHash omits latency only when absent', () => {
    const base = {
      requestId: 'r',
      timestamp: 't',
      endpoint: 'e',
      model: 'm',
      authIndex: 'a',
      sourceHash: 's',
      inputTokens: 1,
      outputTokens: 2,
      reasoningTokens: 3,
      cachedTokens: 4,
      cacheTokens: 5,
      failed: false,
    };
    assert.equal(buildEventHash({ ...base, latencyMs: null }), sha('r|t|e|m|a|s|1|2|3|5|false'));
    assert.equal(buildEventHash({ ...base, latencyMs: 0 }), sha('r|t|e|m|a|s|1|2|3|5|false|0'));
  });
});

describe('dead-letter redaction', () => {
  it('removes keys and secrets from payloads', () => {
    const raw = JSON.stringify({ api_key: FAKE_CLIENT_KEY, key: 'k', nested: { refresh_token: 'rt' }, fail: { body: 'Authorization: Bearer abcdefghijk' } });
    const out = redactPayloadForStorage(raw);
    assert.ok(!out.includes(FAKE_CLIENT_KEY));
    assert.ok(!out.includes('"rt"'));
    assert.ok(!out.includes('abcdefghijk'));
    const malformed = redactPayloadForStorage(`{"key":"${FAKE_CLIENT_KEY}", oops`);
    assert.ok(!malformed.includes(FAKE_CLIENT_KEY));
  });
});
