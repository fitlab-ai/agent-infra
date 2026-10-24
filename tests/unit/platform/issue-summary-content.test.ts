import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDeliverySummaryContent, renderDeliverySummaryContent, parseCancelSummaryContent, renderCancelSummaryContent, prepareAndRenderDeliverySummaryContent, prepareAndRenderCancelSummaryContent } from '../../../lib/platform/issue-summary-content.ts';

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

test('summary preparation repairs missing and malformed fields from current task sources', () => {
  const preparedDelivery = prepareAndRenderDeliverySummaryContent({
    taskId: '', title: '', summary: 'Completed work.', artifacts: 'invalid', verification: { state: '', detail: '' }
  }, {
    taskId: 'TASK-20261022-170111', title: 'Task from task.md', artifacts: ['code.md'],
    verificationFallback: { state: 'not-run', detail: 'Final verification has not run at staging.' }
  });
  assert.deepEqual(preparedDelivery.content, {
    taskId: 'TASK-20261022-170111', title: 'Task from task.md', summary: 'Completed work.', artifacts: ['code.md'],
    verification: { state: 'not-run', detail: 'Final verification has not run at staging.' }
  });
  assert.match(preparedDelivery.rendered, /Task from task\.md/u);
  assert.throws(() => prepareAndRenderDeliverySummaryContent({ ...preparedDelivery.content, taskId: 'TASK-OTHER' }, {
    taskId: 'TASK-20261022-170111', title: 'Task', artifacts: []
  }), /does not match/u);
  const preparedCancel = prepareAndRenderCancelSummaryContent({ taskId: '', title: '', outcome: 'cancelled', reason: '', cancelledAt: '', lastCompletedArtifact: undefined }, {
    taskId: 'TASK-20261022-170111', title: 'Task', reason: 'from task metadata', cancelledAt: '2026-10-22T00:00:00.000Z', lastCompletedArtifact: null
  });
  assert.equal(preparedCancel.content.reason, 'from task metadata');
  assert.equal(preparedCancel.content.lastCompletedArtifact, null);
  assert.match(preparedCancel.rendered, /最近完成产物：无/u);
});

test('delivery structure validates nested verification fields and every artifact entry', () => {
  const valid = { taskId: 'TASK-20261022-170111', title: 'Delivery', summary: 'Completed.', artifacts: ['code.md'], verification: { state: 'not-run', detail: 'Not run yet.' } };
  assert.throws(() => parseDeliverySummaryContent({ ...valid, verification: { state: 'not-run' } }), /verification.detail/u);
  assert.throws(() => parseDeliverySummaryContent({ ...valid, artifacts: ['code.md', ' '] }), /artifacts\[\]/u);
});
