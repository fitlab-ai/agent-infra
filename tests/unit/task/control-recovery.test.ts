import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifySandboxControlRecovery,
  digestControlRecoveryIntent,
  findSandboxControlRecoveryOperation,
  operationRecoveryBinding
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
