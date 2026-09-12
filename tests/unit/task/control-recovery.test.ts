import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifySandboxControlRecovery,
  digestControlRecoveryIntent,
  findSandboxControlRecoveryOperation,
  operationRecoveryBinding,
  SANDBOX_CONTROL_RECOVERY_OPERATIONS,
  SANDBOX_CONTROL_REQUIRED_COMPLETION_PHASES
} from '../../../lib/task/control-recovery.ts';

const criticalPhases = [...SANDBOX_CONTROL_REQUIRED_COMPLETION_PHASES];

test('recovery registry covers lifecycle, finalization, route split, and orchestration intents', () => {
  assert.equal(findSandboxControlRecoveryOperation('task-lifecycle', 'complete')?.class, 'lifecycle-mutation');
  assert.equal(findSandboxControlRecoveryOperation('task-finalization', 'complete')?.class, 'finalization');
  assert.equal(findSandboxControlRecoveryOperation('task-orchestration', 'route.read')?.class, 'read-only');
  assert.equal(findSandboxControlRecoveryOperation('task-orchestration', 'route.clean-completion')?.class, 'route.clean-completion');
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
      worktreeTree: 'tree', lastReviewedCommit: 'head', prNumber: null, prHead: null
    },
    snapshot: { head: 'head', headTree: 'tree', worktreeTree: 'tree' },
    lastReviewedCommit: 'head'
  };
  assert.equal(classifySandboxControlRecovery({
    operation, binding, startedCommitted: true, terminalResult: result, domain: completeDomain, criticalPhases
  }).outcome, 'success');
  assert.equal(classifySandboxControlRecovery({
    operation, binding, startedCommitted: true, terminalResult: result,
    domain: { consistent: false, status: 'completed', pendingDelegation: null }, criticalPhases
  }).outcome, 'unknown');
  assert.equal(classifySandboxControlRecovery({
    operation, binding, startedCommitted: true, terminalResult: result,
    domain: {
      consistent: true, status: 'completed', pendingDelegation: null,
      completionEvidence: completeDomain.completionEvidence,
      snapshot: { head: 'other', headTree: 'tree', worktreeTree: 'tree' },
      lastReviewedCommit: 'head'
    }, criticalPhases
  }).outcome, 'unknown');
});

test('every registered mutation requires a matching domain contract', () => {
  for (const operation of SANDBOX_CONTROL_RECOVERY_OPERATIONS.filter((candidate) => (
    candidate.class !== 'read-only' && candidate.class !== 'route.clean-completion'
  ))) {
    const binding = operationRecoveryBinding(
      `${operation.family}-${operation.intent}`.padEnd(32, 'x').slice(0, 32),
      'generation', 'TASK-20260904-002407', operation.family, operation.intent
    );
    const result = {
      requestId: binding.requestId, generation: binding.generation, taskId: binding.taskId,
      intentDigest: binding.intentDigest, status: operation.intent === 'recover-started' ? 'applied' : 'completed',
      changed: true,
      ...(operation.intent === 'recover-started' ? { targetState: 'active' } : {})
    };
    const domain = operation.intent === 'recover-started'
      ? { consistent: true, recovery: true, targetState: 'active', recoveryState: 'released' }
      : { consistent: true };
    assert.equal(classifySandboxControlRecovery({
      operation,
      binding,
      startedCommitted: true,
      terminalResult: result,
      domain,
      criticalPhases,
    }).outcome, 'success', operation.intent);
    assert.equal(classifySandboxControlRecovery({
      operation, binding, startedCommitted: true, terminalResult: result
    }).outcome, 'unknown', `${operation.family}:${operation.intent} missing domain`);
  }
});

test('recover-started response-loss recovery requires durable target and domain evidence', () => {
  const operation = findSandboxControlRecoveryOperation('task-lifecycle', 'recover-started')!;
  const binding = operationRecoveryBinding('f'.repeat(32), 'generation-7', 'TASK-20260904-002407', operation.family, operation.intent);
  const result = {
    requestId: binding.requestId, generation: binding.generation, taskId: binding.taskId,
    intentDigest: binding.intentDigest, status: 'applied', changed: true, targetState: 'active'
  };
  const valid = { consistent: true, recovery: true, targetState: 'active', recoveryState: 'released' };
  assert.equal(classifySandboxControlRecovery({ operation, binding, startedCommitted: true, terminalResult: result, domain: valid, criticalPhases }).outcome, 'success');
  assert.equal(classifySandboxControlRecovery({ operation, binding, startedCommitted: true, terminalResult: result, domain: { consistent: true }, criticalPhases }).outcome, 'unknown');
  assert.equal(classifySandboxControlRecovery({ operation, binding, startedCommitted: true, terminalResult: { ...result, targetState: null }, domain: valid, criticalPhases }).outcome, 'unknown');
  assert.equal(classifySandboxControlRecovery({ operation, binding, startedCommitted: true, terminalResult: { ...result, status: 'no-op', changed: false }, domain: valid, criticalPhases }).outcome, 'success');
});

