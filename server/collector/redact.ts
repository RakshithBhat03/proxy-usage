/**
 * Credential scrubbing for anything the collector persists or logs (failure summaries, masked
 * sources, header values, dead-letter payloads). Port of CPA Manager Plus
 * `usage/persistence_security.go` (MIT); regexes are RE2-compatible and behave the same in JS.
 */
import { createHash } from 'node:crypto';

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

const QUOTED_KEY = String.raw`(?:"([^"\r\n]+)"|'([^'\r\n]+)')`;
const UNQUOTED_KEY = String.raw`\b([a-zA-Z0-9_.-]+(?:[ \t]+[a-zA-Z0-9_.-]+){0,2})\b`;

const re = (source: string, flags = 'gi') => new RegExp(source, flags);

const AUTH_COLON_HEADER = re(String.raw`\b((?:[a-zA-Z0-9_.-]+[ \t]+)?[a-zA-Z0-9_.-]*authorization)(\s*:\s*)[^\r\n]+`);
const AUTH_SIMPLE_ASSIGNMENT = re(
  String.raw`\b((?:[a-zA-Z0-9_.-]+[ \t]+)?[a-zA-Z0-9_.-]*authorization)(\s*=\s*)(?:basic|bearer)\s+[A-Za-z0-9._~+/=-]+`,
);
const AUTH_COMPLEX_ASSIGNMENT = re(String.raw`\b((?:[a-zA-Z0-9_.-]+[ \t]+)?[a-zA-Z0-9_.-]*authorization)(\s*=\s*)[a-zA-Z][^\r\n]*`);
const COOKIE_COLON_HEADER = re(String.raw`\b((?:[a-zA-Z0-9_.-]+[ \t]+)?[a-zA-Z0-9_.-]*cookie)(\s*:\s*)[^\r\n]+`);
const COOKIE_ASSIGNMENT = re(String.raw`\b((?:[a-zA-Z0-9_.-]+[ \t]+)?[a-zA-Z0-9_.-]*cookie)(\s*=\s*)([^"'\r\n][^\r\n]*)`);
const BEARER_TOKEN = re(String.raw`\bbearer\s+[A-Za-z0-9._~+/=-]{8,}`);
const PEM_PRIVATE_KEY = re(
  String.raw`-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |ENCRYPTED |DSA )?PRIVATE KEY-----`,
  'g',
);

const QK_DOUBLE = re(QUOTED_KEY + String.raw`(\s*[:=]\s*)"((?:[^"\\]|\\.)*)"`);
const QK_SINGLE = re(QUOTED_KEY + String.raw`(\s*[:=]\s*)'((?:[^'\\]|\\.)*)'`);
const QK_UNTERMINATED_DOUBLE = re(QUOTED_KEY + String.raw`(\s*[:=]\s*)"((?:[^"\\\r\n]|\\.)*\\?)(\r?\n|$)`);
const QK_UNTERMINATED_SINGLE = re(QUOTED_KEY + String.raw`(\s*[:=]\s*)'((?:[^'\\\r\n]|\\.)*\\?)(\r?\n|$)`);
const QK_UNQUOTED = re(QUOTED_KEY + String.raw`(\s*[:=]\s*)(\[redacted\]|[^"',\s&}\]\r\n]+)`);

const UK_DOUBLE = re(UNQUOTED_KEY + String.raw`(\s*[:=]\s*)"((?:[^"\\]|\\.)*)"`);
const UK_SINGLE = re(UNQUOTED_KEY + String.raw`(\s*[:=]\s*)'((?:[^'\\]|\\.)*)'`);
const UK_UNTERMINATED_DOUBLE = re(UNQUOTED_KEY + String.raw`(\s*[:=]\s*)"((?:[^"\\\r\n]|\\.)*\\?)(\r?\n|$)`);
const UK_UNTERMINATED_SINGLE = re(UNQUOTED_KEY + String.raw`(\s*[:=]\s*)'((?:[^'\\\r\n]|\\.)*\\?)(\r?\n|$)`);
const UK_UNQUOTED_EQUALS = re(UNQUOTED_KEY + String.raw`(\s*=\s*)(\[redacted\]|[^"',\s&}\]\r\n]+)`);
const UK_UNQUOTED_COLON = re(UNQUOTED_KEY + String.raw`(\s*:\s*)(\[redacted\]|[^"',\s&}\]\r\n]+)`);

