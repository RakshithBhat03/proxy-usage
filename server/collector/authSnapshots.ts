/**
 * Auth-file snapshots: labels for credentials (file name, provider, account, label, project) looked
 * up by `auth_index` from CPA's `GET /v0/management/auth-files`. Port of CPA Manager Plus
 * `collector/auth_snapshot.go` + `enrichAccountSnapshots` (MIT), simplified.
 *
 *  - 30 s cache, 5 s timeout; on a failed fetch the stale cache is used. `{"refresh":true}` clears it.
 *  - Duplicate auth indexes are ambiguous and never used.
 *  - Every successful fetch upserts `auth_snapshots` and backfills events stored without an
 *    `auth_file_snapshot` for those auth indexes (rebuilding their `search_text`).
 *
 * Only non-secret fields are kept (no tokens, no id_token payload beyond the account id).
 */
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type { CpaClient } from '../cpa/client.ts';
import type { Logger } from '../log.ts';
import type { EventRowInsert } from './normalize.ts';
import { SEARCH_COLUMNS, buildSearchText } from './normalize.ts';

export const AUTH_SNAPSHOT_TTL_MS = 30_000;
const FETCH_TIMEOUT_MS = 5_000;
const BACKFILL_BATCH = 2_000;

export interface AuthSnapshot {
  authIndex: string;
  fileName: string;
  provider: string;
  label: string;
  /** Account (email for OAuth credentials). For Codex only a strong (email-shaped) member. */
  account: string;
  /** Codex workspace / ChatGPT account id. */
  accountId: string;
  projectId: string;
  status: string;
  disabled: boolean;
  metadata: Record<string, unknown>;
  /** Codex identity evidence disagreed inside the auth file; never enrich from it. */
  invalid: boolean;
  capturedAtMs: number;
}

type Rec = Record<string, unknown>;

function str(file: Rec, ...keys: string[]): string {
  for (const key of keys) {
    const value = file[key];
    if (value === null || value === undefined) continue;
    const text = (typeof value === 'string' ? value : typeof value === 'object' ? '' : String(value)).trim();
    if (text) return text;
  }
  return '';
}

function normalizeProvider(value: string): string {
  const provider = value.trim().toLowerCase().replaceAll('_', '-');
  return provider === 'x-ai' || provider === 'grok' ? 'xai' : provider;
}

/** CPAMP `NormalizeCodexMemberSnapshot`: one '@', printable ASCII, lower-cased. */
export function normalizeCodexMember(value: string): string | null {
  const trimmed = value.replace(/^ +| +$/g, '');
  if (!trimmed || trimmed.split('@').length !== 2) return null;
  if (!/^[\x21-\x7e]+$/.test(trimmed)) return null;
  const [local, domain] = trimmed.split('@');
  if (!local || !domain) return null;
  return trimmed.toLowerCase();
}

function looksLikeSecret(value: string): boolean {
  if (!value || value.includes('@') || /[ /\\]/.test(value)) return false;
  return value.startsWith('sk-') || value.startsWith('AIza') || (value.length >= 32 && value.length <= 512);
}

function codexAccountId(file: Rec): { value: string; invalid: boolean } {
  const values = new Set<string>();
  const visit = (record: unknown) => {
    if (!record || typeof record !== 'object' || Array.isArray(record)) return;
    for (const key of ['account_id', 'accountId', 'chatgpt_account_id', 'chatgptAccountId']) {
      const raw = (record as Rec)[key];
      if (typeof raw === 'string' && raw.trim()) values.add(raw.trim());
    }
  };
  visit(file);
  for (const key of ['id_token', 'idToken', 'metadata', 'attributes']) visit(file[key]);
  if (values.size > 1) return { value: '', invalid: true };
  return { value: [...values][0] ?? '', invalid: false };
}

function codexAccount(file: Rec): { value: string; invalid: boolean } {
  const members = new Set<string>();
  for (const key of ['account_snapshot', 'accountSnapshot', 'account', 'email']) {
    const raw = file[key];
    if (typeof raw !== 'string') continue;
    const member = normalizeCodexMember(raw);
    if (member) members.add(member);
  }
  if (members.size > 1) return { value: '', invalid: true };
  return { value: [...members][0] ?? '', invalid: false };
}

