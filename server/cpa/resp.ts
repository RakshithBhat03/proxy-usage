/**
 * Minimal RESP (Redis protocol) client for CLIProxyAPI's usage channel: AUTH, SUBSCRIBE and PING
 * over CPA's HTTP port (CPA sniffs the protocol). Semantics ported from CPA Manager Plus (MIT).
 *
 * `RespParser` is incremental: feed it whatever chunks the socket delivers (frames may be split at
 * any byte) and it returns every complete value. Values: simple strings → string, bulk strings →
 * string | null, integers → number, arrays → RespValue[] | null, errors → RespError (as a value,
 * never thrown). RESP3 null (`_`), boolean (`#`), double (`,`) and push (`>`) are accepted too.
 */
import net from 'node:net';
import tls from 'node:tls';

export class RespError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RespError';
  }
}

export type RespValue = string | number | boolean | null | RespError | RespValue[];

/** Thrown for malformed protocol data; the connection must be dropped. */
export class RespProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RespProtocolError';
  }
}

const INCOMPLETE = Symbol('incomplete');
type Parsed = { value: RespValue; next: number } | typeof INCOMPLETE;

/** Upper bound for one bulk string / array length (defends against garbage length prefixes). */
const MAX_BULK_BYTES = 256 * 1024 * 1024;
const MAX_ARRAY_ITEMS = 1_000_000;

export class RespParser {
  private buf: Buffer = Buffer.alloc(0);
  /** Skip parse attempts until at least this many bytes are buffered (large split bulk strings). */
  private needed = 0;

  /** Appends a chunk and returns every value that is now complete. Throws RespProtocolError. */
  push(chunk: Buffer): RespValue[] {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    if (this.buf.length < this.needed) return [];
    const out: RespValue[] = [];
    let offset = 0;
    while (offset < this.buf.length) {
      this.needed = 0;
      const parsed = this.parse(offset);
      if (parsed === INCOMPLETE) break;
      out.push(parsed.value);
      offset = parsed.next;
    }
    this.buf = offset >= this.buf.length ? Buffer.alloc(0) : this.buf.subarray(offset);
    if (this.needed > 0) this.needed -= offset;
    return out;
  }

  /** Bytes buffered but not yet parsed. */
  get pending(): number {
    return this.buf.length;
  }

  private readLine(offset: number): { line: string; next: number } | typeof INCOMPLETE {
    const end = this.buf.indexOf('\r\n', offset);
    if (end < 0) {
      if (this.buf.length - offset > 64 * 1024) throw new RespProtocolError('RESP line too long');
      return INCOMPLETE;
    }
    return { line: this.buf.toString('utf8', offset, end), next: end + 2 };
  }

  private readLength(line: string, max: number): number {
    if (!/^-?\d+$/.test(line)) throw new RespProtocolError(`invalid RESP length "${line.slice(0, 32)}"`);
    const length = Number(line);
    if (length > max) throw new RespProtocolError(`RESP length ${length} exceeds limit`);
    return length;
  }

  private parse(offset: number): Parsed {
    if (offset >= this.buf.length) return INCOMPLETE;
    const prefix = String.fromCharCode(this.buf[offset]);
    const head = this.readLine(offset + 1);
    if (head === INCOMPLETE) return INCOMPLETE;
    const { line, next } = head;
    switch (prefix) {
      case '+':
        return { value: line, next };
      case '-':
        return { value: new RespError(line), next };
      case ':': {
        if (!/^[+-]?\d+$/.test(line)) throw new RespProtocolError('invalid RESP integer');
        return { value: Number(line), next };
      }
      case '_':
        return { value: null, next };
      case '#':
        return { value: line === 't', next };
      case ',': {
        const value = Number(line);
        if (Number.isNaN(value) && line !== 'nan') throw new RespProtocolError('invalid RESP double');
        return { value, next };
      }
      case '$': {
        const length = this.readLength(line, MAX_BULK_BYTES);
        if (length < 0) return { value: null, next };
        const end = next + length;
        if (this.buf.length < end + 2) {
          this.needed = end + 2;
          return INCOMPLETE;
        }
        if (this.buf[end] !== 0x0d || this.buf[end + 1] !== 0x0a) throw new RespProtocolError('bulk string not CRLF-terminated');
        return { value: this.buf.toString('utf8', next, end), next: end + 2 };
      }
      case '*':
      case '>': {
        const length = this.readLength(line, MAX_ARRAY_ITEMS);
        if (length < 0) return { value: null, next };
        const items: RespValue[] = [];
        let cursor = next;
        for (let i = 0; i < length; i++) {
          const item = this.parse(cursor);
          if (item === INCOMPLETE) return INCOMPLETE;
          items.push(item.value);
          cursor = item.next;
        }
        return { value: items, next: cursor };
      }
      default:
        throw new RespProtocolError(`unsupported RESP prefix 0x${this.buf[offset].toString(16)}`);
    }
  }
}

