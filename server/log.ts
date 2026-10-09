/**
 * Minimal leveled logger: one line per entry, `<iso time> <LEVEL> [scope] message {fields}`.
 * Never pass secrets (keys, tokens, raw request bodies) in messages or fields.
 */
import type { LogLevel } from './config.ts';

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /** A logger that prefixes entries with `[scope]`. */
  child(scope: string): Logger;
}

const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function serialize(fields: LogFields | undefined): string {
  if (!fields) return '';
  const entries = Object.entries(fields).filter(([, value]) => value !== undefined);
  if (entries.length === 0) return '';
  const plain = Object.fromEntries(
    entries.map(([key, value]) => [key, value instanceof Error ? { name: value.name, message: value.message } : value]),
  );
  try {
    return ` ${JSON.stringify(plain)}`;
  } catch {
    return ' {"fields":"unserializable"}';
  }
}

export function createLogger(level: LogLevel = 'info', scope = ''): Logger {
  const min = RANK[level];
  const prefix = scope ? ` [${scope}]` : '';
  const write = (entryLevel: LogLevel, message: string, fields?: LogFields) => {
    if (RANK[entryLevel] < min) return;
    const line = `${new Date().toISOString()} ${entryLevel.toUpperCase()}${prefix} ${message}${serialize(fields)}\n`;
    if (RANK[entryLevel] >= RANK.warn) process.stderr.write(line);
    else process.stdout.write(line);
  };
  return {
    debug: (message, fields) => write('debug', message, fields),
    info: (message, fields) => write('info', message, fields),
    warn: (message, fields) => write('warn', message, fields),
    error: (message, fields) => write('error', message, fields),
    child: (child) => createLogger(level, scope ? `${scope}:${child}` : child),
  };
}
