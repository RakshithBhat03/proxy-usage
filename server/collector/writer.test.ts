import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { PriceBook } from '../../shared/pricing-types.ts';
import { openDatabase } from '../db/open.ts';
import { createLogger } from '../log.ts';
import type { PricingHandle } from '../pricing/types.ts';
import { applySnapshot, parseAuthFiles } from './authSnapshots.ts';
import { normalizeRecord } from './normalize.ts';
import { EventWriter } from './writer.ts';

const log = createLogger('error');
const NOW = Date.UTC(2026, 2, 4, 12, 0, 0);
const FAKE_KEY = 'sk-test-writer-000000000000000000000000';

function record(i: number, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    timestamp: `2026-03-04T10:00:0${i}Z`,
    request_id: `req-${i}`,
    model: 'claude-test-4',
    provider: 'claude',
    executor_type: 'ClaudeExecutor',
    endpoint: 'POST /v1/messages',
    auth_index: 'aaaa000000000001',
    source: 'user@example.com',
    api_key: FAKE_KEY,
    latency_ms: 100 + i,
    tokens: { input_tokens: 1_000_000, output_tokens: 1_000_000, cache_read_tokens: 0, cache_creation_tokens: 0 },
    ...extra,
  });
}

/** Only book/revision/noteModels matter to the writer; the rest of PricingHandle is the pricing module's. */
function fakePricing(book: PriceBook, revision = 7): PricingHandle & { noted: string[][] } {
  const noted: string[][] = [];
  const fake = {
    noted,
    book: () => book,
    revision: () => revision,
    noteModels: (models: Iterable<string>) => void noted.push([...models]),
  };
  return fake as unknown as PricingHandle & { noted: string[][] };
}

describe('EventWriter', () => {
  it('inserts, dedupes on event_hash and prices events', () => {
    const db = openDatabase(':memory:');
    const pricing = fakePricing({ 'claude-test-4': { prompt: 3, completion: 15, cache: 0 } });
    const flushed: number[] = [];
    const writer = new EventWriter({ db, log, pricing: () => pricing, onFlushed: (r) => flushed.push(r.inserted) });
    writer.enqueue([0, 1, 2].map((i) => normalizeRecord(record(i), NOW)));
    let result = writer.flush();
    assert.deepEqual(result, { inserted: 3, duplicates: 0 });
    // Same records again (e.g. the post-subscribe queue drain): all duplicates.
    writer.enqueue([0, 1, 2, 3].map((i) => normalizeRecord(record(i), NOW + 5)));
    result = writer.flush();
    assert.deepEqual(result, { inserted: 1, duplicates: 3 });
    assert.deepEqual(writer.totals, { inserted: 4, duplicates: 3 });

    const rows = db.prepare('SELECT model, cost_usd, cost_revision, search_text, api_key_hash FROM events ORDER BY id').all() as Array<
      Record<string, unknown>
    >;
    assert.equal(rows.length, 4);
    assert.equal(rows[0].cost_usd, 18); // 1M input × $3 + 1M output × $15
    assert.equal(rows[0].cost_revision, 7);
    assert.match(String(rows[0].search_text), /claude-test-4/);
    assert.deepEqual(pricing.noted, [['claude-test-4']]);

    // The raw client key is nowhere in the database.
    const dump = JSON.stringify(db.prepare('SELECT * FROM events').all());
    assert.ok(!dump.includes(FAKE_KEY));
    db.close();
  });

  it('stores NULL cost for unpriced models and without pricing', () => {
    const db = openDatabase(':memory:');
    const writer = new EventWriter({ db, log, pricing: () => fakePricing({}) });
    writer.enqueue([normalizeRecord(record(1), NOW)]);
    writer.flush();
    const noPricing = new EventWriter({ db, log, pricing: () => undefined });
    noPricing.enqueue([normalizeRecord(record(2), NOW)]);
    noPricing.stop();
    const rows = db.prepare('SELECT cost_usd, cost_revision FROM events ORDER BY id').all() as Array<Record<string, unknown>>;
    assert.deepEqual(
      rows.map((r) => [r.cost_usd, r.cost_revision]),
      [
        [null, 7],
        [null, 0],
      ],
    );
    db.close();
  });

  it('flushes on the timer and at the row threshold', async () => {
    const db = openDatabase(':memory:');
    const writer = new EventWriter({ db, log, pricing: () => undefined, flushRows: 3, flushIntervalMs: 20 });
    writer.enqueue([normalizeRecord(record(1), NOW)]);
    assert.equal(writer.pending, 1);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(writer.pending, 0);
    writer.enqueue([2, 3, 4].map((i) => normalizeRecord(record(i), NOW)));
    assert.equal(writer.pending, 0);
    assert.equal((db.prepare('SELECT count(*) AS n FROM events').get() as { n: number }).n, 4);
    writer.stop();
    db.close();
  });
});

describe('auth snapshots', () => {
  const files = [
    { auth_index: 'idx-claude', name: 'claude-user.json', provider: 'claude', email: 'user@example.com', label: 'user@example.com' },
    {
      auth_index: 'idx-codex',
      name: 'codex-user.json',
      provider: 'codex',
      email: 'Member@Example.com',
      id_token: { chatgpt_account_id: 'ws-1', plan_type: 'plus' },
      access_token: 'must-not-be-kept',
    },
    { auth_index: 'dup', name: 'a.json', provider: 'gemini', project_id: 'p1' },
    { auth_index: 'dup', name: 'b.json', provider: 'gemini' },
  ];

  it('parses files and marks duplicate auth indexes ambiguous', () => {
    const { snapshots, ambiguous } = parseAuthFiles(files, NOW);
    assert.deepEqual([...ambiguous], ['dup']);
    const claude = snapshots.get('idx-claude');
    assert.equal(claude?.fileName, 'claude-user.json');
    assert.equal(claude?.account, 'user@example.com');
    const codex = snapshots.get('idx-codex');
    assert.equal(codex?.account, 'member@example.com');
    assert.equal(codex?.accountId, 'ws-1');
    assert.ok(!JSON.stringify(codex).includes('must-not-be-kept'));
  });

  it('fills only empty fields and refuses conflicting Codex identities', () => {
    const { snapshots } = parseAuthFiles(files, NOW);
    const row = normalizeRecord(record(1, { auth_index: 'idx-claude' }), NOW);
    assert.equal(applySnapshot(row, snapshots.get('idx-claude')!), true);
    assert.equal(row.auth_file_snapshot, 'claude-user.json');
    assert.equal(row.account_snapshot, 'user@example.com');
    assert.equal(row.auth_provider_snapshot, 'claude');
    assert.equal(row.auth_snapshot_at_ms, NOW);

    const codexRow = normalizeRecord(record(2, { provider: 'codex', auth_index: 'idx-codex', auth_account_id_snapshot: 'ws-other' }), NOW);
    assert.equal(applySnapshot(codexRow, snapshots.get('idx-codex')!), false);
    assert.equal(codexRow.auth_file_snapshot, '');
  });
});
