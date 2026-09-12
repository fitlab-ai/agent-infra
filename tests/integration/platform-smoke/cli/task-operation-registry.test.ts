import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import {
  INTERNAL_DISPATCHER_ROUTES,
  INTERNAL_OPERATION_DESCRIPTORS,
  PUBLIC_DISPATCHER_ROUTES,
  PUBLIC_OPERATION_DESCRIPTORS,
  guardTaskOperation,
  resolveSandboxControlTransport,
  SANDBOX_CONTROL_STATUS_MOUNT,
  resolveDelegatedTaskOperation,
  resolveTaskOperation,
  type TaskOperationDescriptor
} from '../../../../lib/internal/task-operation-registry.ts';
import {
  INTERNAL_HANDLER_ROUTE_SELECTORS,
  INTERNAL_CLI_ROUTE_SELECTORS,
  isInternalHandlerRoute,
  PUBLIC_CLI_ROUTE_SELECTORS
} from '../../../../lib/internal/cli-route-inventory.ts';
import type { SandboxTaskView } from '../../../../lib/sandbox/control/task-view.ts';
import { writeSandboxControlIdentitySentinel } from '../../../../lib/sandbox/control/identity-sentinel.ts';
import { onPlatforms } from '../../../helpers.ts';
import { TASK_WORKFLOW_COMMANDS } from '../../../../lib/task/workflow-command.ts';
import { parseArtifactCommand } from '../../../../lib/task/artifact-command.ts';
import { parseReviewCommand } from '../../../../lib/task/review-command.ts';

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

function routeKey(command: string, selector: string): string {
  return `${command}:${selector}`;
}

function routeKeysFromHandlerBranches(): Set<string> {
  const internalDir = path.resolve(process.cwd(), 'lib/internal');
  const marker = /internalHandlerRoute\(\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]/gu;
  const keys = new Set<string>();
  for (const name of fs.readdirSync(internalDir).filter((entry) => entry.endsWith('.ts'))) {
    if (name === 'cli-route-inventory.ts') continue;
    const source = fs.readFileSync(path.join(internalDir, name), 'utf8');
    for (const match of source.matchAll(marker)) keys.add(routeKey(match[1]!, match[2]!));
  }
  // Shared domain commands have no CLI-local branch marker: exercise their parsers.
  for (const [command, selector] of Object.values(TASK_WORKFLOW_COMMANDS)) {
    if (command === 'task-artifact') {
      const args = ['TASK-20260101-000001', selector, '--family', 'plan'];
      if (selector !== 'inspect') args.push('--artifact', 'plan.md');
      if (selector === 'repair' || selector === 'reopen-finalization') args.push('--expected-sha256', 'a'.repeat(64), '--expected-semantic-digest', 'b'.repeat(64));
      keys.add(routeKey(command, parseArtifactCommand(args).operation));
    } else if (command === 'task-review') {
      parseReviewCommand(['TASK-20260101-000001', selector, '--stage', 'analysis', '--artifact', 'review-analysis.md']);
      keys.add(routeKey(command, selector));
    }
  }
  return keys;
}

function routeKeysFromInventory(): Set<string> {
  return new Set(Object.entries(INTERNAL_HANDLER_ROUTE_SELECTORS)
    .flatMap(([command, selectors]) => selectors.map((selector) => routeKey(command, selector))));
}

