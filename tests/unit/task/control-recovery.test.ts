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

test('recovery registry covers the remaining broker families', () => {
  assert.equal(findSandboxControlRecoveryOperation('task-lifecycle', 'complete')?.class, 'lifecycle-mutation');
  assert.equal(findSandboxControlRecoveryOperation('task-finalization', 'complete')?.class, 'finalization');
  assert.equal(findSandboxControlRecoveryOperation('task-create', 'create')?.class, 'task-create');
  assert.equal(findSandboxControlRecoveryOperation('codex-controller', 'verify')?.class, 'codex-controller');
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

test('every registered mutation requires a matching domain contract', () => {
  for (const operation of SANDBOX_CONTROL_RECOVERY_OPERATIONS) {
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
    const expectedOutcome = operation.intent === 'recover-started' ? 'unknown' : 'success';
    assert.equal(classifySandboxControlRecovery({
      operation,
      binding,
      startedCommitted: true,
      terminalResult: result,
      domain,
      criticalPhases,
    }).outcome, expectedOutcome, operation.intent);
    assert.equal(classifySandboxControlRecovery({
      operation, binding, startedCommitted: true, terminalResult: result
    }).outcome, 'unknown', `${operation.family}:${operation.intent} missing domain`);
  }
});

test('recover-started response loss stays unknown and is retried through the idempotent command', () => {
  const operation = findSandboxControlRecoveryOperation('task-lifecycle', 'recover-started')!;
  const binding = operationRecoveryBinding('f'.repeat(32), 'generation-7', 'TASK-20260904-002407', operation.family, operation.intent);
  const result = {
    requestId: binding.requestId, generation: binding.generation, taskId: binding.taskId,
    intentDigest: binding.intentDigest, status: 'applied', changed: true, targetState: 'active'
  };
  assert.equal(classifySandboxControlRecovery({
    operation, binding, startedCommitted: true, terminalResult: result,
    domain: { consistent: true }, criticalPhases
  }).outcome, 'unknown');
});

test('recovery matrix distinguishes explicit failure and journal partial state', () => {
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
});

test('recovery rejects durable terminal results with conflicting bindings', () => {
  const operation = findSandboxControlRecoveryOperation('task-create', 'create')!;
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
