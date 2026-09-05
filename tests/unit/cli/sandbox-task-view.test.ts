import assert from 'node:assert/strict';
import test from 'node:test';

import {
  accessSandboxTaskView,
  mergeSandboxTaskView,
  parseSandboxTaskView,
  projectSandboxTaskView,
  taskViewAfterFinalization,
  taskViewFromStatus
} from '../../../lib/sandbox/control/task-view.ts';

const taskId = 'TASK-20260904-002344';
const requestId = '0123456789abcdef0123456789abcdef';
const generation = 'generation-1';
const receipt = {
  version: 2,
  receiptId: 'receipt-1',
  revision: 4,
  lifecycle: 'done',
  controlBinding: { generation, requestId }
};

test('task-view projection distinguishes active current from completed current', () => {
  assert.deepEqual(projectSandboxTaskView({
    mode: 'task-bound', taskId, generation, source: 'active', sourceMatches: true
  }), {
    state: 'current', taskId, observedSource: 'active', receipt: null, reasonCode: null
  });
  const completed = projectSandboxTaskView({
    mode: 'task-bound', taskId, generation, source: 'completed', sourceMatches: true,
    receipt, requestId
  });
  assert.equal(completed.state, 'current');
  assert.equal(completed.observedSource, 'completed');
  assert.equal(completed.receipt?.requestId, requestId);
});

test('receipt-backed historical active source becomes finalized-stale', () => {
  const view = taskViewAfterFinalization({ taskId, generation, requestId, receipt });
  assert.equal(view.state, 'finalized-stale');
  assert.equal(view.observedSource, 'active');
  assert.equal(view.receipt?.revision, 4);
  assert.equal(accessSandboxTaskView(view, 'diagnostic').allowed, true);
  assert.equal(accessSandboxTaskView(view, 'cleanup').allowed, true);
  assert.equal(accessSandboxTaskView(view, 'progress').allowed, false);
});

test('active source with a valid completion receipt remains finalized-stale after broker restart', () => {
  const view = projectSandboxTaskView({
    mode: 'task-bound', taskId, generation, source: 'active', sourceMatches: false,
    receipt, requestId
  });
  assert.equal(view.state, 'finalized-stale');
  assert.equal(accessSandboxTaskView(view, 'progress').allowed, false);
});

test('broker restart preserves stale or unknown evidence unless completed source is revalidated', () => {
  const stale = taskViewAfterFinalization({ taskId, generation, requestId, receipt });
  const active = projectSandboxTaskView({
    mode: 'task-bound', taskId, generation, source: 'active', sourceMatches: true
  });
  assert.equal(mergeSandboxTaskView(active, stale).state, 'finalized-stale');
  assert.equal(mergeSandboxTaskView(active, {
    state: 'unknown', taskId, observedSource: 'unknown', receipt: null,
    reasonCode: 'SANDBOX_TASK_VIEW_STATUS_INVALID'
  }).state, 'unknown');
  const completed = projectSandboxTaskView({
    mode: 'task-bound', taskId, generation, source: 'completed', sourceMatches: true,
    receipt, requestId
  });
  assert.equal(mergeSandboxTaskView(completed, stale).state, 'current');
});

test('receipt and source conflicts fail closed as unknown', () => {
  const view = projectSandboxTaskView({
    mode: 'task-bound', taskId, generation, source: 'unknown', sourceMatches: false,
    receipt: { ...receipt, controlBinding: { generation: 'other', requestId } }, requestId
  });
  assert.equal(view.state, 'unknown');
  assert.equal(accessSandboxTaskView(view, 'terminal-verdict').allowed, false);
});

test('status schema is v3-only and keeps health separate from task view', () => {
  const view = parseSandboxTaskView({
    state: 'finalized-stale', taskId, observedSource: 'active', receipt: {
      receiptId: 'receipt-1', revision: 4, generation, requestId
    }, reasonCode: 'SANDBOX_TASK_VIEW_FINALIZED'
  });
  assert.equal(view.state, 'finalized-stale');
  assert.equal(taskViewFromStatus({ version: 3, generation, taskView: view }).state, 'finalized-stale');
  assert.throws(() => taskViewFromStatus({ version: 2, taskView: view }), /SANDBOX_TASK_VIEW_INVALID/);
  assert.throws(() => taskViewFromStatus({
    version: 3,
    generation: 'other-generation',
    taskView: view
  }), /SANDBOX_TASK_VIEW_INVALID/);
});
