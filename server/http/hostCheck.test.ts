import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createHostCheck, hostnameOf, viteAllowedHosts } from './hostCheck.ts';

describe('hostnameOf', () => {
  it('strips ports, brackets and trailing dots', () => {
    assert.equal(hostnameOf('Example.COM:8080'), 'example.com');
    assert.equal(hostnameOf('[::1]:18320'), '::1');
    assert.equal(hostnameOf('[fe80::1]'), 'fe80::1');
    assert.equal(hostnameOf('box.local.'), 'box.local');
  });

  it('rejects malformed hosts', () => {
    assert.equal(hostnameOf(''), null);
    assert.equal(hostnameOf('[::1'), null);
    assert.equal(hostnameOf('[::1]x'), null);
    assert.equal(hostnameOf('host:port'), null);
  });
});

describe('createHostCheck', () => {
  const check = createHostCheck(['usage.example.com', '.corp.internal']);

  it('allows loopback names and IP literals', () => {
    for (const host of ['localhost', 'localhost:18320', 'app.localhost', '127.0.0.1:18320', '100.64.1.2', '[::1]:18320', '[fd7a:115c:a1e0::1]']) {
      assert.equal(check(host), true, host);
    }
  });

  it('allows Tailscale, mDNS and configured names', () => {
    for (const host of ['mac.tail1234.ts.net', 'cpa-usage.tail1234.ts.net:443', 'mac-mini.local', 'usage.example.com', 'corp.internal', 'a.b.corp.internal:8080']) {
      assert.equal(check(host), true, host);
    }
  });

  it('rejects everything else', () => {
    for (const host of [undefined, '', 'evil.example', 'example.com', 'ts.net.evil.com', 'nots.net', 'localhost.evil.com', 'usage.example.com.evil']) {
      assert.equal(check(host), false, String(host));
    }
  });

  it('`*` disables the check', () => {
    assert.equal(createHostCheck(['*'])('evil.example'), true);
    assert.equal(viteAllowedHosts(['*']), true);
  });
});
