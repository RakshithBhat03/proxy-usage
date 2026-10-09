import { asRecord, normalizeStringValue } from './parse';
import { QUOTA_PROVIDERS, type AuthFileItem, type QuotaEntry, type QuotaProvider } from './types';

/** Credential classification ported from CPAMC `utils/quota/validators.ts` + `features/quota/logic.ts`. */

export function resolveAuthProvider(file: AuthFileItem): string {
  const raw = file.provider ?? file.type ?? '';
  const key = String(raw).trim().toLowerCase().replace(/_/g, '-');
  if (key === 'x-ai' || key === 'grok') return 'xai';
  // Kimi International (kimi.ai) accounts share Kimi's quota API on another host.
  if (key === 'kimi-ai') return 'kimi';
  if (key === 'muse' || key === 'meta-ai') return 'meta';
  return key;
}

export function isDisabledAuthFile(file: AuthFileItem): boolean {
  const raw: unknown = file.disabled;
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'number') return raw !== 0;
  if (typeof raw === 'string') return raw.trim().toLowerCase() === 'true';
  return false;
}

export const normalizeAuthIndex = (value: unknown): string | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value.toString();
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }
  return null;
};

export const authIndexOfFile = (file: AuthFileItem) => normalizeAuthIndex(file.auth_index ?? file.authIndex);

export function quotaProviderOf(file: AuthFileItem): QuotaProvider | null {
  const provider = resolveAuthProvider(file);
  return (QUOTA_PROVIDERS as readonly string[]).includes(provider) ? (provider as QuotaProvider) : null;
}

/** One Devin file can hold several identities, so its key includes the auth index. */
export function quotaCacheKey(file: AuthFileItem, provider: QuotaProvider): string {
  if (provider === 'devin') return `${file.name}\0${authIndexOfFile(file) ?? ''}`;
  return file.name;
}

export const isRuntimeOnly = (file: AuthFileItem) => {
  const raw: unknown = file.runtime_only ?? file.runtimeOnly;
  return raw === true || raw === 'true';
};

/** Supported credentials in tab order; disabled ones are kept but flagged so the page can count them. */
export function classifyQuotaFiles(files: readonly AuthFileItem[]): QuotaEntry[] {
  const entries: QuotaEntry[] = [];
  for (const file of files) {
    const provider = quotaProviderOf(file);
    if (!provider || !file.name) continue;
    entries.push({
      key: quotaCacheKey(file, provider),
      provider,
      file,
      name: file.name,
      email: normalizeStringValue(file.email) ?? normalizeStringValue(file.label),
      authIndex: authIndexOfFile(file),
      disabled: isDisabledAuthFile(file),
    });
  }
  const order = (provider: QuotaProvider) => QUOTA_PROVIDERS.indexOf(provider);
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => order(a.entry.provider) - order(b.entry.provider) || a.index - b.index)
    .map(({ entry }) => entry);
}

/** Search matches only the unmasked file name and email — never `account`, which can be a key. */
export function filterEntriesBySearch<T extends QuotaEntry>(entries: T[], query: string): T[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return entries;
  return entries.filter(
    (entry) => entry.name.toLowerCase().includes(needle) || (entry.email ?? '').toLowerCase().includes(needle),
  );
}

/** Devin shows "{name} · {email|auth_index}" because one file can carry several identities. */
export function entryDisplayName(entry: QuotaEntry): string {
  if (entry.provider === 'devin') return `${entry.name} · ${entry.email ?? entry.authIndex ?? ''}`;
  return entry.name;
}

/** Codex account id lookup; the live list carries it in the decoded `id_token`. */
export function resolveCodexAccountId(file: AuthFileItem): string | null {
  const metadata = asRecord(file.metadata);
  const idToken = asRecord(file.id_token);
  return (
    normalizeStringValue(file.chatgpt_account_id) ??
    normalizeStringValue(metadata.chatgpt_account_id) ??
    normalizeStringValue(idToken.chatgpt_account_id)
  );
}
