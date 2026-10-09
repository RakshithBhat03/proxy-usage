/**
 * Host header allowlist (DNS-rebinding guard). Allowed: localhost (and *.localhost), IP literals
 * (IPv4 and bracketed IPv6), *.ts.net (Tailscale MagicDNS / Serve), *.local (mDNS), and any extra
 * names from ALLOWED_HOSTS. An entry starting with `.` matches that domain and its subdomains; `*`
 * disables the check.
 */
import { isIP } from 'node:net';

const BUILTIN = ['localhost', '.localhost', '.ts.net', '.local'];

/** Hostname part of a Host header, lower-cased, without port, brackets or trailing dot. */
export function hostnameOf(hostHeader: string): string | null {
  const value = hostHeader.trim().toLowerCase();
  if (!value) return null;
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    if (end < 0) return null;
    const rest = value.slice(end + 1);
    if (rest && !/^:\d{1,5}$/.test(rest)) return null;
    return value.slice(1, end);
  }
  const colon = value.indexOf(':');
  if (colon >= 0 && value.indexOf(':', colon + 1) >= 0) {
    // Unbracketed IPv6 is not a valid Host header, but accept a bare literal.
    return isIP(value) === 6 ? value : null;
  }
  const host = colon >= 0 ? value.slice(0, colon) : value;
  if (colon >= 0 && !/^\d{1,5}$/.test(value.slice(colon + 1))) return null;
  return host.endsWith('.') ? host.slice(0, -1) : host;
}

export type HostCheck = (hostHeader: string | undefined) => boolean;

export function createHostCheck(extraHosts: readonly string[] = []): HostCheck {
  const entries = [...BUILTIN, ...extraHosts.map((host) => host.trim().toLowerCase()).filter(Boolean)];
  if (entries.includes('*')) return () => true;
  const exact = new Set(entries.filter((entry) => !entry.startsWith('.')));
  const suffixes = entries.filter((entry) => entry.startsWith('.'));
  return (hostHeader) => {
    if (!hostHeader) return false;
    const host = hostnameOf(hostHeader);
    if (!host) return false;
    if (isIP(host)) return true;
    if (exact.has(host)) return true;
    return suffixes.some((suffix) => host === suffix.slice(1) || host.endsWith(suffix));
  };
}

/** The allowlist in Vite's `server.allowedHosts` format (`true` when `*` disables the check). */
export function viteAllowedHosts(extraHosts: readonly string[] = []): true | string[] {
  const entries = [...BUILTIN, ...extraHosts.map((host) => host.trim().toLowerCase()).filter(Boolean)];
  return entries.includes('*') ? true : entries;
}