/** Encodes a command as a RESP array of bulk strings. */
export function encodeCommand(args: readonly string[]): Buffer {
  const parts: Buffer[] = [Buffer.from(`*${args.length}\r\n`)];
  for (const arg of args) {
    const data = Buffer.from(arg, 'utf8');
    parts.push(Buffer.from(`$${data.length}\r\n`), data, Buffer.from('\r\n'));
  }
  return Buffer.concat(parts);
}

export interface RespConnectOptions {
  /** CPA base URL (http or https); the RESP endpoint shares CPA's HTTP port. */
  url: string;
  tlsInsecure?: boolean;
  connectTimeoutMs?: number;
  /** Reply timeout for AUTH / SUBSCRIBE / other commands. */
  commandTimeoutMs?: number;
}

/** Message delivered on a subscribed channel. */
export interface RespMessage {
  channel: string;
  payload: string;
}

export class RespUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RespUnsupportedError';
  }
}

/** AUTH was rejected (wrong or missing key). */
export class RespAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RespAuthError';
  }
}

function isUnsupportedMessage(message: string): boolean {
  const lower = message.toLowerCase();
  return lower.includes('unknown command') || lower.includes('unsupported');
}

/**
 * One RESP connection. Commands are answered in order (`command()`); after `subscribe()` the
 * connection switches to push mode and every `message` frame goes to `onMessage`.
 */
export class RespConnection {
  readonly socket: net.Socket;
  private readonly parser = new RespParser();
  private readonly waiters: Array<{
    command: string;
    resolve: (v: RespValue) => void;
    reject: (e: Error) => void;
    timer: NodeJS.Timeout;
  }> = [];
  private subscribed = false;
  private closedError: Error | null = null;
  private closeListeners: Array<(err: Error | null) => void> = [];
  private readonly commandTimeoutMs: number;
  /** Time of the last byte received (ms). */
  lastDataAt = Date.now();
  onMessage: (message: RespMessage) => void = () => {};

  private constructor(socket: net.Socket, commandTimeoutMs: number) {
    this.socket = socket;
    this.commandTimeoutMs = commandTimeoutMs;
    socket.on('data', (chunk: Buffer) => this.handleData(chunk));
    socket.on('error', (err) => this.finish(err));
    socket.on('close', () => this.finish(this.closedError ?? new Error('RESP connection closed')));
  }

  static connect(options: RespConnectOptions): Promise<RespConnection> {
    const url = new URL(options.url);
    const secure = url.protocol === 'https:';
    const port = url.port ? Number(url.port) : secure ? 443 : 80;
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const timeoutMs = options.connectTimeoutMs ?? 10_000;
    return new Promise((resolve, reject) => {
      const socket = secure
        ? tls.connect({ host, port, servername: net.isIP(host) ? undefined : host, rejectUnauthorized: !options.tlsInsecure })
        : net.connect({ host, port });
      socket.setNoDelay(true);
      socket.setKeepAlive(true, 30_000);
      const timer = setTimeout(() => {
        socket.destroy(new Error(`RESP connect to ${url.host} timed out`));
      }, timeoutMs);
      const onError = (err: Error) => {
        clearTimeout(timer);
        reject(err);
      };
      socket.once('error', onError);
      socket.once(secure ? 'secureConnect' : 'connect', () => {
        clearTimeout(timer);
        socket.off('error', onError);
        resolve(new RespConnection(socket, options.commandTimeoutMs ?? 30_000));
      });
    });
  }

  get isClosed(): boolean {
    return this.closedError !== null;
  }

