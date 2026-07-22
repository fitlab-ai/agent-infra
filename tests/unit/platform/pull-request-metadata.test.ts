import test from 'node:test';
import assert from 'node:assert/strict';

import { ensureClosingReference, planPullRequestMetadata } from '../../../lib/platform/pull-request-metadata.ts';

const capabilities = { authenticated: true, comment: true, triage: true, push: true, admin: false };

test('PR metadata planner converges labels, assignees and milestone deterministically', () => {
  const planned = planPullRequestMetadata({
    pullRequest: { labels: ['old', 'in: stale'], assignees: [], milestone: null, body: 'Body' },
    issue: { labels: ['type: enhancement', 'in: cli', 'status: in-progress'], assignees: ['codex'], milestone: '0.8.7' },
    taskType: 'refactor',
    issueNumber: 622,
    capabilities
  });
  assert.deepEqual(planned.operations.map(({ name, status, value }) => ({ name, status, value })), [
    { name: 'labels', status: 'planned', value: ['in: cli', 'old', 'type: enhancement'] },
    { name: 'assignees', status: 'planned', value: ['codex'] },
    { name: 'milestone', status: 'planned', value: '0.8.7' },
    { name: 'closing-issue', status: 'planned', value: 'Body\n\nCloses #622' }
  ]);
});

test('PR metadata planner preserves permission-bound state and closing references are idempotent', () => {
  const body = 'Details\n\nFixes #7';
  assert.equal(ensureClosingReference(body, 7), body);
  const planned = planPullRequestMetadata({
    pullRequest: { labels: [], assignees: [], milestone: null, body },
    issue: { labels: ['type: bug'], assignees: [], milestone: '1.0.0' },
    taskType: 'bugfix',
    issueNumber: 7,
    capabilities: { ...capabilities, triage: false }
  });
  assert.deepEqual(planned.operations.map(({ name, status, reasonCode }) => ({ name, status, reasonCode })), [
    { name: 'labels', status: 'skipped', reasonCode: 'TRIAGE_REQUIRED' },
    { name: 'assignees', status: 'no-op', reasonCode: null },
    { name: 'milestone', status: 'skipped', reasonCode: 'TRIAGE_REQUIRED' },
    { name: 'closing-issue', status: 'no-op', reasonCode: null }
  ]);
});
