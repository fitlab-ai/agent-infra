import test from 'node:test';
import assert from 'node:assert/strict';

import { buildPullRequestSummary, reconcileSummaryComment, warningResultForPrimary } from '../../../lib/platform/pr-summary.ts';

test('PR summary envelope owns marker and current HEAD', () => {
  assert.equal(buildPullRequestSummary('TASK-1', 'Summary\n', 'abc123'), [
    '<!-- sync-pr:TASK-1:summary -->',
    '<!-- last-commit: abc123 -->',
    '',
    'Summary',
    ''
  ].join('\n'));
});

test('PR summary warning result preserves the primary lifecycle outcome', () => {
  assert.equal(warningResultForPrimary('pr_created'), 'pr_created_with_warnings');
  assert.equal(warningResultForPrimary('pr_reused'), 'pr_reused_with_warnings');
  assert.equal(warningResultForPrimary('no_op'), 'no_op_with_warnings');
});

test('PR summary reconciliation creates, updates, converges and rejects duplicate markers', () => {
  const desired = buildPullRequestSummary('TASK-1', 'Summary', 'abc');
  assert.deepEqual(reconcileSummaryComment([], 'TASK-1', desired), { action: 'create', commentId: null });
  assert.deepEqual(reconcileSummaryComment([{ id: 2, body: desired }], 'TASK-1', desired), { action: 'no-op', commentId: 2 });
  assert.deepEqual(reconcileSummaryComment([{ id: 2, body: 'old\n<!-- sync-pr:TASK-1:summary -->' }], 'TASK-1', desired), { action: 'update', commentId: 2 });
  assert.equal(reconcileSummaryComment([{ id: 2, body: desired }, { id: 3, body: desired }], 'TASK-1', desired).action, 'conflict');
});
