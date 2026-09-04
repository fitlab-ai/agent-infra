import test from 'node:test';
import assert from 'node:assert/strict';

import { taskIssueIdentity } from '../../../lib/platform/task-identities.ts';

test('taskIssueIdentity reads the legacy numeric field during the compatibility window', () => {
  assert.deepEqual(taskIssueIdentity({ issue_number: '42' }), { kind: 'number', value: 42 });
});

test('taskIssueIdentity rejects the legacy numeric field after the stable cutoff', () => {
  assert.throws(
    () => taskIssueIdentity({ issue_number: 42 }, undefined, 'v1.0.0'),
    (error: unknown) => error instanceof Error
      && 'code' in error
      && error.code === 'PLATFORM_IDENTITY_LEGACY_UNSUPPORTED'
      && error.message.includes('current schema')
  );
});

test('taskIssueIdentity prefers current identity over the legacy field after the cutoff', () => {
  assert.deepEqual(taskIssueIdentity({
    issue_number: 42,
    platform_issue_identity: '{"kind":"id","value":"opaque-42"}'
  }, undefined, 'v1.0.0'), { kind: 'id', value: 'opaque-42' });
});