test('recover-started response-loss recovery preserves a release retry warning', () => {
  const operation = findSandboxControlRecoveryOperation('task-lifecycle', 'recover-started')!;
  const binding = operationRecoveryBinding('g'.repeat(32), 'generation-8', 'TASK-20260904-002407', operation.family, operation.intent);
  const warning = {
    code: 'RECOVERY_RELEASE_RETRY_REQUIRED',
    message: 'protected claim could not be released',
    action: 'retry recover-started'
  };
  const result = {
    requestId: binding.requestId, generation: binding.generation, taskId: binding.taskId,
    intentDigest: binding.intentDigest, status: 'applied', changed: true, targetState: 'active', warning
  };
  const domain = {
    consistent: true, recovery: true, targetState: 'active', recoveryState: 'retry-required', warning
  };
  const decision = classifySandboxControlRecovery({
    operation, binding, startedCommitted: true, terminalResult: result, domain, criticalPhases
  });
  assert.deepEqual(decision, {
    outcome: 'success', responseReconstructable: true, reasonCode: 'RECOVERY_RELEASE_RETRY_REQUIRED'
  });
  assert.equal(classifySandboxControlRecovery({
    operation, binding, startedCommitted: true, terminalResult: { ...result, warning: undefined },
    domain, criticalPhases
  }).outcome, 'unknown');
  assert.equal(classifySandboxControlRecovery({
    operation,
    binding,
    startedCommitted: true,
    terminalResult: { ...result, changed: false },
    domain,
    criticalPhases
  }).reasonCode, 'RECOVERY_RELEASE_RETRY_REQUIRED');
  assert.equal(classifySandboxControlRecovery({
    operation,
    binding,
    startedCommitted: true,
    terminalResult: { ...result, warning: { action: warning.action, message: warning.message, code: warning.code } },
    domain,
    criticalPhases
  }).outcome, 'success');
  assert.equal(classifySandboxControlRecovery({
    operation,
    binding,
    startedCommitted: true,
    terminalResult: { ...result, warning: { ...warning, extra: 'unexpected' } },
    domain,
    criticalPhases
  }).outcome, 'unknown');
});

test('recovery matrix distinguishes explicit failure, journal partial state, and read-only changes', () => {
  const lifecycle = findSandboxControlRecoveryOperation('task-lifecycle', 'complete')!;
  const lifecycleBinding = operationRecoveryBinding('c'.repeat(32), 'generation-3', 'TASK-20260904-002407', lifecycle.family, lifecycle.intent);
  const failed = { requestId: lifecycleBinding.requestId, generation: lifecycleBinding.generation, taskId: lifecycleBinding.taskId, intentDigest: lifecycleBinding.intentDigest, status: 'failed', changed: true };
  assert.equal(classifySandboxControlRecovery({
    operation: lifecycle, binding: lifecycleBinding, startedCommitted: true, terminalResult: failed,
    domain: { consistent: false }, criticalPhases
  }).outcome, 'failure');
  const applied = { ...failed, status: 'applied' };
  assert.equal(classifySandboxControlRecovery({
    operation: lifecycle, binding: lifecycleBinding, startedCommitted: true, terminalResult: applied,
    domain: { consistent: true }, journal: { exists: true, completedSteps: ['task-written'], failure: null }, criticalPhases
  }).outcome, 'in-progress');

  for (const intent of ['route.read', 'status'] as const) {
    const operation = findSandboxControlRecoveryOperation('task-orchestration', intent)!;
    const binding = operationRecoveryBinding(`read-${intent}`, 'generation-4', 'TASK-20260904-002407', operation.family, intent);
    const result = { requestId: binding.requestId, generation: binding.generation, taskId: binding.taskId, intentDigest: binding.intentDigest, status: 'running', changed: false };
    assert.equal(classifySandboxControlRecovery({
      operation, binding, startedCommitted: true, terminalResult: result,
      domain: { consistent: true, snapshotValid: true }, criticalPhases
    }).outcome, 'success', intent);
    assert.equal(classifySandboxControlRecovery({
      operation, binding, startedCommitted: true, terminalResult: { ...result, changed: true },
      domain: { consistent: true, snapshotValid: true }, criticalPhases
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
    domain: { consistent: true }, criticalPhases
  }).outcome, 'unknown');
});

test('recovery keeps a terminal result unknown when completion audit transitions are incomplete', () => {
  const operation = findSandboxControlRecoveryOperation('task-lifecycle', 'complete')!;
  const binding = operationRecoveryBinding('e'.repeat(32), 'generation-6', 'TASK-20260904-002407', operation.family, operation.intent);
  const result = {
    requestId: binding.requestId, generation: binding.generation, taskId: binding.taskId,
    intentDigest: binding.intentDigest, status: 'completed', changed: true
  };
  const decision = classifySandboxControlRecovery({
    operation, binding, startedCommitted: true, terminalResult: result,
    domain: { consistent: true }, criticalPhases: ['completed', 'evidence-written']
  });
  assert.deepEqual(decision, {
    outcome: 'unknown', responseReconstructable: false, reasonCode: 'RECOVERY_CRITICAL_AUDIT_INCOMPLETE'
  });
});