  /** Resolves (never rejects) when the connection closes, with the reason. */
  closed(): Promise<Error | null> {
    if (this.closedError) return Promise.resolve(this.closedError);
    return new Promise((resolve) => this.closeListeners.push(resolve));
  }

  /** Sends a command and waits for its reply. RESP error replies resolve as RespError values. */
  command(...args: string[]): Promise<RespValue> {
    if (this.closedError) return Promise.reject(this.closedError);
    if (this.subscribed) return Promise.reject(new Error('RESP connection is in subscribe mode'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const err = new Error(`RESP ${args[0]} timed out`);
        this.socket.destroy(err);
      }, this.commandTimeoutMs);
      this.waiters.push({ command: args[0].toUpperCase(), resolve, reject, timer });
      this.socket.write(encodeCommand(args));
    });
  }

  /** AUTH; throws RespAuthError when rejected, RespUnsupportedError when AUTH is unknown. */
  async auth(key: string): Promise<void> {
    const reply = await this.command('AUTH', key);
    if (reply instanceof RespError) {
      if (isUnsupportedMessage(reply.message)) throw new RespUnsupportedError(`AUTH: ${reply.message}`);
      throw new RespAuthError(`AUTH rejected: ${reply.message}`);
    }
  }

  /** SUBSCRIBE; throws RespUnsupportedError when the server has no pub/sub. */
  async subscribe(channel: string): Promise<void> {
    const reply = await this.command('SUBSCRIBE', channel);
    if (reply instanceof RespError) {
      if (isUnsupportedMessage(reply.message)) throw new RespUnsupportedError(`SUBSCRIBE: ${reply.message}`);
      throw new Error(`SUBSCRIBE failed: ${reply.message}`);
    }
    if (!Array.isArray(reply) || reply.length < 3 || String(reply[0]).toLowerCase() !== 'subscribe' || reply[1] !== channel) {
      this.subscribed = false;
      throw new Error('unexpected SUBSCRIBE reply');
    }
  }

  /** PING while subscribed (the reply is a `pong` frame, which only refreshes `lastDataAt`). */
  ping(): void {
    if (!this.closedError) this.socket.write(encodeCommand(['PING']));
  }

  close(reason?: Error): void {
    if (this.closedError) return;
    this.closedError = reason ?? new Error('RESP connection closed by client');
    this.socket.destroy();
  }

  private handleData(chunk: Buffer): void {
    this.lastDataAt = Date.now();
    let values: RespValue[];
    try {
      values = this.parser.push(chunk);
    } catch (err) {
      this.socket.destroy(err as Error);
      return;
    }
    for (const value of values) {
      const waiter = this.waiters.shift();
      if (waiter) {
        clearTimeout(waiter.timer);
        // Enter push mode before parsing the rest of this chunk: a message may follow the reply
        // in the same TCP segment.
        if (waiter.command === 'SUBSCRIBE' && Array.isArray(value) && String(value[0]).toLowerCase() === 'subscribe') {
          this.subscribed = true;
        }
        waiter.resolve(value);
        continue;
      }
      if (this.subscribed) this.handlePush(value);
    }
  }

  private handlePush(value: RespValue): void {
    if (Array.isArray(value)) {
      const kind = String(value[0] ?? '').toLowerCase();
      if (kind === 'message' && value.length >= 3) {
        const payload = value[2];
        this.onMessage({ channel: String(value[1] ?? ''), payload: typeof payload === 'string' ? payload : '' });
        return;
      }
      if (kind === 'subscribe' || kind === 'unsubscribe' || kind === 'pong') return;
      this.socket.destroy(new RespProtocolError(`unsupported subscribe frame "${kind.slice(0, 32)}"`));
      return;
    }
    if (typeof value === 'string' && value.toUpperCase() === 'PONG') return;
    if (value instanceof RespError) {
      this.socket.destroy(new Error(`RESP error: ${value.message}`));
      return;
    }
    this.socket.destroy(new RespProtocolError('unexpected RESP value in subscribe mode'));
  }

  private finish(err: Error): void {
    if (!this.closedError) this.closedError = err;
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(this.closedError);
    }
    for (const listener of this.closeListeners.splice(0)) listener(this.closedError);
  }
}