/** Parses CPA auth-file objects into snapshots; duplicate auth indexes go to `ambiguous`. */
export function parseAuthFiles(files: Rec[], capturedAtMs: number): { snapshots: Map<string, AuthSnapshot>; ambiguous: Set<string> } {
  const snapshots = new Map<string, AuthSnapshot>();
  const ambiguous = new Set<string>();
  for (const file of files) {
    const authIndex = str(file, 'auth_index', 'authIndex', 'auth-index');
    if (!authIndex || ambiguous.has(authIndex)) continue;
    if (snapshots.has(authIndex)) {
      snapshots.delete(authIndex);
      ambiguous.add(authIndex);
      continue;
    }
    const provider = normalizeProvider(str(file, 'provider', 'type'));
    const fileName = str(file, 'name', 'file_name', 'fileName', 'id');
    const projectId = str(file, 'project_id', 'projectId', 'gemini_virtual_project', 'geminiVirtualProject');
    let account = '';
    let accountId = '';
    let invalid = false;
    if (provider === 'codex') {
      const member = codexAccount(file);
      const id = codexAccountId(file);
      account = member.value;
      accountId = id.value;
      invalid = member.invalid || id.invalid;
    } else {
      account = [str(file, 'account'), str(file, 'email')].find((v) => v && !looksLikeSecret(v)) ?? '';
    }
    const label = str(file, 'label', 'name', 'email') || account;
    if (!account && provider !== 'codex') account = label || fileName;
    const disabledRaw = file.disabled;
    snapshots.set(authIndex, {
      authIndex,
      fileName,
      provider,
      label,
      account,
      accountId,
      projectId,
      status: str(file, 'status'),
      disabled: disabledRaw === true || disabledRaw === 'true',
      metadata: Object.fromEntries(
        Object.entries({
          type: str(file, 'type'),
          account_type: str(file, 'account_type'),
          runtime_only: typeof file.runtime_only === 'boolean' ? file.runtime_only : undefined,
          unavailable: typeof file.unavailable === 'boolean' ? file.unavailable : undefined,
        }).filter(([, v]) => v !== undefined && v !== ''),
      ),
      invalid,
      capturedAtMs,
    });
  }
  return { snapshots, ambiguous };
}

type SnapshotFields = Pick<
  EventRowInsert,
  | 'provider'
  | 'account_snapshot'
  | 'auth_label_snapshot'
  | 'auth_file_snapshot'
  | 'auth_provider_snapshot'
  | 'auth_account_id_snapshot'
  | 'auth_project_id_snapshot'
  | 'auth_snapshot_at_ms'
>;

const isCodexEvent = (e: SnapshotFields) => (e.auth_provider_snapshot.trim() || e.provider.trim()).toLowerCase() === 'codex';

/** Whether an event is missing snapshot fields an auth-file lookup could fill. */
export function needsEnrichment(e: SnapshotFields & { auth_index: string }): boolean {
  if (!e.auth_index) return false;
  const codex = isCodexEvent(e);
  const accountMissing = codex ? normalizeCodexMember(e.account_snapshot) === null : !e.account_snapshot;
  return accountMissing || !e.auth_file_snapshot || !e.auth_label_snapshot || (codex && !e.auth_account_id_snapshot) || !e.auth_project_id_snapshot;
}

/** CPAMP `codexSnapshotCanEnrichEvent`: never mix member/workspace evidence from two sources. */
function codexCanEnrich(e: SnapshotFields, s: AuthSnapshot): boolean {
  if (s.invalid) return false;
  const eventProvider = e.auth_provider_snapshot.trim() || e.provider.trim();
  if (eventProvider && s.provider && eventProvider.toLowerCase() !== s.provider.toLowerCase()) return false;
  const eventMember = normalizeCodexMember(e.account_snapshot);
  const snapMember = normalizeCodexMember(s.account);
  if (eventMember && snapMember && eventMember !== snapMember) return false;
  const eventWorkspace = e.auth_account_id_snapshot.trim();
  const snapWorkspace = s.accountId.trim();
  if (eventWorkspace && snapWorkspace && eventWorkspace !== snapWorkspace) return false;
  if (eventMember && snapWorkspace && !snapMember && !eventWorkspace) return false;
  if (snapMember && eventWorkspace && !eventMember && !snapWorkspace) return false;
  return true;
}

