import test from 'node:test';
import assert from 'node:assert/strict';

import {
  identityFromRemoteValue,
  isResourceIdentity,
  parseResourceIdentity,
  parseResourceToken,
  resourceIdentityEquals,
  reviewMarker,
  serializeResourceIdentity
} from '../../../lib/platform/resource-identity.ts';

test('resource identities accept canonical number, id, and key values only', () => {
  assert.equal(isResourceIdentity({ kind: 'number', value: 42 }), true);
  assert.equal(isResourceIdentity({ kind: 'id', value: 'issue-42' }), true);
  assert.equal(isResourceIdentity({ kind: 'key', value: 'v1.2.3' }), true);
  assert.equal(isResourceIdentity({ kind: 'id', value: ' issue-42' }), false);
  assert.equal(isResourceIdentity({ number: 42 }), false);
  assert.throws(() => parseResourceIdentity({ kind: 'number', value: 0 }), /PLATFORM_IDENTITY_INVALID/);
});

test('provider declarations parse raw tokens without a global identity fallback', () => {
  assert.deepEqual(parseResourceToken('42', 'issue', { issue: 'number' }), { kind: 'number', value: 42 });
  assert.deepEqual(parseResourceToken('42', 'issue', { issue: 'id' }), { kind: 'id', value: '42' });
  assert.deepEqual(parseResourceToken('issue:42', 'issue', { issue: 'id' }), { kind: 'id', value: 'issue:42' });
  assert.throws(() => parseResourceToken('0', 'issue', { issue: 'number' }), /PLATFORM_IDENTITY_INVALID/);
  assert.throws(() => parseResourceToken('42', 'issue', undefined), /PLATFORM_IDENTITY_INVALID/);
  assert.throws(() => identityFromRemoteValue({ kind: 'id', value: '42' }, 'issue', { issue: 'number' }), /PLATFORM_IDENTITY_INVALID/);
});

test('identity equality and review markers are canonical and opaque-safe', () => {
  const opaque = { kind: 'id' as const, value: 'type:42' };
  assert.equal(resourceIdentityEquals(opaque, { kind: 'id', value: 'type:42' }), true);
  assert.equal(resourceIdentityEquals(opaque, { kind: 'number', value: 42 }), false);
  assert.equal(serializeResourceIdentity(opaque), '{"kind":"id","value":"type:42"}');
  assert.equal(reviewMarker({ kind: 'number', value: 42 }), 'pr42');
  assert.match(reviewMarker(opaque), /^pr:[A-Za-z0-9_-]+$/);
});
