import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { analyticsModel, analyticsModelForRequest, normalizeServiceTier } from './model-identity.ts';

describe('model identity', () => {
  it('strips only CPA reasoning suffixes', () => {
    assert.equal(analyticsModel('gpt-5(high)'), 'gpt-5');
    assert.equal(analyticsModel('claude-sonnet(8192)'), 'claude-sonnet');
    assert.equal(analyticsModel('model(custom-alias)'), 'model(custom-alias)');
    assert.equal(analyticsModel('(high)'), '(high)');
    assert.equal(analyticsModelForRequest('resolved', 'requested(low)'), 'requested');
    assert.equal(analyticsModelForRequest('model(xhigh)', ''), 'model');
  });

  it('normalizes service tiers', () => {
    assert.equal(normalizeServiceTier(undefined), 'normal');
    assert.equal(normalizeServiceTier(' Standard '), 'normal');
    assert.equal(normalizeServiceTier('priority'), 'fast');
    assert.equal(normalizeServiceTier('Flex'), 'flex');
  });
});
