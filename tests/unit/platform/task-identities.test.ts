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

test('taskIssueIdentity reads the legacy issue number only in transition builds', () => {
  const previous = process.env.AGENT_INFRA_TRANSITION_BUILD;
  try {
    process.env.AGENT_INFRA_TRANSITION_BUILD = '1';
    assert.deepEqual(taskIssueIdentity({ issue_number: 42 }), { kind: 'number', value: 42 });
  } finally {
    if (previous === undefined) delete process.env.AGENT_INFRA_TRANSITION_BUILD;
    else process.env.AGENT_INFRA_TRANSITION_BUILD = previous;
  }
});

test('taskIssueIdentity ignores the legacy issue number in current-only builds', () => {
  const previous = process.env.AGENT_INFRA_TRANSITION_BUILD;
  try {
    delete process.env.AGENT_INFRA_TRANSITION_BUILD;
    assert.equal(taskIssueIdentity({ issue_number: 42 }), null);
  } finally {
    if (previous === undefined) delete process.env.AGENT_INFRA_TRANSITION_BUILD;
    else process.env.AGENT_INFRA_TRANSITION_BUILD = previous;
  }
});
