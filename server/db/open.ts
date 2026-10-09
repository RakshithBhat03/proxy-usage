/**
 * SQLite connections (node:sqlite). One writer connection lives on the main thread; analytics
 * workers use `openReadOnly`. WAL lets readers run alongside the writer.
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from './migrations.ts';

export const BUSY_TIMEOUT_MS = 5000;

/**
 * Opens (creating if needed) the writer database and brings the schema up to date.
 * Pass `':memory:'` for tests.
 */
export function openDatabase(file: string): DatabaseSync {
  if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  // auto_vacuum only takes effect before the first table is created (or after a VACUUM), so set
  // it first. On an existing database it is a harmless no-op.
  db.exec('PRAGMA auto_vacuum = INCREMENTAL');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA temp_store = MEMORY');
  migrate(db);
  return db;
}

/** Read-only connection for worker threads; never migrates or writes. */
export function openReadOnly(file: string): DatabaseSync {
  const db = new DatabaseSync(file, { readOnly: true });
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  db.exec('PRAGMA query_only = ON');
  db.exec('PRAGMA temp_store = MEMORY');
  return db;
}

/** Final maintenance before exit: checkpoint and truncate the WAL, then close. */
export function closeDatabase(db: DatabaseSync): void {
  if (!db.isOpen) return;
  try {
    db.exec('PRAGMA optimize');
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } finally {
    db.close();
  }
}
