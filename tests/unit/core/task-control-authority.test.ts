import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';

import {
  assertTaskControlExecutionContext,
  createDirectHostExecutionContext,
  createSandboxExecutorExecutionContext,
  parseTaskControlOperation
} from '../../../lib/task/control-authority.ts';

test('direct host context does not require sandbox facts', () => {
  const repoRoot = path.resolve('/repo');
  const context = createDirectHostExecutionContext({ repoRoot });
  assert.deepEqual(context, { source: 'direct-host', mode: 'direct-host', repoRoot });
  assertTaskControlExecutionContext(context);
});

test('sandbox executor context requires the complete manifest binding', () => {
  const context = createSandboxExecutorExecutionContext({
    repoRoot: '/repo',
    worktreeRoot: '/repo',
    runtimeDir: '/control/runtime',
    taskId: 'TASK-20260809-010203',
    generation: 'generation',
    manifestPath: '/control/manifest.json',
    requestId: 'request-id'
  });
  assert.equal(context.source, 'sandbox-executor');
  assert.throws(
    () => createSandboxExecutorExecutionContext({
      ...context,
      taskId: 'TASK-20260809-010204',
      runtimeDir: '/other/runtime'
    }),
    /TASK_CONTROL_CONTEXT_INVALID/
  );
});

test('authority parser preserves auto hook matching as an operation input', () => {
  const operation = parseTaskControlOperation('task-orchestration', [
    'auto', 'hook-start', '--client', 'claude-code', '--native-agent', 'claude', '--child-id', 'child', '--parent-id', 'parent'
  ]);
  assert.equal(operation.family, 'task-orchestration');
  if (operation.family !== 'task-orchestration') throw new Error('unexpected operation family');
  assert.equal(operation.taskRef, 'auto');
  assert.equal(operation.input.auto, true);
});

test('authority parser owns lifecycle and finalization command shapes', () => {
  const lifecycle = parseTaskControlOperation('task-lifecycle', [
    'TASK-20260809-010203', 'cancel', '--agent', 'codex', '--reason', 'obsolete'
  ]);
  assert.equal(lifecycle.family, 'task-lifecycle');
  if (lifecycle.family !== 'task-lifecycle') throw new Error('unexpected lifecycle operation family');
  assert.deepEqual(lifecycle.request, {
    taskRef: 'TASK-20260809-010203', intent: 'cancel', agent: 'codex', reason: 'obsolete'
  });

  const finalization = parseTaskControlOperation('task-finalization', [
    'TASK-20260809-010203', 'complete', '--agent', 'codex'
  ]);
  assert.equal(finalization.family, 'task-finalization');
  if (finalization.family !== 'task-finalization') throw new Error('unexpected finalization operation family');
  assert.deepEqual(finalization.request, {
    taskRef: 'TASK-20260809-010203', intent: 'complete', agent: 'codex'
  });

  assert.throws(
    () => parseTaskControlOperation('task-lifecycle', [
      'TASK-20260809-010203', 'cancel', '--agent', 'codex', '--unknown', 'value'
    ]),
    /TASK_CONTROL_OPERATION_INVALID: unknown option '--unknown'/
  );
});

test('authority parser accepts only automatic recovery', () => {
  const automatic = parseTaskControlOperation('task-lifecycle', [
    'TASK-20260809-010203', 'recover-started', '--agent', 'codex', '--auto'
  ]);
  assert.equal(automatic.family, 'task-lifecycle');
  if (automatic.family !== 'task-lifecycle') throw new Error('unexpected lifecycle operation family');
  assert.deepEqual(automatic.request, {
    taskRef: 'TASK-20260809-010203', intent: 'recover-started', agent: 'codex', auto: true
  });
  assert.throws(
    () => parseTaskControlOperation('task-lifecycle', [
      'TASK-20260809-010203', 'recover-started', '--agent', 'codex', '--auto',
      '--stage', 'code', '--round', '1', '--artifact', 'code.md', '--reason', 'mixed mode'
    ]),
    /unknown option '--stage'/u
  );
  assert.throws(
    () => parseTaskControlOperation('task-lifecycle', [
      'TASK-20260809-010203', 'recover-started', '--agent', 'codex'
    ]),
    /--auto is required/u
  );
  assert.throws(
    () => parseTaskControlOperation('task-lifecycle', [
      'TASK-20260809-010203', 'cancel', '--agent', 'codex', '--reason', 'obsolete', '--auto'
    ]),
    /only supported for recover-started/u
  );
});
