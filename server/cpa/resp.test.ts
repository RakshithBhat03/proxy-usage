import assert from 'node:assert/strict';
import net from 'node:net';
import { after, describe, it } from 'node:test';
import {
  RespAuthError,
  RespConnection,
  RespError,
  RespParser,
  RespProtocolError,
  RespUnsupportedError,
  encodeCommand,
  type RespMessage,
} from './resp.ts';

const enc = (s: string) => Buffer.from(s, 'utf8');

describe('RespParser', () => {
  it('parses simple strings, errors, integers, null bulk and nested arrays', () => {
    const parser = new RespParser();
    const values = parser.push(enc('+OK\r\n-ERR bad\r\n:42\r\n$-1\r\n*2\r\n*1\r\n:1\r\n$3\r\nabc\r\n*-1\r\n_\r\n'));
    assert.equal(values.length, 7);
    assert.equal(values[0], 'OK');
    assert.ok(values[1] instanceof RespError);
    assert.equal((values[1] as RespError).message, 'ERR bad');
    assert.equal(values[2], 42);
    assert.equal(values[3], null);
    assert.deepEqual(values[4], [[1], 'abc']);
    assert.equal(values[5], null);
    assert.equal(values[6], null);
    assert.equal(parser.pending, 0);
  });

  it('reassembles a message frame split at every byte', () => {
    const payload = JSON.stringify({ model: 'test-model', note: 'ünïcödé ✓', tokens: { input_tokens: 5 } });
    const frame = enc(`*3\r\n$7\r\nmessage\r\n$5\r\nusage\r\n$${Buffer.byteLength(payload)}\r\n${payload}\r\n`);
    const parser = new RespParser();
    const out = [];
    for (let i = 0; i < frame.length; i++) out.push(...parser.push(frame.subarray(i, i + 1)));
    assert.deepEqual(out, [['message', 'usage', payload]]);
    assert.equal(parser.pending, 0);
  });

  it('handles several frames in one chunk plus a trailing partial frame', () => {
    const parser = new RespParser();
    const first = parser.push(enc('*3\r\n$7\r\nmessage\r\n$5\r\nusage\r\n$2\r\n{}\r\n*2\r\n$4\r\npong\r\n$0\r\n\r\n*3\r\n$7\r\nmes'));
    assert.deepEqual(first, [['message', 'usage', '{}'], ['pong', '']]);
    const rest = parser.push(enc('sage\r\n$5\r\nusage\r\n$4\r\n{"a"\r\n'));
    assert.deepEqual(rest, [['message', 'usage', '{"a"']]);
  });

  it('waits for large bulk strings split across chunks', () => {
    const big = 'x'.repeat(100_000);
    const frame = enc(`$${big.length}\r\n${big}\r\n`);
    const parser = new RespParser();
    assert.deepEqual(parser.push(frame.subarray(0, 10)), []);
    assert.deepEqual(parser.push(frame.subarray(10, 50_000)), []);
    assert.deepEqual(parser.push(frame.subarray(50_000)), [big]);
  });

  it('rejects malformed data', () => {
    assert.throws(() => new RespParser().push(enc('!oops\r\n')), RespProtocolError);
    assert.throws(() => new RespParser().push(enc('$abc\r\n')), RespProtocolError);
    assert.throws(() => new RespParser().push(enc('$3\r\nabcXY')), RespProtocolError);
  });

  it('encodes commands as bulk-string arrays', () => {
    assert.equal(encodeCommand(['SUBSCRIBE', 'usage']).toString(), '*2\r\n$9\r\nSUBSCRIBE\r\n$5\r\nusage\r\n');
    assert.equal(encodeCommand(['AUTH', 'ké']).toString(), '*2\r\n$4\r\nAUTH\r\n$3\r\nké\r\n');
  });
});

/** Tiny fake RESP server: replies according to `handler` for each parsed command. */
function fakeServer(handler: (args: string[], socket: net.Socket) => void): Promise<{ url: string; server: net.Server }> {
  const server = net.createServer((socket) => {
    const parser = new RespParser();
    socket.on('data', (chunk: Buffer) => {
      for (const value of parser.push(chunk)) if (Array.isArray(value)) handler(value.map(String), socket);
    });
    socket.on('error', () => {});
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      resolve({ url: `http://127.0.0.1:${port}`, server });
    });
  });
}

describe('RespConnection', () => {
  const servers: net.Server[] = [];
  after(() => {
    for (const s of servers) s.close();
  });

  it('authenticates, subscribes and delivers split messages; pongs are ignored', async () => {
    const seen: string[][] = [];
    const { url, server } = await fakeServer((args, socket) => {
      seen.push(args);
      if (args[0] === 'AUTH') socket.write('+OK\r\n');
      if (args[0] === 'SUBSCRIBE') {
        socket.write('*3\r\n$9\r\nsubscribe\r\n$5\r\nusage\r\n:1\r\n');
        const frame = '*3\r\n$7\r\nmessage\r\n$5\r\nusage\r\n$11\r\n{"model":1}\r\n';
        socket.write(frame.slice(0, 13));
        setTimeout(() => socket.write(frame.slice(13)), 10);
      }
      // Reply after the split frame above is complete (never interleave inside a frame).
      if (args[0] === 'PING') setTimeout(() => socket.write('*2\r\n$4\r\npong\r\n$0\r\n\r\n'), 30);
    });
    servers.push(server);
    const conn = await RespConnection.connect({ url });
    const messages: RespMessage[] = [];
    conn.onMessage = (m) => messages.push(m);
    await conn.auth('test-key');
    await conn.subscribe('usage');
    conn.ping();
    await new Promise((r) => setTimeout(r, 60));
    assert.deepEqual(messages, [{ channel: 'usage', payload: '{"model":1}' }]);
    assert.deepEqual(seen.map((a) => a[0]), ['AUTH', 'SUBSCRIBE', 'PING']);
    conn.close();
    const reason = await conn.closed();
    assert.match(String(reason?.message), /closed by client/);
  });

  it('maps AUTH errors and unsupported SUBSCRIBE', async () => {
    const { url, server } = await fakeServer((args, socket) => {
      if (args[0] === 'AUTH' && args[1] === 'wrong') socket.write('-ERR invalid management key\r\n');
      else if (args[0] === 'AUTH') socket.write('+OK\r\n');
      if (args[0] === 'SUBSCRIBE') socket.write("-ERR unknown command 'SUBSCRIBE'\r\n");
    });
    servers.push(server);
    const bad = await RespConnection.connect({ url });
    await assert.rejects(bad.auth('wrong'), RespAuthError);
    bad.close();
    const good = await RespConnection.connect({ url });
    await good.auth('right');
    await assert.rejects(good.subscribe('usage'), RespUnsupportedError);
    good.close();
  });

  it('rejects pending commands when the server hangs up', async () => {
    const { url, server } = await fakeServer((_args, socket) => socket.destroy());
    servers.push(server);
    const conn = await RespConnection.connect({ url });
    await assert.rejects(conn.auth('x'));
    assert.ok(conn.isClosed);
  });
});