function routeKeysFromDescriptors(): Set<string> {
  return new Set(INTERNAL_OPERATION_DESCRIPTORS.map((item) => routeKey(item.command, item.selector)));
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

test('actual handler branches and registry descriptors have bidirectional coverage', () => {
  const actual = routeKeysFromHandlerBranches();
  const inventory = routeKeysFromInventory();
  const descriptors = routeKeysFromDescriptors();
  assert.deepEqual([...actual].sort(), [...inventory].sort());
  assert.deepEqual([...actual].sort(), [...descriptors].sort());
  assert.strictEqual(INTERNAL_CLI_ROUTE_SELECTORS, INTERNAL_HANDLER_ROUTE_SELECTORS);
  assert.equal(isInternalHandlerRoute('git-workflow', ['unregistered']), false);

  const removed = [...actual][0]!;
  const simulatedDeletion = new Set([...actual].filter((key) => key !== removed));
  assert.deepEqual([...descriptors].filter((key) => !simulatedDeletion.has(key)), [removed]);

  const [command, selector] = removed.split(':');
  const simulatedRename = new Set([...actual].map((key) => key === removed ? routeKey(command!, `${selector}-renamed`) : key));
  assert.deepEqual([...descriptors].filter((key) => !simulatedRename.has(key)), [removed]);
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
    AGENT_INFRA_CONTROL_ROOT_ID: 'a'.repeat(96),
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
      AGENT_INFRA_CONTROL_ROOT_ID: 'a'.repeat(96),
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
        AGENT_INFRA_CONTROL_ROOT_ID: 'a'.repeat(96),
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
    AGENT_INFRA_CONTROL_ROOT_ID: 'a'.repeat(96),
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

test('mounted sandbox control requires a matching identity sentinel', onPlatforms('linux', 'darwin'), () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-operation-identity-'));
  const statusDir = path.join(root, 'status');
  const generation = 'registry-generation';
  const controlRootId = 'a'.repeat(96);
  fs.mkdirSync(statusDir);
  const baseEnv = {
    AGENT_INFRA_CONTROL_TOKEN: 'token',
    AGENT_INFRA_CONTROL_GENERATION: generation,
    AGENT_INFRA_CONTROL_DIR: path.join(root, 'control'),
    AGENT_INFRA_CONTROL_STATUS_DIR: statusDir,
    AGENT_INFRA_CONTROL_ROOT_ID: controlRootId
  };
  try {
    assert.equal(resolveSandboxControlTransport(baseEnv).kind, 'fail-closed');
    writeSandboxControlIdentitySentinel(statusDir, {
      version: 1, mode: 'branch-only', taskId: null, generation, controlRootId
    });
    assert.deepEqual(resolveSandboxControlTransport(baseEnv), { kind: 'broker-client', reasonCode: null });
    assert.deepEqual(resolveSandboxControlTransport({ ...baseEnv, AGENT_INFRA_CONTROL_ROOT_ID: 'b'.repeat(96) }), {
      kind: 'fail-closed', reasonCode: 'SANDBOX_CONTROL_IDENTITY_ROOT_ID_MISMATCH'
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('fixed status mount fails closed after all control environment variables are cleared', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-operation-fixed-mount-'));
  const statusDir = path.join(root, 'status');
  fs.mkdirSync(statusDir);
  try {
    assert.equal(SANDBOX_CONTROL_STATUS_MOUNT, '/run/agent-infra/control-status');
    assert.deepEqual(resolveSandboxControlTransport({}, { statusMountPath: statusDir }), {
      kind: 'fail-closed', reasonCode: 'SANDBOX_CONTROL_IDENTITY_MISSING'
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('tampered native status probe fails closed instead of selecting direct-host', () => {
  const script = [
    "const realBinding = process.binding;",
    "process.binding = (name) => name === 'fs' ? { internalModuleStat: () => -2 } : realBinding(name);",
    "const { resolveSandboxControlTransport } = await import('./lib/internal/task-operation-registry.ts');",
    "console.log(JSON.stringify(resolveSandboxControlTransport({}, { statusMountPath: '/run/agent-infra/control-status' })));"
  ].join(' ');
  const result = spawnSync(process.execPath, ['--experimental-strip-types', '--eval', script], {
    cwd: path.resolve('.'),
    env: {
      ...process.env,
      AGENT_INFRA_TEST_HOST_CONTROL_ENDPOINT: undefined,
      AGENT_INFRA_TASK_ID: undefined,
      AGENT_INFRA_CONTROL_TOKEN: undefined,
      AGENT_INFRA_CONTROL_GENERATION: undefined,
      AGENT_INFRA_CONTROL_ROOT_ID: undefined,
      AGENT_INFRA_CONTROL_DIR: undefined,
      AGENT_INFRA_CONTROL_STATUS_DIR: undefined,
      AGENT_INFRA_RUNTIME_DIR: undefined,
      AGENT_INFRA_EXECUTOR_MANIFEST: undefined,
      AGENT_INFRA_CONTROL_CONTROLLER_BINDING: undefined
    },
    encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    kind: 'fail-closed', reasonCode: 'SANDBOX_CONTROL_IDENTITY_UNAVAILABLE'
  });
});

test('ordinary environment variables cannot select the production status mount', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-operation-env-mount-'));
  const fakeMount = path.join(root, 'status');
  fs.mkdirSync(fakeMount);
  try {
    const decision = resolveSandboxControlTransport({ AGENT_INFRA_TEST_STATUS_MOUNT: fakeMount });
    assert.notEqual(decision.kind, 'broker-client');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
