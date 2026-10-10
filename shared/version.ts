/**
 * Release version helpers for CLIProxyAPI tags (`v8.0.23`, `8.0.23`, `v6.10.8-rc1`).
 */

export interface ParsedVersion {
  parts: number[];
  /** Text after `-`, e.g. `rc1`; '' for a release. */
  pre: string;
}

/** Parses `v1.2.3[-pre][+build]`; null when it has no leading numeric part. */
export function parseVersion(raw: string | null | undefined): ParsedVersion | null {
  const text = raw?.trim().replace(/^v/i, '').split('+')[0];
  if (!text) return null;
  const match = /^(\d+(?:\.\d+)*)(?:-(.+))?$/.exec(text);
  if (!match) return null;
  return { parts: match[1].split('.').map(Number), pre: match[2] ?? '' };
}

/**
 * Compares two versions: negative when `a` is older, positive when newer, 0 when equal. Missing
 * parts count as 0 and a pre-release sorts before its release. Null when either side does not parse.
 */
export function compareVersions(a: string | null | undefined, b: string | null | undefined): number | null {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return null;
  const length = Math.max(left.parts.length, right.parts.length);
  for (let i = 0; i < length; i++) {
    const diff = (left.parts[i] ?? 0) - (right.parts[i] ?? 0);
    if (diff !== 0) return Math.sign(diff);
  }
  if (left.pre === right.pre) return 0;
  if (!left.pre) return 1;
  if (!right.pre) return -1;
  return left.pre.localeCompare(right.pre, 'en', { numeric: true }) < 0 ? -1 : 1;
}

/** `8.0.23` → `v8.0.23` (display form of a tag). */
export function versionTag(raw: string): string {
  const text = raw.trim();
  return /^\d/.test(text) ? `v${text}` : text;
}
