import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
import {
  INTERNAL_CLI_ROUTE_SELECTORS,
  PUBLIC_CLI_ROUTE_SELECTORS
} from '../../../lib/internal/cli-route-inventory.ts';
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

test('public descriptor selectors match the actual command dispatchers', () => {
  assert.deepEqual(
    Object.fromEntries(Object.keys(PUBLIC_CLI_ROUTE_SELECTORS).map((route) => [
      route,
      commands(PUBLIC_OPERATION_DESCRIPTORS, route).map((item) => item.selector).sort()
    ])),
    Object.fromEntries(Object.entries(PUBLIC_CLI_ROUTE_SELECTORS).map(([route, selectors]) => [route, [...selectors].sort()]))
  );
  assert.equal(resolveTaskOperation('public', 'agent-client', ['status'])?.selector, 'status');
  assert.equal(resolveTaskOperation('public', 'agent-client', ['inspect']), null);
  assert.equal(resolveTaskOperation('public', 'sandbox', ['enter']), null);
  assert.equal(resolveTaskOperation('public', 'server', ['__daemon'])?.selector, '__daemon');
  assert.equal(resolveTaskOperation('public', '', [])?.selector, 'help');
  assert.equal(resolveTaskOperation('public', '--version', [])?.selector, 'version');
  assert.equal(resolveTaskOperation('public', '-v', [])?.selector, 'version');
});

test('internal descriptor selectors match the shared dispatcher inventory', () => {
  assert.deepEqual(
    Object.fromEntries(Object.keys(INTERNAL_CLI_ROUTE_SELECTORS).map((route) => [
      route,
      commands(INTERNAL_OPERATION_DESCRIPTORS, route).map((item) => item.selector).sort()
    ])),
    Object.fromEntries(Object.entries(INTERNAL_CLI_ROUTE_SELECTORS).map(([route, selectors]) => [route, [...selectors].sort()]))
  );
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
  const taskEnv = {
    AGENT_INFRA_TASK_ID: staleView.taskId!,
    AGENT_INFRA_CONTROL_TOKEN: 'token',
    AGENT_INFRA_CONTROL_GENERATION: 'generation-1',
    AGENT_INFRA_CONTROL_DIR: '/control',
    AGENT_INFRA_CONTROL_STATUS_DIR: '/status',
    AGENT_INFRA_RUNTIME_DIR: '/runtime'
  };
  assert.throws(
    () => guardTaskOperation('internal', 'git-workflow', ['commit'], {
      env: taskEnv,
      taskView: staleView
    }),
    (error: unknown) => error instanceof Error && error.message.startsWith('SANDBOX_TASK_VIEW_FINALIZED:')
  );
  assert.doesNotThrow(() => guardTaskOperation('internal', 'task-warning', [
    staleView.taskId!, 'list'
  ], {
    env: taskEnv,
    taskView: staleView
  }));
  for (const help of ['help', '-h', '--help']) {
    assert.throws(
      () => guardTaskOperation('internal', 'git-workflow', ['commit', help], { env: taskEnv, taskView: staleView }),
      (error: unknown) => error instanceof Error && error.message.startsWith('SANDBOX_TASK_VIEW_FINALIZED:')
    );
  }
});

test('task-bound guard rejects incomplete markers and cross-task references', () => {
  assert.throws(
    () => guardTaskOperation('internal', 'git-workflow', ['commit'], {
      env: { AGENT_INFRA_TASK_ID: staleView.taskId!, AGENT_INFRA_CONTROL_STATUS_DIR: '/status' },
      taskView: staleView
    }),
    (error: unknown) => error instanceof Error && error.message.startsWith('SANDBOX_TASK_VIEW_MARKER_INVALID:')
  );
  assert.doesNotThrow(() => guardTaskOperation('internal', 'git-workflow', ['commit'], {
    env: {
      AGENT_INFRA_CONTROL_TOKEN: 'token',
      AGENT_INFRA_CONTROL_GENERATION: 'generation-1',
      AGENT_INFRA_CONTROL_DIR: '/control',
      AGENT_INFRA_CONTROL_STATUS_DIR: '/status',
      AGENT_INFRA_RUNTIME_DIR: undefined
    },
    taskView: staleView
  }));
  assert.throws(
    () => guardTaskOperation('internal', 'task-event', [
      'TASK-20990101-010101', 'started'
    ], {
      env: {
        AGENT_INFRA_TASK_ID: staleView.taskId!,
        AGENT_INFRA_CONTROL_TOKEN: 'token',
        AGENT_INFRA_CONTROL_GENERATION: 'generation-1',
        AGENT_INFRA_CONTROL_DIR: '/control',
        AGENT_INFRA_CONTROL_STATUS_DIR: '/status',
        AGENT_INFRA_RUNTIME_DIR: '/runtime'
      },
      taskView: { ...staleView, state: 'current', observedSource: 'active', reasonCode: null }
    }),
    (error: unknown) => error instanceof Error && error.message.startsWith('SANDBOX_TASK_REF_MISMATCH:')
  );
});

test('task-bound git input identity is checked before the commit module can load', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-operation-input-'));
  const inputPath = path.join(root, 'commit.json');
  const taskEnv = {
    AGENT_INFRA_TASK_ID: staleView.taskId!,
    AGENT_INFRA_CONTROL_TOKEN: 'token',
    AGENT_INFRA_CONTROL_GENERATION: 'generation-1',
    AGENT_INFRA_CONTROL_DIR: '/control',
    AGENT_INFRA_CONTROL_STATUS_DIR: '/status',
    AGENT_INFRA_RUNTIME_DIR: '/runtime'
  };
  try {
    fs.writeFileSync(inputPath, JSON.stringify({ taskRef: 'TASK-20990101-010101' }));
    assert.throws(
      () => guardTaskOperation('internal', 'git-workflow', ['commit', '--input', inputPath], { env: taskEnv, taskView: { ...staleView, state: 'current', observedSource: 'active', reasonCode: null } }),
      (error: unknown) => error instanceof Error && error.message.startsWith('SANDBOX_TASK_REF_MISMATCH:')
    );
    fs.writeFileSync(inputPath, JSON.stringify({ taskRef: staleView.taskId }));
    assert.throws(
      () => guardTaskOperation('internal', 'git-workflow', ['commit', '--input', inputPath], { env: taskEnv, taskView: staleView }),
      (error: unknown) => error instanceof Error && error.message.startsWith('SANDBOX_TASK_VIEW_FINALIZED:')
    );
    fs.writeFileSync(inputPath, JSON.stringify({ taskRef: 'feature/other-task' }));
    assert.throws(
      () => guardTaskOperation('internal', 'git-workflow', ['commit', '--input', inputPath], { env: taskEnv, taskView: { ...staleView, state: 'current', observedSource: 'active', reasonCode: null } }),
      (error: unknown) => error instanceof Error && error.message.startsWith('SANDBOX_TASK_REF_INVALID:')
    );
    fs.writeFileSync(inputPath, JSON.stringify({}));
    assert.throws(
      () => guardTaskOperation('internal', 'git-workflow', ['commit', '--input', inputPath], { env: taskEnv, taskView: { ...staleView, state: 'current', observedSource: 'active', reasonCode: null } }),
      (error: unknown) => error instanceof Error && error.message.startsWith('SANDBOX_TASK_REF_INVALID:')
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('host-direct routes remain unchanged without task-bound markers', () => {
  assert.doesNotThrow(() => guardTaskOperation('internal', 'git-workflow', ['commit'], { env: {} }));
  assert.doesNotThrow(() => guardTaskOperation('public', 'decide', ['--task', '11'], { env: {} }));
});
