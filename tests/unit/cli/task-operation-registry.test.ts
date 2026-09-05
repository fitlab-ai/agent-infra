import assert from 'node:assert/strict';
import test from 'node:test';

import {
  INTERNAL_DISPATCHER_ROUTES,
  INTERNAL_OPERATION_DESCRIPTORS,
  PUBLIC_DISPATCHER_ROUTES,
  PUBLIC_OPERATION_DESCRIPTORS,
  guardTaskOperation,
  resolveDelegatedTaskOperation,
  resolveTaskOperation,
  type TaskOperationDescriptor
} from '../../../lib/internal/task-operation-registry.ts';
import type { SandboxTaskView } from '../../../lib/sandbox/control/task-view.ts';

const staleView: SandboxTaskView = {
  state: 'finalized-stale',
  taskId: 'TASK-20260904-002344',
  observedSource: 'active',
  receipt: {
    receiptId: 'receipt-1', revision: 3, generation: 'generation-1',
    requestId: '0123456789abcdef0123456789abcdef'
  },
  reasonCode: 'SANDBOX_TASK_VIEW_FINALIZED'
};

function commands(descriptors: readonly TaskOperationDescriptor[], command: string): TaskOperationDescriptor[] {
  return descriptors.filter((item) => item.command === command);
}

test('dispatcher route inventories have explicit descriptors in both directions', () => {
  for (const [routes, descriptors] of [
    [INTERNAL_DISPATCHER_ROUTES, INTERNAL_OPERATION_DESCRIPTORS],
    [PUBLIC_DISPATCHER_ROUTES, PUBLIC_OPERATION_DESCRIPTORS]
  ] as const) {
    for (const route of routes) assert.ok(commands(descriptors, route).length > 0, `missing descriptor for ${route}`);
    for (const command of new Set(descriptors.map((item) => item.command))) {
      assert.ok((routes as readonly string[]).includes(command), `descriptor has no dispatcher route: ${command}`);
    }
  }
  const keys = new Set<string>();
  for (const item of [...INTERNAL_OPERATION_DESCRIPTORS, ...PUBLIC_OPERATION_DESCRIPTORS]) {
    const key = `${item.dispatcher}:${item.command}:${item.selector}`;
    assert.equal(keys.has(key), false, `duplicate descriptor ${key}`);
    keys.add(key);
    assert.equal(item.guardBeforeImport, true);
  }
});

test('non-prefix task mutation routes resolve to task-bound descriptors', () => {
  assert.equal(resolveTaskOperation('internal', 'task-short-id', ['resolve'])?.effect, 'progress');
  assert.equal(resolveTaskOperation('internal', 'git-workflow', ['commit'])?.effect, 'progress');
  assert.equal(resolveTaskOperation('internal', 'platform-comment', ['sync', 'TASK-20260904-002344'])?.effect, 'remote-write');
  assert.equal(resolveTaskOperation('internal', 'platform-pr-review', [
    'publish', '--scope', 'TASK-20260904-002344'
  ])?.selector, 'publish-task');
  assert.equal(resolveTaskOperation('internal', 'platform-pr-review', [
    'publish', '--scope', 'pr123'
  ])?.selector, 'publish-pr');
  assert.equal(resolveTaskOperation('internal', 'task-validate', [
    'feature', '--scope', 'inplace', '--', 'true'
  ])?.effect, 'progress');
  assert.equal(resolveTaskOperation('public', 'decide', ['--task', '11'])?.scope, 'task-bound');
  assert.equal(resolveTaskOperation('public', 'task', ['d', '--task', '11'])?.selector, 'decisions');
});

test('delegated control selectors reuse the same internal descriptors', () => {
  assert.equal(resolveDelegatedTaskOperation(['client', 'task-lifecycle', 'TASK-20260904-002344', 'complete'])?.command, 'task-lifecycle');
  assert.equal(resolveDelegatedTaskOperation(['client', 'task-orchestration', 'TASK-20260904-002344', 'status'])?.effect, 'diagnostic');
});

test('task-view guard refuses stale progress before a route can import its module', () => {
  assert.throws(
    () => guardTaskOperation('internal', 'git-workflow', ['commit'], {
      env: {
        AGENT_INFRA_TASK_ID: staleView.taskId!,
        AGENT_INFRA_CONTROL_STATUS_DIR: '/unused'
      },
      taskView: staleView
    }),
    (error: unknown) => error instanceof Error && error.message.startsWith('SANDBOX_TASK_VIEW_FINALIZED:')
  );
  assert.doesNotThrow(() => guardTaskOperation('internal', 'task-warning', [
    staleView.taskId!, 'list'
  ], {
    env: {
      AGENT_INFRA_TASK_ID: staleView.taskId!,
      AGENT_INFRA_CONTROL_STATUS_DIR: '/unused'
    },
    taskView: staleView
  }));
});

test('host-direct routes remain unchanged without task-bound markers', () => {
  assert.doesNotThrow(() => guardTaskOperation('internal', 'git-workflow', ['commit'], { env: {} }));
  assert.doesNotThrow(() => guardTaskOperation('public', 'decide', ['--task', '11'], { env: {} }));
});
