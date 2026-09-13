import test from 'node:test';
import assert from 'node:assert/strict';

import { taskIssueIdentity } from '../../../lib/platform/task-identities.ts';

test('taskIssueIdentity reads a canonical opaque identity', () => {
  assert.deepEqual(taskIssueIdentity({
    platform_issue_identity: '{"kind":"id","value":"opaque-42"}'
  }), { kind: 'id', value: 'opaque-42' });
});

test('taskIssueIdentity reads a canonical numeric identity', () => {
  assert.deepEqual(taskIssueIdentity({
    platform_issue_identity: '{"kind":"number","value":42}'
  }), { kind: 'number', value: 42 });
});

test('taskIssueIdentity returns no identity for unbound task metadata', () => {
  assert.equal(taskIssueIdentity({}), null);
});

test('taskIssueIdentity returns no identity for malformed canonical metadata', () => {
  assert.equal(taskIssueIdentity({ platform_issue_identity: '{"kind":"number","value":0}' }), null);
});
