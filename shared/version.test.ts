import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { compareVersions, parseVersion, versionTag } from './version.ts';

describe('compareVersions', () => {
  it('orders numeric parts, ignoring a leading v', () => {
    assert.equal(compareVersions('8.0.23', 'v8.0.23'), 0);
    assert.equal(compareVersions('8.0.23', 'v8.0.24'), -1);
    assert.equal(compareVersions('v6.10.8', '6.9.30'), 1);
    assert.equal(compareVersions('8.1', '8.0.99'), 1);
    assert.equal(compareVersions('8.0', '8.0.0'), 0);
  });

  it('sorts a pre-release before its release', () => {
    assert.equal(compareVersions('8.1.0-rc1', '8.1.0'), -1);
    assert.equal(compareVersions('8.1.0', '8.1.0-rc2'), 1);
    assert.equal(compareVersions('8.1.0-rc2', '8.1.0-rc10'), -1);
  });

  it('ignores build metadata', () => {
    assert.equal(compareVersions('8.0.23+abc', '8.0.23'), 0);
  });

  it('returns null for unparseable input', () => {
    assert.equal(compareVersions('dev', '8.0.23'), null);
    assert.equal(compareVersions(null, '8.0.23'), null);
    assert.equal(parseVersion(''), null);
  });
});

describe('versionTag', () => {
  it('adds a v to bare numbers only', () => {
    assert.equal(versionTag('8.0.23'), 'v8.0.23');
    assert.equal(versionTag('v8.0.23'), 'v8.0.23');
    assert.equal(versionTag('dev'), 'dev');
  });
});
