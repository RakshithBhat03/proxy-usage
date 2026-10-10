import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http, { type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { createStaticHandler } from './static.ts';

const base = mkdtempSync(path.join(tmpdir(), 'static-test-'));
const servers: Server[] = [];
after(() => {
  servers.forEach((server) => server.close());
  rmSync(base, { recursive: true, force: true });
});

function write(file: string, text: string) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
}

async function serve(dirs: string[]): Promise<string> {
  const handle = createStaticHandler(dirs);
  const server = http.createServer(async (req, res) => {
    if (!(await handle(req, res, new URL(req.url ?? '/', 'http://x')))) res.writeHead(404).end();
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const get = async (url: string) => {
  const res = await fetch(url, { headers: { Accept: 'text/html' } });
  return { status: res.status, text: await res.text() };
};

describe('static handler with a runtime UI dir', () => {
  const ui = path.join(base, 'web');
  const dist = path.join(base, 'dist');
  write(path.join(dist, 'index.html'), 'baked');
  write(path.join(dist, 'assets', 'old.js'), 'old');
  mkdirSync(ui, { recursive: true });

  it('falls back to the baked UI while the UI dir is empty, then switches without a restart', async () => {
    const origin = await serve([ui, dist]);
    assert.equal((await get(`${origin}/status`)).text, 'baked');

    write(path.join(ui, 'assets', 'new.js'), 'new');
    write(path.join(ui, 'index.html'), 'published');
    assert.equal((await get(`${origin}/status`)).text, 'published');
    assert.equal((await get(`${origin}/index.html`)).text, 'published');
    assert.equal((await get(`${origin}/assets/new.js`)).text, 'new');
    // Assets only the baked build has stay reachable for tabs opened before the switch.
    assert.equal((await get(`${origin}/assets/old.js`)).text, 'old');
    assert.equal((await get(`${origin}/assets/missing.js`)).status, 404);
  });

  it('never serves dotfiles such as an in-progress index', async () => {
    write(path.join(ui, '.index.html.tmp'), 'partial');
    const origin = await serve([ui, dist]);
    assert.equal((await get(`${origin}/.index.html.tmp`)).text, 'published');
  });
});