const STRONG_TOKEN = re(
  String.raw`\b(sk-proj-[A-Za-z0-9_-]{24,}|sk-ant-[A-Za-z0-9_-]{24,}|sk-[A-Za-z0-9]{24,}|github_pat_[A-Za-z0-9_]{40,}|ghp_[A-Za-z0-9]{30,}|AIza[0-9A-Za-z_-]{30,}|hf_[A-Za-z0-9]{30,}|sess-[A-Za-z0-9_-]{24,}|pk_(?:live|test)_[0-9a-zA-Z]{24,}|pk_[0-9a-zA-Z]{24,}|rk_(?:live|test)_[0-9a-zA-Z]{24,}|rk_[0-9a-zA-Z]{24,}|cpamp_[A-Za-z0-9_-]{32,})\b`,
);
const MALFORMED_USAGE_KEY = re(
  String.raw`(["']key["']\s*[:=]\s*)(?:"(?:[^"\\\r\n]|\\.)*"|'(?:[^'\\\r\n]|\\.)*'|"(?:[^"\\\r\n]|\\.)*\\?|'(?:[^'\\\r\n]|\\.)*\\?|[^"',\s&}\]\r\n]+)`,
);
const EMAIL = /([A-Za-z0-9._%+-])([A-Za-z0-9._%+-]*)(@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;

const SECRET_KEY_SUFFIXES = [
  '_api_key',
  '_management_key',
  '_access_token',
  '_refresh_token',
  '_id_token',
  '_auth_token',
  '_session_token',
  '_client_secret',
  '_private_key',
  '_password',
  '_passwd',
  '_secret',
  '_authorization',
  '_cookie',
];

const SECRET_EXACT_KEYS = new Set([
  'api_key',
  'apikey',
  'x_api_key',
  'xapi_key',
  'xapikey',
  'management_key',
  'managementkey',
  'cpa_management_key',
  'cpamanagementkey',
  'authorization',
  'cookie',
  'set_cookie',
  'access_token',
  'refresh_token',
  'id_token',
  'token',
  'client_secret',
  'clientsecret',
  'private_key',
  'privatekey',
  'secret',
  'password',
  'passwd',
  'auth_token',
  'authtoken',
  'session',
  'session_token',
  'sessiontoken',
]);

const isUpper = (c: string) => c !== c.toLowerCase() && c === c.toUpperCase();
const isLower = (c: string) => c !== c.toUpperCase() && c === c.toLowerCase();

/** camelCase / kebab / spaced keys → snake_case (`apiKey` → `api_key`). */
export function normalizeSecretKey(key: string): string {
  const runes = Array.from(key.trim());
  if (runes.length === 0) return '';
  let out = '';
  for (let i = 0; i < runes.length; i++) {
    const r = runes[i];
    if (isUpper(r)) {
      if (i > 0) {
        const prev = runes[i - 1];
        const sep = prev === '_' || prev === '-' || prev === ' ';
        if (!isUpper(prev) && !sep) out += '_';
        else if (i + 1 < runes.length && isLower(runes[i + 1]) && !sep) out += '_';
      }
      out += r.toLowerCase();
    } else if (r === '-' || r === ' ') {
      out += '_';
    } else {
      out += r;
    }
  }
  return out.replace(/^_+|_+$/g, '');
}

export function isSecretFieldKey(key: string): boolean {
  const normalized = normalizeSecretKey(key);
  if (SECRET_EXACT_KEYS.has(normalized)) return true;
  if (normalized.startsWith('secret_')) return true;
  return SECRET_KEY_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

function isAuthorizationFieldKey(key: string): boolean {
  const normalized = normalizeSecretKey(key);
  return normalized === 'authorization' || normalized.endsWith('_authorization');
}

function isCookieFieldKey(key: string): boolean {
  const normalized = normalizeSecretKey(key);
  return normalized === 'cookie' || normalized === 'set_cookie' || normalized.endsWith('_cookie');
}

function matchQuotedKey(k1: string | undefined, k2: string | undefined): boolean {
  return (!!k1 && isSecretFieldKey(k1)) || (!!k2 && isSecretFieldKey(k2));
}

function matchUnquotedKey(rawKey: string | undefined): { prefix: string; secretKey: string } | null {
  if (!rawKey) return null;
  if (isSecretFieldKey(rawKey)) return { prefix: '', secretKey: rawKey };
  const words = rawKey.split(/\s+/).filter(Boolean);
  for (let i = 1; i < words.length; i++) {
    const candidate = words.slice(i).join(' ');
    if (!isSecretFieldKey(candidate) || normalizeSecretKey(candidate) === 'token') continue;
    const idx = rawKey.indexOf(candidate);
    return { prefix: idx > 0 ? rawKey.slice(0, idx) : '', secretKey: candidate };
  }
  return null;
}

function replaceQuoted(input: string, pattern: RegExp, quote: string, unterminated: boolean): string {
  return input.replace(pattern, (m: string, k1?: string, k2?: string, sep?: string, _value?: string, trailing?: string) => {
    if (!matchQuotedKey(k1, k2) || sep === undefined) return m;
    const sepIdx = m.indexOf(sep);
    if (sepIdx < 0) return m;
    const fullPrefix = m.slice(0, sepIdx + sep.length);
    return unterminated ? `${fullPrefix}${quote}[redacted]${trailing ?? ''}` : `${fullPrefix}${quote}[redacted]${quote}`;
  });
}

function replaceUnquoted(input: string, pattern: RegExp, quote: string, unterminated: boolean): string {
  return input.replace(pattern, (m: string, rawKey?: string, sep?: string, _value?: string, trailing?: string) => {
    const match = matchUnquotedKey(rawKey);
    if (!match || sep === undefined) return m;
    const sepIdx = m.indexOf(sep);
    if (sepIdx < 0) return m;
    const fullPrefix = m.slice(0, sepIdx + sep.length);
    const tail = unterminated ? `${quote}[redacted]${trailing ?? ''}` : `${quote}[redacted]${quote}`;
    if (match.prefix) {
      const keyIdx = fullPrefix.indexOf(match.secretKey);
      if (keyIdx > 0) return fullPrefix.slice(0, keyIdx) + match.secretKey + sep + tail;
    }
    return fullPrefix + tail;
  });
}

function test(pattern: RegExp, value: string): boolean {
  pattern.lastIndex = 0;
  const result = pattern.test(value);
  pattern.lastIndex = 0;
  return result;
}

function containsSecretAssignment(input: string): boolean {
  for (const pattern of [QK_DOUBLE, QK_SINGLE, QK_UNTERMINATED_DOUBLE, QK_UNTERMINATED_SINGLE, QK_UNQUOTED]) {
    for (const m of input.matchAll(pattern)) if (matchQuotedKey(m[1], m[2])) return true;
  }
  for (const pattern of [UK_DOUBLE, UK_SINGLE, UK_UNTERMINATED_DOUBLE, UK_UNTERMINATED_SINGLE, UK_UNQUOTED_EQUALS, UK_UNQUOTED_COLON]) {
    for (const m of input.matchAll(pattern)) if (matchUnquotedKey(m[1])) return true;
  }
  return false;
}

function containsHeader(value: string, patterns: RegExp[], isKey: (key: string) => boolean): boolean {
  for (const pattern of patterns) for (const m of value.matchAll(pattern)) if (m[1] && isKey(m[1])) return true;
  return false;
}

export function containsCredentialToken(value: string): boolean {
  return test(STRONG_TOKEN, value) || test(BEARER_TOKEN, value);
}

/** Whether `value` holds credentials (tokens, auth/cookie headers, PEM keys, secret key=value). */
export function containsCredential(value: string): boolean {
  return (
    containsCredentialToken(value) ||
    containsHeader(value, [AUTH_COLON_HEADER, AUTH_SIMPLE_ASSIGNMENT, AUTH_COMPLEX_ASSIGNMENT], isAuthorizationFieldKey) ||
    containsHeader(value, [COOKIE_COLON_HEADER, COOKIE_ASSIGNMENT], isCookieFieldKey) ||
    test(PEM_PRIVATE_KEY, value) ||
    containsSecretAssignment(value)
  );
}

/** Scrubs credentials from free text or malformed JSON. */
export function sanitizeCredentialText(value: string): string {
  if (!value) return '';
  let res = value;
  res = res.replace(AUTH_COLON_HEADER, (m, key: string, sep: string) => {
    if (!isAuthorizationFieldKey(key)) return m;
    if (m.slice(key.length + sep.length).trim() === '[redacted]') return m;
    return `${key}${sep}[redacted]`;
  });
  res = res.replace(AUTH_SIMPLE_ASSIGNMENT, (m, key: string, sep: string) =>
    isAuthorizationFieldKey(key) ? `${key}${sep}[redacted]` : m,
  );
  res = res.replace(AUTH_COMPLEX_ASSIGNMENT, (m, key: string, sep: string) =>
    isAuthorizationFieldKey(key) ? `${key}${sep}[redacted]` : m,
  );
  res = res.replace(COOKIE_COLON_HEADER, (m, key: string, sep: string) => {
    if (!isCookieFieldKey(key)) return m;
    if (m.slice(key.length + sep.length).trim() === '[redacted]') return m;
    return `${key}${sep}[redacted]`;
  });
  res = res.replace(COOKIE_ASSIGNMENT, (m, key: string, sep: string, val: string) => {
    if (!isCookieFieldKey(key) || val.trim() === '[redacted]') return m;
    return `${key}${sep}[redacted]`;
  });
  res = res.replace(PEM_PRIVATE_KEY, '[redacted]');
  res = res.replace(BEARER_TOKEN, 'Bearer [redacted]');

  res = replaceQuoted(res, QK_DOUBLE, '"', false);
  res = replaceQuoted(res, QK_SINGLE, "'", false);
  res = replaceQuoted(res, QK_UNTERMINATED_DOUBLE, '"', true);
  res = replaceQuoted(res, QK_UNTERMINATED_SINGLE, "'", true);
  res = replaceQuoted(res, QK_UNQUOTED, '', false);

  res = replaceUnquoted(res, UK_DOUBLE, '"', false);
  res = replaceUnquoted(res, UK_SINGLE, "'", false);
  res = replaceUnquoted(res, UK_UNTERMINATED_DOUBLE, '"', true);
  res = replaceUnquoted(res, UK_UNTERMINATED_SINGLE, "'", true);
  res = replaceUnquoted(res, UK_UNQUOTED_EQUALS, '', false);
  res = replaceUnquoted(res, UK_UNQUOTED_COLON, '', false);

  res = res.replace(STRONG_TOKEN, '[redacted]');
  return res;
}

/** Truncates to at most `maxBytes` UTF-8 bytes (with "..." when cut), never splitting a character. */
export function truncateUtf8Bytes(value: string, maxBytes: number): string {
  if (maxBytes <= 0 || Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  const limit = maxBytes > 3 ? maxBytes - 3 : maxBytes;
  const suffix = maxBytes > 3 ? '...' : '';
  let out = '';
  let size = 0;
  for (const ch of value) {
    const n = Buffer.byteLength(ch, 'utf8');
    if (size + n > limit) break;
    out += ch;
    size += n;
  }
  return out.trim() + suffix;
}

/** Truncates to at most `maxChars` characters (code points), with "..." when cut. */
export function truncateChars(value: string, maxChars: number): string {
  const chars = Array.from(value);
  if (chars.length <= maxChars) return value;
  return `${chars.slice(0, Math.max(0, maxChars - 3)).join('').trim()}...`;
}

/** Bodies longer than this are cut before regex scrubbing (keeps worst-case regex time bounded). */
const MAX_SCRUB_INPUT_CHARS = 16_384;
const MAX_FAIL_SUMMARY_BYTES = 4096;
/** Stored `fail_summary` cap (characters). */
export const FAIL_SUMMARY_MAX_CHARS = 500;

/** CPAMP `FailSummaryFromBody`: scrub credentials, mask emails, cap at 4096 bytes. */
export function failSummaryFromBody(body: string): string {
  let summary = body.trim();
  if (!summary) return '';
  if (summary.length > MAX_SCRUB_INPUT_CHARS) summary = summary.slice(0, MAX_SCRUB_INPUT_CHARS);
  summary = sanitizeCredentialText(summary);
  summary = summary.replace(EMAIL, '$1***$3');
  return truncateUtf8Bytes(summary.trim(), MAX_FAIL_SUMMARY_BYTES);
}

/** The stored failure summary: redacted, whitespace-collapsed, ≤ 500 characters. */
export function storedFailSummary(body: string): string {
  const summary = failSummaryFromBody(body).replace(/\s+/g, ' ').trim();
  return truncateChars(summary, FAIL_SUMMARY_MAX_CHARS);
}

/** CPAMP `looksSecret` used by `maskSource`. */
function looksSecret(value: string): boolean {
  if (/[ /\\]/.test(value)) return false;
  return value.startsWith('sk-') || value.startsWith('AIza') || value.length >= 32;
}

/** CPAMP `maskSource`: emails → `abc***@domain`, credentials → `h:<sha256>`, secrets → `m:abcd...wxyz`. */
export function maskSource(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  const at = trimmed.indexOf('@');
  if (at >= 0) {
    // Go slices bytes; for ASCII local parts (the norm) this is identical.
    const prefix = Buffer.from(trimmed.slice(0, at), 'utf8').subarray(0, 3).toString('utf8');
    return `${prefix}***@${trimmed.slice(at + 1)}`;
  }
  if (containsCredential(trimmed)) return `h:${sha256Hex(trimmed)}`;
  if (looksSecret(trimmed)) {
    if (trimmed.length <= 8) return 'm:****';
    return `m:${trimmed.slice(0, 4)}...${trimmed.slice(-4)}`;
  }
  return trimmed;
}

/** Request metadata (client ip, XFF, user agent): control chars → spaces, collapsed, byte-capped. */
export function sanitizeRequestMetadata(value: string, maxBytes: number): string {
  // Go: unicode.IsSpace || !unicode.IsGraphic → ' '.
  const cleaned = value.replace(/[\s\p{C}\p{Z}]/gu, ' ');
  const collapsed = cleaned.split(' ').filter(Boolean).join(' ');
  return maxBytes > 0 ? truncateUtf8Bytes(collapsed, maxBytes) : collapsed;
}

const REQUEST_METADATA_MAX_BYTES: Record<string, number> = {
  client_ip: 64,
  clientip: 64,
  x_forwarded_for: 2048,
  xforwardedfor: 2048,
  user_agent: 1024,
  useragent: 1024,
};

/** CPAMP `sanitizeJSONValueWithContext`: redacts secret keys/values recursively. */
export function sanitizeJsonValue(value: unknown, parentKey = '', depth = 0): unknown {
  if (Array.isArray(value)) return value.map((child) => sanitizeJsonValue(child, parentKey, depth + 1));
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const safeKey = containsCredential(key) ? `[redacted-key:${sha256Hex(key)}]` : key;
      const normalizedKey = normalizeSecretKey(key);
      if ((depth === 0 && normalizedKey === 'key') || isSecretFieldKey(key)) {
        result[safeKey] = '[redacted]';
        continue;
      }
      const maxBytes = REQUEST_METADATA_MAX_BYTES[normalizedKey];
      if (maxBytes !== undefined) {
        result[safeKey] = sanitizeRequestMetadata(sanitizeCredentialText(stringValue(child)), maxBytes);
        continue;
      }
      if (normalizedKey === 'fail_body' || (parentKey === 'fail' && normalizedKey === 'body')) {
        result[safeKey] = failSummaryFromBody(stringValue(child));
        continue;
      }
      result[safeKey] = sanitizeJsonValue(child, normalizedKey, depth + 1);
    }
    return result;
  }
  if (typeof value === 'string') return sanitizeCredentialText(value.length > MAX_SCRUB_INPUT_CHARS ? value.slice(0, MAX_SCRUB_INPUT_CHARS) : value);
  return value;
}

function stringValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/**
 * Redacts a raw usage payload for `dead_letters`: secret keys (api_key, key, tokens …) become
 * "[redacted]", failure bodies become summaries; malformed JSON falls back to text scrubbing.
 */
export function redactPayloadForStorage(raw: string, maxChars = 16_384): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  let out: string;
  try {
    out = JSON.stringify(sanitizeJsonValue(JSON.parse(trimmed)));
  } catch {
    out = failSummaryFromBody(trimmed.replace(MALFORMED_USAGE_KEY, '$1"[redacted]"'));
  }
  return truncateChars(out, maxChars);
}
