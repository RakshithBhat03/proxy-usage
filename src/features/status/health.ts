import type { AuthFile } from '@/lib/api/authFiles';
import { isDisabledAuthFile, resolveAuthProvider } from '@/lib/quota/files';
import type { SystemResponse } from '@shared/system-types.ts';

/** ok = green, warn = amber, down = red, off = muted (disabled on purpose / unknown). */
export type Health = 'ok' | 'warn' | 'down' | 'off';

export interface ServiceHealth {
  health: Health;
  label: string;
}

export function cpaHealth(system: SystemResponse): ServiceHealth {
  if (!system.cpa.reachable) return { health: 'down', label: 'Unreachable' };
  return { health: 'ok', label: 'Online' };
}

export function updateHealth(system: SystemResponse): ServiceHealth {
  const { cpa } = system;
  if (cpa.update_available) return { health: 'warn', label: 'Update available' };
  if (cpa.update_available === false) return { health: 'ok', label: 'Up to date' };
  return { health: 'off', label: cpa.latest_error ? 'Check failed' : 'Unknown' };
}

export function collectorHealth(system: SystemResponse): ServiceHealth {
  const { collector } = system;
  switch (collector.state) {
    case 'running':
      return collector.usage_statistics_enabled === false
        ? { health: 'warn', label: 'Statistics off' }
        : { health: 'ok', label: 'Recording' };
    case 'starting':
      return { health: 'warn', label: 'Connecting' };
    case 'backoff':
      return { health: collector.last_error ? 'down' : 'warn', label: 'Reconnecting' };
    case 'auth_failed':
      return { health: 'down', label: 'Key rejected' };
    case 'disabled':
      return { health: 'off', label: 'Disabled' };
    default:
      return { health: 'off', label: 'Stopped' };
  }
}

export function databaseHealth(system: SystemResponse): ServiceHealth {
  if (system.retention?.last_error) return { health: 'warn', label: 'Maintenance failed' };
  return { health: 'ok', label: 'Healthy' };
}

export function pricingHealth(system: SystemResponse): ServiceHealth {
  const { pricing } = system;
  if (!pricing) return { health: 'off', label: 'Not loaded' };
  if (pricing.last_sync_error) return { health: 'warn', label: 'Sync failed' };
  if (pricing.models === 0) return { health: 'warn', label: 'Empty' };
  return { health: 'ok', label: pricing.sync_interval_hours > 0 ? 'Synced' : 'Manual' };
}

export interface CredentialSummary {
  total: number;
  active: number;
  disabled: number;
  /** Enabled but currently unusable (CPA's `unavailable`, or an error status). */
  unavailable: number;
  /** Enabled credentials with a model or credential cooldown running. */
  cooling: number;
  providers: Array<{ provider: string; active: number; total: number }>;
}

function hasCooldown(file: AuthFile): boolean {
  const cooldowns = file.cooldowns;
  if (Array.isArray(cooldowns)) return cooldowns.length > 0;
  if (cooldowns && typeof cooldowns === 'object') return Object.keys(cooldowns).length > 0;
  return false;
}

export function summarizeCredentials(files: AuthFile[]): CredentialSummary {
  const providers = new Map<string, { active: number; total: number }>();
  let active = 0;
  let disabled = 0;
  let unavailable = 0;
  let cooling = 0;
  for (const file of files) {
    const provider = resolveAuthProvider(file) || 'unknown';
    const entry = providers.get(provider) ?? { active: 0, total: 0 };
    entry.total++;
    providers.set(provider, entry);
    if (isDisabledAuthFile(file)) {
      disabled++;
      continue;
    }
    const status = String(file.status ?? '').toLowerCase();
    if (file.unavailable === true || status === 'error' || status === 'unavailable') {
      unavailable++;
      continue;
    }
    active++;
    entry.active++;
    if (hasCooldown(file)) cooling++;
  }
  return {
    total: files.length,
    active,
    disabled,
    unavailable,
    cooling,
    providers: [...providers.entries()]
      .map(([provider, counts]) => ({ provider, ...counts }))
      .sort((a, b) => b.total - a.total || a.provider.localeCompare(b.provider)),
  };
}

export function credentialHealth(summary: CredentialSummary | null): ServiceHealth {
  if (!summary) return { health: 'off', label: 'Unknown' };
  if (summary.total === 0) return { health: 'warn', label: 'None' };
  if (summary.active === 0) return { health: 'down', label: 'None usable' };
  if (summary.unavailable > 0) return { health: 'warn', label: `${summary.unavailable} unavailable` };
  return { health: 'ok', label: `${summary.active} active` };
}
