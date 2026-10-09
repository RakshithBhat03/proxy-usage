/**
 * Analytics worker thread: owns one read-only SQLite connection and answers pool messages
 *   { id, op: 'analytics' | 'account-window', input }  →  { id, ok, json } | { id, ok: false, error }
 * Results are JSON text so the main thread can send them without re-serializing.
 */
import type { DatabaseSync } from 'node:sqlite';
import { parentPort, workerData } from 'node:worker_threads';
import { openReadOnly } from '../db/open.ts';
import { runAccountWindowTargets, type WindowTarget } from './accountWindow.ts';
import { runAnalytics } from './engine.ts';
import { registerAnalyticsFunctions } from './sql.ts';
import { ValidationError, type NormalizedRequest } from './validate.ts';

export interface WorkerRequest {
  id: number;
  op: string;
  input: unknown;
}

export type WorkerReply =
  | { id: number; ok: true; json: string; ms: number }
  | { id: number; ok: false; error: { status: number; code: string; message: string } };

const { dbPath } = workerData as { dbPath: string };
let db: DatabaseSync | null = null;

function connection(): DatabaseSync {
  if (!db || !db.isOpen) {
    db = openReadOnly(dbPath);
    registerAnalyticsFunctions(db);
  }
  return db;
}

function handle(message: WorkerRequest): WorkerReply {
  const started = performance.now();
  try {
    let json: string;
    switch (message.op) {
      case 'analytics':
        json = runAnalytics(connection(), message.input as NormalizedRequest);
        break;
      case 'account-window':
        json = JSON.stringify(runAccountWindowTargets(connection(), message.input as WindowTarget[]));
        break;
      case 'ping':
        json = '{"ok":true}';
        break;
      default:
        return { id: message.id, ok: false, error: { status: 400, code: 'unknown_op', message: `unknown op ${message.op}` } };
    }
    return { id: message.id, ok: true, json, ms: performance.now() - started };
  } catch (err) {
    if (err instanceof ValidationError) {
      return { id: message.id, ok: false, error: { status: 400, code: err.code, message: err.message } };
    }
    const error = err as Error;
    // A broken connection (e.g. the file was replaced) is reopened on the next request.
    if (/SQLITE_(CORRUPT|NOTADB|IOERR|CANTOPEN)|disk I\/O/i.test(error.message ?? '')) {
      try {
        db?.close();
      } catch {
        // ignore
      }
      db = null;
    }
    return { id: message.id, ok: false, error: { status: 500, code: 'analytics_failed', message: error.message ?? String(err) } };
  }
}

parentPort?.on('message', (message: WorkerRequest) => {
  parentPort?.postMessage(handle(message));
});
