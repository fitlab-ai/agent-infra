import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDeliverySummaryContent, renderDeliverySummaryContent, parseCancelSummaryContent, renderCancelSummaryContent } from '../../../lib/platform/issue-summary-content.ts';

test('delivery summary renders not-run verification and empty artifact collections', () => {
  const value = { taskId: 'TASK-20261022-170111', title: 'Delivery', summary: 'Completed work.', artifacts: [], verification: { state: 'not-run', detail: 'Final verification has not run.' } };
  assert.deepEqual(parseDeliverySummaryContent(value), value);
  const rendered = renderDeliverySummaryContent(value);
  assert.match(rendered, /not-run/);
  assert.match(rendered, /- 无/);
});

test('cancel summary preserves a null last artifact', () => {
  const value = { taskId: 'TASK-20261022-170111', title: 'Cancelled', outcome: 'cancelled' as const, reason: 'No longer needed.', cancelledAt: '2026-10-22T00:00:00.000Z', lastCompletedArtifact: null };
  assert.deepEqual(parseCancelSummaryContent(value), value);
  assert.match(renderCancelSummaryContent(value), /最近完成产物：无/);
});
