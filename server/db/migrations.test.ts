import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import { migrate, SCHEMA_VERSION, schemaVersion, type Migration } from './migrations.ts';
import { openDatabase } from './open.ts';

function columns(db: DatabaseSync, table: string): string[] {
  // table_xinfo includes generated (hidden) columns.
  return (db.prepare(`PRAGMA table_xinfo(${table})`).all() as Array<{ name: string }>).map((row) => row.name);
}

describe('migrations', () => {
  it('creates the full schema on an empty database and is idempotent', () => {
    const db = openDatabase(':memory:');
    assert.equal(schemaVersion(db), SCHEMA_VERSION);
    assert.equal(migrate(db), SCHEMA_VERSION);

    const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`).all() as Array<{ name: string }>).map((r) => r.name);
    for (const table of ['auth_snapshots', 'dead_letters', 'events', 'meta', 'model_prices']) {
      assert.ok(tables.includes(table), `missing table ${table}`);
    }
    const eventColumns = columns(db, 'events');
    for (const column of ['event_hash', 'timestamp_ms', 'analytics_model', 'search_text', 'cost_usd', 'cost_revision', 'credential_id', 'provider_key', 'tier_key', 'trace_id', 'is_compaction']) {
      assert.ok(eventColumns.includes(column), `missing events.${column}`);
    }
    assert.ok(!eventColumns.includes('raw_json') && !eventColumns.includes('fail_body'));
    db.close();
  });

  it('derives credential_id, provider_key and tier_key', () => {
    const db = openDatabase(':memory:');
    const insert = db.prepare(`INSERT INTO events (event_hash, timestamp_ms, timestamp, received_at_ms, created_at_ms, model,
      provider, auth_provider_snapshot, auth_file_snapshot, auth_index, source_hash, service_tier)
      VALUES (?, 0, '1970-01-01T00:00:00Z', 0, 0, 'm', ?, ?, ?, ?, ?, ?)`);
    insert.run('a', 'Codex', '', 'codex-a.json', 'idx1', 'h1', 'priority');
    insert.run('b', '', 'Claude', '', 'idx2', 'h2', null);
    insert.run('c', null, null, null, null, null, 'Flex');
    const rows = db.prepare('SELECT event_hash, credential_id, provider_key, tier_key FROM events ORDER BY event_hash').all();
    assert.deepEqual(
      rows.map((r) => ({ ...r })),
      [
        { event_hash: 'a', credential_id: 'codex-a.json', provider_key: 'codex', tier_key: 'fast' },
        { event_hash: 'b', credential_id: 'idx2', provider_key: 'claude', tier_key: 'normal' },
        { event_hash: 'c', credential_id: '-', provider_key: '', tier_key: 'flex' },
      ],
    );
    assert.throws(() => insert.run('a', '', '', '', '', '', ''), /UNIQUE/);
    db.close();
  });

  it('rolls back a failing migration and leaves user_version untouched', () => {
    const db = new DatabaseSync(':memory:');
    const broken: Migration[] = [
      { version: 1, name: 'ok', up: (d) => d.exec('CREATE TABLE a (x)') },
      { version: 2, name: 'broken', up: (d) => { d.exec('CREATE TABLE b (x)'); d.exec('NOT SQL'); } },
    ];
    assert.throws(() => migrate(db, broken), /migration 2 \(broken\) failed/);
    assert.equal(schemaVersion(db), 1);
    const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{ name: string }>).map((r) => r.name);
    assert.deepEqual(tables, ['a']);
    db.close();
  });

  it('refuses a database newer than the build', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    assert.throws(() => migrate(db), /newer than this build/);
    db.close();
  });
});