/** Fills empty snapshot fields from `snapshot` (mutates). Returns whether anything changed. */
export function applySnapshot(e: SnapshotFields, s: AuthSnapshot): boolean {
  const codex = isCodexEvent(e) || s.provider === 'codex';
  if (codex && !codexCanEnrich(e, s)) return false;
  let updated = false;
  const accountMissing = isCodexEvent(e) ? normalizeCodexMember(e.account_snapshot) === null : !e.account_snapshot;
  if (accountMissing && s.account) {
    e.account_snapshot = s.account;
    updated = true;
  }
  if (!e.auth_label_snapshot && s.label) {
    e.auth_label_snapshot = s.label;
    updated = true;
  }
  if (!e.auth_file_snapshot && s.fileName) {
    e.auth_file_snapshot = s.fileName;
    updated = true;
  }
  if (!e.auth_provider_snapshot && s.provider) {
    e.auth_provider_snapshot = s.provider;
    updated = true;
  }
  if (!e.auth_account_id_snapshot && s.accountId) {
    e.auth_account_id_snapshot = s.accountId;
    updated = true;
  }
  if (!e.auth_project_id_snapshot && s.projectId) {
    e.auth_project_id_snapshot = s.projectId;
    updated = true;
  }
  if (updated && !e.auth_snapshot_at_ms) e.auth_snapshot_at_ms = s.capturedAtMs;
  return updated;
}

export interface AuthSnapshotResolverOptions {
  db: DatabaseSync;
  client: CpaClient;
  log: Logger;
  now?: () => number;
}

export class AuthSnapshotResolver {
  private readonly db: DatabaseSync;
  private readonly client: CpaClient;
  private readonly log: Logger;
  private readonly now: () => number;
  private snapshots = new Map<string, AuthSnapshot>();
  private ambiguous = new Set<string>();
  private expiresAt = 0;
  private inflight: Promise<boolean> | null = null;
  private upsertStmt: StatementSync | null = null;
  private lastForcedAt = 0;
  /** Auth indexes whose stored events may lack snapshots ('all' until the first backfill). */
  private dirty: Set<string> | 'all' = 'all';

  constructor(options: AuthSnapshotResolverOptions) {
    this.db = options.db;
    this.client = options.client;
    this.log = options.log;
    this.now = options.now ?? Date.now;
  }

  /** Drops the cache (CPA published `{"refresh":true}`: auth files changed). */
  clear(): void {
    this.expiresAt = 0;
  }

