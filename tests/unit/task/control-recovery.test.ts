import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifySandboxControlRecovery,
  digestControlRecoveryIntent,
  findSandboxControlRecoveryOperation,
  operationRecoveryBinding,
  SANDBOX_CONTROL_RECOVERY_OPERATIONS
} from '../../../lib/task/control-recovery.ts';

test('recovery registry covers lifecycle, finalization, route split, and orchestration intents', () => {
  assert.equal(findSandboxControlRecoveryOperation('task-lifecycle', 'complete')?.mutatesDomain, true);
  assert.equal(findSandboxControlRecoveryOperation('task-finalization', 'complete')?.class, 'finalization');
  assert.equal(findSandboxControlRecoveryOperation('task-orchestration', 'route.read')?.mutatesDomain, false);
  assert.equal(findSandboxControlRecoveryOperation('task-orchestration', 'route.clean-completion')?.mutatesDomain, true);
  assert.equal(digestControlRecoveryIntent('task-lifecycle', 'complete').length, 64);
});

test('recovery keeps started requests without a terminal result unknown and never reconstructs success', () => {
  const binding = operationRecoveryBinding('a'.repeat(32), 'generation-1', 'TASK-20260904-002407', 'task-lifecycle', 'complete');
  const operation = findSandboxControlRecoveryOperation('task-lifecycle', 'complete')!;
  const decision = classifySandboxControlRecovery({ operation, binding, startedCommitted: true });
  assert.deepEqual(decision, {
    outcome: 'unknown', responseReconstructable: false, reasonCode: 'RECOVERY_TERMINAL_RESULT_MISSING'
  });
});

test('route clean-completion requires the completed run and reviewed-head evidence', () => {
  const binding = operationRecoveryBinding('b'.repeat(32), 'generation-2', 'TASK-20260904-002407', 'task-orchestration', 'route.clean-completion');
  const operation = findSandboxControlRecoveryOperation('task-orchestration', 'route.clean-completion')!;
  const result = { requestId: binding.requestId, generation: binding.generation, taskId: binding.taskId, intentDigest: binding.intentDigest, status: 'completed', changed: true };
  const completeDomain = {
    consistent: true, status: 'completed', pendingDelegation: null,
    completionEvidence: {
      kind: 'reviewed-head-clean', observedAt: '2026-09-07T00:00:00.000Z', head: 'head', headTree: 'tree',
      worktreeTree: 'tree', lastReviewedCommit: 'head'
    },
    snapshot: { head: 'head', headTree: 'tree', worktreeTree: 'tree' },
    lastReviewedCommit: 'head'
  };
  assert.equal(classifySandboxControlRecovery({
    operation, binding, startedCommitted: true, terminalResult: result, domain: completeDomain
  }).outcome, 'success');
  assert.equal(classifySandboxControlRecovery({
    operation, binding, startedCommitted: true, terminalResult: result,
    domain: { consistent: false, status: 'completed', pendingDelegation: null }
  }).outcome, 'unknown');
  assert.equal(classifySandboxControlRecovery({
    operation, binding, startedCommitted: true, terminalResult: result,
    domain: {
      consistent: true, status: 'completed', pendingDelegation: null,
      completionEvidence: completeDomain.completionEvidence,
      snapshot: { head: 'other', headTree: 'tree', worktreeTree: 'tree' },
      lastReviewedCommit: 'head'
    }
  }).outcome, 'unknown');
});

test('every registered mutation requires a matching domain contract', () => {
  for (const operation of SANDBOX_CONTROL_RECOVERY_OPERATIONS.filter((candidate) => (
    candidate.mutatesDomain && candidate.class !== 'route.clean-completion'
  ))) {
    const binding = operationRecoveryBinding(
      `${operation.family}-${operation.intent}`.padEnd(32, 'x').slice(0, 32),
      'generation', 'TASK-20260904-002407', operation.family, operation.intent
    );
    const result = {
      requestId: binding.requestId, generation: binding.generation, taskId: binding.taskId,
      intentDigest: binding.intentDigest, status: 'completed', changed: true
    };
    assert.equal(classifySandboxControlRecovery({
      operation, binding, startedCommitted: true, terminalResult: result, domain: { consistent: true }
    }).outcome, 'success', operation.intent);
    assert.equal(classifySandboxControlRecovery({
      operation, binding, startedCommitted: true, terminalResult: result
    }).outcome, 'unknown', `${operation.family}:${operation.intent} missing domain`);
  }
});

test('recovery matrix distinguishes explicit failure, journal partial state, and read-only changes', () => {
  const lifecycle = findSandboxControlRecoveryOperation('task-lifecycle', 'complete')!;
  const lifecycleBinding = operationRecoveryBinding('c'.repeat(32), 'generation-3', 'TASK-20260904-002407', lifecycle.family, lifecycle.intent);
  const failed = { requestId: lifecycleBinding.requestId, generation: lifecycleBinding.generation, taskId: lifecycleBinding.taskId, intentDigest: lifecycleBinding.intentDigest, status: 'failed', changed: true };
  assert.equal(classifySandboxControlRecovery({
    operation: lifecycle, binding: lifecycleBinding, startedCommitted: true, terminalResult: failed,
    domain: { consistent: false }
  }).outcome, 'failure');
  const applied = { ...failed, status: 'applied' };
  assert.equal(classifySandboxControlRecovery({
    operation: lifecycle, binding: lifecycleBinding, startedCommitted: true, terminalResult: applied,
    domain: { consistent: true }, journal: { exists: true, completedSteps: ['task-written'], failure: null }
  }).outcome, 'in-progress');

  for (const intent of ['route.read', 'status'] as const) {
    const operation = findSandboxControlRecoveryOperation('task-orchestration', intent)!;
    const binding = operationRecoveryBinding(`read-${intent}`, 'generation-4', 'TASK-20260904-002407', operation.family, intent);
    const result = { requestId: binding.requestId, generation: binding.generation, taskId: binding.taskId, intentDigest: binding.intentDigest, status: 'running', changed: false };
    assert.equal(classifySandboxControlRecovery({
      operation, binding, startedCommitted: true, terminalResult: result,
      domain: { consistent: true, snapshotValid: true }
    }).outcome, 'success', intent);
    assert.equal(classifySandboxControlRecovery({
      operation, binding, startedCommitted: true, terminalResult: { ...result, changed: true },
      domain: { consistent: true, snapshotValid: true }
    }).outcome, 'unknown', `${intent} changed unexpectedly`);
  }
});

test('recovery rejects durable terminal results with conflicting bindings', () => {
  const operation = findSandboxControlRecoveryOperation('task-orchestration', 'advance')!;
  const binding = operationRecoveryBinding('d'.repeat(32), 'generation-5', 'TASK-20260904-002407', operation.family, operation.intent);
  assert.equal(classifySandboxControlRecovery({
    operation, binding, startedCommitted: true,
    terminalResult: {
      requestId: binding.requestId, generation: 'other-generation', taskId: binding.taskId,
      intentDigest: binding.intentDigest, status: 'running', changed: true
    },
    domain: { consistent: true }
  }).outcome, 'unknown');
});
