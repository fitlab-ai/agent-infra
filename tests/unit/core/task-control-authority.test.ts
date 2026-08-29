import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';

import {
  assertTaskControlExecutionContext,
  createDirectHostExecutionContext,
  createSandboxClientTransportEntry,
  createSandboxExecutorExecutionContext,
  parseTaskControlOperation
} from '../../../lib/task/control-authority.ts';

test('direct host context does not require sandbox facts', () => {
  const repoRoot = path.resolve('/repo');
  const context = createDirectHostExecutionContext({ repoRoot });
  assert.deepEqual(context, { source: 'direct-host', mode: 'direct-host', repoRoot });
  assertTaskControlExecutionContext(context);
});

test('sandbox client transport entry remains outside the authority context', () => {
  const entry = createSandboxClientTransportEntry({ args: ['TASK-20260809-010203', 'status'] });
  assert.equal(entry.source, 'sandbox-client');
  assert.equal('mode' in entry, false);
  assert.equal('taskId' in entry, false);
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