  /** Fetches auth files when the cache is stale (single-flight). Resolves false on failure. */
  refresh(force = false): Promise<boolean> {
    if (!force && this.now() < this.expiresAt) return Promise.resolve(true);
    this.inflight ??= this.fetch().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async fetch(): Promise<boolean> {
    const capturedAt = this.now();
    let files: Rec[];
    try {
      files = await this.client.getAuthFiles({ timeoutMs: FETCH_TIMEOUT_MS });
    } catch (err) {
      this.log.warn('auth-files lookup failed; using cached labels', { error: (err as Error).message });
      // Retry no sooner than the TTL so a failing CPA is not hammered once per batch.
      this.expiresAt = capturedAt + AUTH_SNAPSHOT_TTL_MS;
      return false;
    }
    const parsed = parseAuthFiles(files, capturedAt);
    this.snapshots = parsed.snapshots;
    this.ambiguous = parsed.ambiguous;
    this.expiresAt = capturedAt + AUTH_SNAPSHOT_TTL_MS;
    try {
      this.persist(capturedAt);
      this.backfill();
    } catch (err) {
      this.log.warn('auth snapshot persist/backfill failed', { error: (err as Error).message });
    }
    return true;
  }

  /** Enriches events in place (fetching auth files first when some need labels). */
  async enrich(events: EventRowInsert[]): Promise<void> {
    const needing = events.filter((e) => needsEnrichment(e));
    if (needing.length === 0) return;
    await this.refresh();
    const unknown = needing.some((e) => !this.snapshots.has(e.auth_index) && !this.ambiguous.has(e.auth_index));
    // An auth index missing from a cached list usually means CPA added a credential: refetch, but at
    // most once per TTL (API-key credentials never appear in auth-files at all).
    if (unknown && this.now() - this.lastForcedAt >= AUTH_SNAPSHOT_TTL_MS) {
      this.lastForcedAt = this.now();
      await this.refresh(true);
    }
    for (const event of needing) {
      const snapshot = this.snapshots.get(event.auth_index);
      if (snapshot) applySnapshot(event, snapshot);
    }
  }

  /** The writer stored an event without `auth_file_snapshot`; backfill it after the next fetch. */
  markDirty(authIndex: string): void {
    if (authIndex && this.dirty !== 'all') this.dirty.add(authIndex);
  }

  get size(): number {
    return this.snapshots.size;
  }

  private persist(now: number): void {
    this.upsertStmt ??= this.db.prepare(`
      INSERT INTO auth_snapshots (auth_index, file_name, provider, label, account, account_id, project_id,
        status, disabled, metadata_json, first_seen_ms, updated_at_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(auth_index) DO UPDATE SET
        file_name = excluded.file_name, provider = excluded.provider, label = excluded.label,
        account = excluded.account, account_id = excluded.account_id, project_id = excluded.project_id,
        status = excluded.status, disabled = excluded.disabled, metadata_json = excluded.metadata_json,
        updated_at_ms = excluded.updated_at_ms`);
    const stmt = this.upsertStmt;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const s of this.snapshots.values()) {
        stmt.run(
          s.authIndex,
          s.fileName,
          s.provider,
          s.label,
          s.account,
          s.accountId,
          s.projectId,
          s.status,
          s.disabled ? 1 : 0,
          JSON.stringify(s.metadata),
          now,
          now,
        );
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /** Fills snapshot fields on stored events that have none yet (bounded per call). */
  backfill(): number {
    let total = 0;
    const select = this.db.prepare(`
      SELECT id, provider, auth_index, ${SEARCH_COLUMNS.filter((c) => c !== 'auth_index' && c !== 'auth_provider_snapshot').join(', ')},
        auth_provider_snapshot, auth_account_id_snapshot, auth_snapshot_at_ms
      FROM events
      WHERE auth_index = ? AND (auth_file_snapshot IS NULL OR auth_file_snapshot = '') AND id > ?
      ORDER BY id LIMIT ${BACKFILL_BATCH}`);
    const update = this.db.prepare(`
      UPDATE events SET account_snapshot = ?, auth_label_snapshot = ?, auth_file_snapshot = ?,
        auth_provider_snapshot = ?, auth_account_id_snapshot = ?, auth_project_id_snapshot = ?,
        auth_snapshot_at_ms = ?, search_text = ?
      WHERE id = ?`);
    const dirty = this.dirty;
    this.dirty = new Set(dirty === 'all' ? [] : [...dirty].filter((index) => !this.snapshots.has(index)));
    for (const snapshot of this.snapshots.values()) {
      if (!snapshot.fileName) continue;
      if (dirty !== 'all' && !dirty.has(snapshot.authIndex)) continue;
      let afterId = 0;
      for (let pass = 0; pass < 50; pass++) {
        const rows = select.all(snapshot.authIndex, afterId) as Array<Record<string, unknown>>;
        if (rows.length === 0) break;
        this.db.exec('BEGIN IMMEDIATE');
        try {
          for (const row of rows) {
            afterId = Number(row.id);
            const fields: SnapshotFields = {
              provider: String(row.provider ?? ''),
              account_snapshot: String(row.account_snapshot ?? ''),
              auth_label_snapshot: String(row.auth_label_snapshot ?? ''),
              auth_file_snapshot: String(row.auth_file_snapshot ?? ''),
              auth_provider_snapshot: String(row.auth_provider_snapshot ?? ''),
              auth_account_id_snapshot: String(row.auth_account_id_snapshot ?? ''),
              auth_project_id_snapshot: String(row.auth_project_id_snapshot ?? ''),
              auth_snapshot_at_ms: row.auth_snapshot_at_ms === null ? null : Number(row.auth_snapshot_at_ms),
            };
            if (!applySnapshot(fields, snapshot)) continue;
            const searchText = buildSearchText({ ...row, ...fields });
            update.run(
              fields.account_snapshot,
              fields.auth_label_snapshot,
              fields.auth_file_snapshot,
              fields.auth_provider_snapshot,
              fields.auth_account_id_snapshot,
              fields.auth_project_id_snapshot,
              fields.auth_snapshot_at_ms,
              searchText,
              afterId,
            );
            total++;
          }
          this.db.exec('COMMIT');
        } catch (err) {
          this.db.exec('ROLLBACK');
          throw err;
        }
        if (rows.length < BACKFILL_BATCH) break;
        // Bounded work per fetch: continue on the next one.
        if (pass === 49) (this.dirty as Set<string>).add(snapshot.authIndex);
      }
    }
    if (total > 0) this.log.info('backfilled auth snapshots on stored events', { rows: total });
    return total;
  }
}
