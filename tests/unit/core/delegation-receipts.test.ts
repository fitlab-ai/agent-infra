import assert from 'node:assert/strict';
import test from 'node:test';

import {
  activateDelegation,
  completeDelegationStage,
  consumeDelegation,
  dispatchDelegation,
  isDelegationReceipt,
  prepareDelegation,
  sealDelegation
} from '../../../lib/task/delegation-receipts.ts';
import { listAgentClientAdapters } from '../../../lib/agent-clients/registry.ts';
import { normalizeAgentToken } from '../../../lib/agent-clients/tokens.ts';

const input = {
  taskId: 'TASK-20260101-000001',
  runId: 'run-1',
  role: 'reviewer' as const,
  stage: 'review-code' as const,
  round: 1,
  artifact: 'review-code.md',
  client: 'claude-code' as const,
  requestedModel: 'review-model',
  requestedReasoningEffort: 'high',
  beforeFingerprint: 'before'
};

function dispatched(receipt: ReturnType<typeof prepareDelegation>) {
  const result = dispatchDelegation(receipt, {
    now: () => '2099-01-01T00:00:00.500Z', monotonicNow: () => 10
  });
  if (!result.ok) throw new Error(result.message);
  return result.receipt;
}

const codexProvenance = {
  protocolVersion: 3, packageVersion: '0.9.7-alpha.0',
  internalExecutableBuildHash: 'a'.repeat(64), lifecycleContractHash: 'b'.repeat(64),
  hookDefinitionHash: 'hook-hash', hookSource: 'project' as const,
  hookSourcePathDigest: 'c'.repeat(64), hookSourceHash: 'd'.repeat(64),
  capabilitySessionId: 'parent-codex', capabilityTurnId: 'parent-turn', capabilityToolUseId: 'capability-tool',
  controllerInstanceDigest: null, controlGeneration: null
};

test('persisted delegation receipts require the complete current structure', () => {
  const current = prepareDelegation({
    ...input,
    workspaceSnapshotScope: 'task',
    lifecycleProvenance: null
  }, {
    id: () => 'delegation-current',
    now: () => '2026-01-01T00:00:00.000Z',
    monotonicNow: () => 1
  });
  assert.equal(isDelegationReceipt(current), true);
  assert.equal(isDelegationReceipt({ ...current, unknownField: true }), false);
  const missing = { ...current } as Record<string, unknown>;
  delete missing.workspaceSnapshotScope;
  assert.equal(isDelegationReceipt(missing), false);
  assert.equal(isDelegationReceipt({ ...current, round: 0 }), false);
});

test('persisted delegation receipts bind lifecycle fields to their status', () => {
  const prepared = prepareDelegation({
    ...input,
    workspaceSnapshotScope: 'task',
    lifecycleProvenance: null
  }, {
    id: () => 'delegation-status-current',
    now: () => '2026-01-01T00:00:00.000Z',
    monotonicNow: () => 1
  });
  const dispatchedResult = dispatchDelegation(prepared, {
    now: () => '2026-01-01T00:00:00.500Z',
    monotonicNow: () => 2
  });
  assert.equal(dispatchedResult.ok, true);
  if (!dispatchedResult.ok) return;
  const dispatchedReceipt = dispatchedResult.receipt;
  const activatedResult = activateDelegation(dispatchedReceipt, {
    nativeAgent: 'agent-infra-lifecycle-reviewer',
    childId: 'child-status-current',
    parentId: 'parent-status-current',
    actualModel: 'review-model',
    actualReasoningEffort: 'high'
  }, {
    now: () => '2026-01-01T00:00:01.000Z',
    monotonicNow: () => 3
  });
  assert.equal(activatedResult.ok, true);
  if (!activatedResult.ok) return;
  const activated = activatedResult.receipt;
  const completedResult = completeDelegationStage(activated, {
    stage: 'review-code', round: 1, artifact: 'review-code.md', agent: 'claude'
  });
  assert.equal(completedResult.ok, true);
  if (!completedResult.ok) return;
  const stageCompleted = completedResult.receipt;
  const sealedResult = sealDelegation(stageCompleted, {
    childId: 'child-status-current', exitCode: 0, afterFingerprint: 'after',
    changedPaths: ['.agents/workspace/active/TASK-20260101-000001/review-code.md']
  }, { now: () => '2026-01-01T00:00:02.000Z' });
  assert.equal(sealedResult.ok, true);
  if (!sealedResult.ok) return;
  const sealed = sealedResult.receipt;
  const consumedResult = consumeDelegation(sealed, {
    now: () => '2026-01-01T00:00:03.000Z'
  });
  assert.equal(consumedResult.ok, true);
  if (!consumedResult.ok) return;
  const consumed = consumedResult.receipt;

  for (const receipt of [prepared, dispatchedReceipt, activated, stageCompleted, sealed, consumed]) {
    assert.equal(isDelegationReceipt(receipt), true, receipt.status);
  }
  for (const [label, receipt] of [
    ['prepared activation identity', { ...prepared, parentId: 'parent-status-current' }],
    ['activated child identity', { ...activated, childId: null }],
    ['activated timestamp', { ...activated, activatedAt: null }],
    ['activated future agent', { ...activated, agent: 'claude' }],
    ['stage-completed agent', { ...stageCompleted, agent: null }],
    ['stage-completed future seal', { ...stageCompleted, sealedAt: '2026-01-01T00:00:02.000Z' }],
    ['sealed fingerprint', { ...sealed, afterFingerprint: null }],
    ['sealed timestamp', { ...sealed, sealedAt: null }],
    ['sealed future consumption', { ...sealed, consumedAt: '2026-01-01T00:00:03.000Z' }],
    ['consumed timestamp', { ...consumed, consumedAt: null }]
  ] as const) {
    assert.equal(isDelegationReceipt(receipt), false, label);
  }
});

test('persisted Codex receipts require lifecycle provenance and status-bound host evidence', () => {
  const prepared = dispatched(prepareDelegation({
    ...input,
    client: 'codex',
    workspaceSnapshotScope: 'task',
    lifecycleProvenance: codexProvenance
  }, {
    id: () => 'delegation-codex-current',
    now: () => '2099-01-01T00:00:00.000Z',
    monotonicNow: () => 1
  }));
  assert.equal(isDelegationReceipt(prepared), true);
  assert.equal(isDelegationReceipt({ ...prepared, lifecycleProvenance: null }), false);

  const activated = activateDelegation(prepared, {
    nativeAgent: 'agent-infra-lifecycle-reviewer',
    childId: 'child-codex-current',
    parentId: 'parent-codex',
    spawnMode: 'fresh',
    actualModel: 'review-model',
    actualReasoningEffort: 'high',
    hostEvidence: {
      kind: 'codex-lifecycle-v2',
      startRevision: 4,
      ...codexProvenance,
      spawnToolUseId: 'spawn-tool',
      spawnObservedAt: '2099-01-01T00:00:00.500Z'
    }
  }, { now: () => '2099-01-01T00:00:01.000Z', monotonicNow: () => 2 });
  assert.equal(activated.ok, true);
  if (!activated.ok) return;
  assert.equal(isDelegationReceipt(activated.receipt), true);
  assert.equal(isDelegationReceipt({ ...activated.receipt, hostEvidence: null }), false);

  const completed = completeDelegationStage(activated.receipt, {
    stage: 'review-code', round: 1, artifact: 'review-code.md', agent: 'codex'
  });
  assert.equal(completed.ok, true);
  if (!completed.ok) return;
  const sealed = sealDelegation(completed.receipt, {
    childId: 'child-codex-current', exitCode: 0, afterFingerprint: 'after', changedPaths: [],
    hostEvidence: {
      stopRevision: 7,
      consumer: 'delegation-codex-current',
      consumedAt: '2099-01-01T00:00:02.000Z'
    }
  });
  assert.equal(sealed.ok, true);
  if (!sealed.ok) return;
  assert.equal(isDelegationReceipt(sealed.receipt), true);
  assert.equal(isDelegationReceipt({
    ...sealed.receipt,
    hostEvidence: { ...sealed.receipt.hostEvidence, consumer: 'other' }
  }), false);
});

test('delegation dispatch allows a sixty-second default activation window', () => {
  const result = dispatchDelegation(prepareDelegation(input), {
    now: () => '2099-01-01T00:00:00.000Z', monotonicNow: () => 10
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.receipt.activationDeadlineAt, '2099-01-01T00:01:00.000Z');
  assert.equal(result.receipt.activationDeadlineMonotonicMs, 60_010);
});

test('delegation receipts follow the one-way lifecycle and reject replay', () => {
  const prepared = dispatched(prepareDelegation({ ...input, workspaceSnapshotScope: 'task' }, {
    id: () => 'delegation-1', now: () => '2026-01-01T00:00:00.000Z'
  }));
  assert.equal(prepared.workspaceSnapshotScope, 'task');
  assert.equal(prepared.hostEvidence, null);
  const activated = activateDelegation(prepared, {
    nativeAgent: 'agent-infra-lifecycle-reviewer', childId: 'child-1', parentId: 'parent-1',
    spawnMode: 'fresh', actualModel: 'review-model', actualReasoningEffort: 'high'
  }, { now: () => '2026-01-01T00:00:01.000Z' });
  assert.equal(activated.ok, true);
  if (!activated.ok) return;
  const completed = completeDelegationStage(activated.receipt, {
    stage: 'review-code', round: 1, artifact: 'review-code.md', agent: 'claude'
  });
  assert.equal(completed.ok, true);
  if (!completed.ok) return;
  const sealed = sealDelegation(completed.receipt, {
    childId: 'child-1', exitCode: 0, afterFingerprint: 'after', changedPaths: ['.agents/workspace/active/TASK-20260101-000001/review-code.md']
  }, { now: () => '2026-01-01T00:00:02.000Z' });
  assert.equal(sealed.ok, true);
  if (!sealed.ok) return;
  const consumed = consumeDelegation(sealed.receipt, { now: () => '2026-01-01T00:00:03.000Z' });
  assert.equal(consumed.ok, true);
  if (!consumed.ok) return;
  assert.equal(consumed.receipt.status, 'consumed');
  assert.deepEqual(consumeDelegation(consumed.receipt), {
    ok: false, code: 'DELEGATION_REPLAY', message: 'delegation delegation-1 was already consumed'
  });
});

test('Codex receipts bind lifecycle evidence revisions through activation and seal', () => {
  const prepared = dispatched(prepareDelegation({
    ...input, client: 'codex', role: 'executor', stage: 'analysis', artifact: 'analysis.md',
    lifecycleProvenance: codexProvenance
  }, {
    id: () => 'delegation-codex', now: () => '2026-08-14T00:00:00.000Z'
  }));
  const activated = activateDelegation(prepared, {
    nativeAgent: 'agent-infra-lifecycle-executor', childId: 'child-codex', parentId: 'parent-codex',
    spawnMode: 'fresh', actualModel: 'review-model', actualReasoningEffort: 'high',
    hostEvidence: {
      kind: 'codex-lifecycle-v2', startRevision: 4, ...codexProvenance,
      spawnToolUseId: 'spawn-tool', spawnObservedAt: '2099-01-01T00:00:00.500Z'
    }
  }, { now: () => '2099-01-01T00:00:01.000Z' });
  assert.equal(activated.ok, true);
  if (!activated.ok) return;
  assert.deepEqual(activated.receipt.hostEvidence, {
    kind: 'codex-lifecycle-v2', startRevision: 4, ...codexProvenance,
    spawnToolUseId: 'spawn-tool', spawnObservedAt: '2099-01-01T00:00:00.500Z',
    stopRevision: null, consumer: null, consumedAt: null
  });

  const completed = completeDelegationStage(activated.receipt, {
    stage: 'analysis', round: 1, artifact: 'analysis.md', agent: 'codex'
  });
  assert.equal(completed.ok, true);
  if (!completed.ok) return;
  const sealed = sealDelegation(completed.receipt, {
    childId: 'child-codex', exitCode: 0, afterFingerprint: 'after', changedPaths: [],
    hostEvidence: { stopRevision: 7, consumer: 'delegation-codex', consumedAt: '2026-08-14T00:00:02.000Z' }
  }, { now: () => '2026-08-14T00:00:03.000Z' });
  assert.equal(sealed.ok, true);
  if (!sealed.ok) return;
  assert.deepEqual(sealed.receipt.hostEvidence, {
    kind: 'codex-lifecycle-v2', startRevision: 4, ...codexProvenance,
    spawnToolUseId: 'spawn-tool', spawnObservedAt: '2099-01-01T00:00:00.500Z',
    stopRevision: 7, consumer: 'delegation-codex', consumedAt: '2026-08-14T00:00:02.000Z'
  });
});

test('Codex activation reports build drift without blocking receipt activation', () => {
  const prepared = dispatched(prepareDelegation({
    ...input, client: 'codex', role: 'executor', stage: 'analysis', artifact: 'analysis.md',
    lifecycleProvenance: codexProvenance
  }, {
    id: () => 'delegation-codex-build-drift', now: () => '2099-01-01T00:00:00.000Z'
  }));
  const result = activateDelegation(prepared, {
    nativeAgent: 'agent-infra-lifecycle-executor',
    childId: 'child-codex-build-drift',
    parentId: 'parent-codex',
    spawnMode: 'fresh',
    actualModel: 'review-model',
    actualReasoningEffort: 'high',
    hostEvidence: {
      kind: 'codex-lifecycle-v2',
      startRevision: 4,
      ...codexProvenance,
      packageVersion: '0.9.8-alpha.0',
      internalExecutableBuildHash: 'e'.repeat(64),
      lifecycleContractHash: 'f'.repeat(64),
      spawnToolUseId: 'spawn-tool',
      spawnObservedAt: '2099-01-01T00:00:00.500Z'
    }
  }, { now: () => '2099-01-01T00:00:01.000Z', monotonicNow: () => 2 });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.receipt.status, 'activated');
  assert.deepEqual(result.warnings?.map((warning) => warning.code), [
    'CODEX_LIFECYCLE_BUILD_MISMATCH',
    'CODEX_LIFECYCLE_CONTRACT_MISMATCH'
  ]);
});

test('Codex receipts reject generic hook evidence and cross-session capability reuse', () => {
  const prepared = dispatched(prepareDelegation({
    ...input,
    client: 'codex',
    lifecycleProvenance: codexProvenance
  }, { id: () => 'delegation-codex-negative' }));
  const base = {
    nativeAgent: 'agent-infra-lifecycle-reviewer', childId: 'child-codex-negative',
    parentId: 'parent-codex', spawnMode: 'fresh', actualModel: 'review-model',
    actualReasoningEffort: 'high'
  };
  assert.equal(activateDelegation(prepared, base).code, 'DELEGATION_HOST_EVIDENCE_REQUIRED');
  assert.equal(activateDelegation(prepared, {
    ...base,
    hostEvidence: { kind: 'codex-lifecycle-v1', hookDefinitionHash: 'hook-hash', startRevision: 1 }
  }).code, 'DELEGATION_HOST_EVIDENCE_REQUIRED');
  assert.equal(activateDelegation(prepared, {
    ...base,
    parentId: 'stolen-session',
    hostEvidence: { kind: 'codex-lifecycle-v2', startRevision: 1, ...codexProvenance }
  }).code, 'DELEGATION_HOST_EVIDENCE_INVALID');
  assert.equal(activateDelegation(prepared, {
    ...base,
    hostEvidence: {
      kind: 'codex-lifecycle-v2', startRevision: 1, ...codexProvenance,
      spawnToolUseId: codexProvenance.capabilityToolUseId,
      spawnObservedAt: '2099-01-01T00:00:00.500Z'
    }
  }).code, 'DELEGATION_HOST_EVIDENCE_INVALID');
  assert.equal(activateDelegation(prepared, {
    ...base,
    hostEvidence: {
      kind: 'codex-lifecycle-v2', startRevision: 1, ...codexProvenance,
      spawnToolUseId: 'spawn-tool', spawnObservedAt: '2099-01-01T00:00:00.499Z'
    }
  }, { now: () => '2099-01-01T00:00:01.000Z' }).code, 'DELEGATION_HOST_EVIDENCE_INVALID');
  assert.equal(activateDelegation(prepared, {
    ...base,
    hostEvidence: {
      kind: 'codex-lifecycle-v2', startRevision: 1, ...codexProvenance,
      spawnToolUseId: 'spawn-tool', spawnObservedAt: '2099-01-01T00:01:00.501Z'
    }
  }, { now: () => '2099-01-01T00:00:01.000Z' }).code, 'DELEGATION_HOST_EVIDENCE_INVALID');
});

test('legacy prepared receipts fail closed before activation and can be dispatched safely', () => {
  const current = prepareDelegation(input, { id: () => 'delegation-legacy' });
  const legacy = { ...current } as Record<string, unknown>;
  delete legacy.spawnDispatchMonotonicMs;
  delete legacy.activationDeadlineMonotonicMs;
  delete legacy.spawnDispatchedAt;
  delete legacy.activationDeadlineAt;

  assert.equal(activateDelegation(legacy as typeof current, {
    nativeAgent: 'agent-infra-lifecycle-reviewer', childId: 'legacy-child', parentId: 'legacy-parent',
    spawnMode: 'fresh', actualModel: 'review-model', actualReasoningEffort: 'high'
  }).code, 'DELEGATION_NOT_DISPATCHED');
  assert.equal(dispatchDelegation(legacy as typeof current).ok, true);
});

test('managed identities fail closed while unrelated subagents are ignored', () => {
  const prepared = dispatched(prepareDelegation(input, { id: () => 'delegation-2' }));
  assert.deepEqual(activateDelegation(prepared, {
    nativeAgent: 'general-purpose', childId: 'child-2', parentId: 'parent-1', spawnMode: 'fresh'
  }), { ok: false, code: 'DELEGATION_IGNORED', message: "subagent 'general-purpose' is not lifecycle-managed" });
  assert.equal(activateDelegation(prepared, {
    nativeAgent: 'agent-infra-lifecycle-reviewer', childId: 'parent-1', parentId: 'parent-1', spawnMode: 'fresh'
  }).code, 'DELEGATION_IDENTITY_INVALID');
  assert.equal(activateDelegation(prepared, {
    nativeAgent: 'agent-infra-lifecycle-executor', childId: 'child-2', parentId: 'parent-1', spawnMode: 'fresh'
  }).code, 'DELEGATION_ROLE_MISMATCH');

  // spawnMode enforcement (fork protection) is a non-claude-code concern (HDR-9 议题 B):
  // claude-code has no host-provided spawn_mode field, so it does not gate on this dimension.
  const strictPrepared = dispatched(prepareDelegation({ ...input, client: 'antigravity-cli' }, { id: () => 'delegation-2-strict' }));
  assert.equal(activateDelegation(strictPrepared, {
    nativeAgent: 'agent-infra-lifecycle-reviewer', childId: 'child-2-strict', parentId: 'parent-1', spawnMode: 'fork'
  }).code, 'DELEGATION_FORK_FORBIDDEN');
});

test('activation requires host-observed model identity and records justified fallback', () => {
  const prepared = dispatched(prepareDelegation({ ...input, client: 'antigravity-cli' }, { id: () => 'delegation-model' }));
  const event = {
    nativeAgent: 'agent-infra-lifecycle-reviewer', childId: 'child-model',
    parentId: 'parent-model', spawnMode: 'fresh'
  };

  assert.equal(activateDelegation(prepared, event).code, 'DELEGATION_MODEL_IDENTITY_MISSING');
  assert.equal(activateDelegation(prepared, { ...event, actualModel: 'review-model' }).code, 'DELEGATION_REASONING_EFFORT_MISSING');
  assert.equal(activateDelegation(prepared, {
    ...event, actualModel: 'fallback-model', actualReasoningEffort: 'high'
  }).code, 'DELEGATION_MODEL_FALLBACK_UNRECORDED');
  assert.equal(activateDelegation(prepared, {
    ...event, actualModel: 'review-model', actualReasoningEffort: 'medium'
  }).code, 'DELEGATION_REASONING_EFFORT_FALLBACK_UNRECORDED');
  assert.equal(activateDelegation(prepared, {
    ...event,
    actualModel: 'fallback-model',
    actualReasoningEffort: 'medium',
    modelFallbackReason: 'requested model unavailable',
    reasoningEffortFallbackReason: 'requested effort unavailable'
  }).ok, true);
});

test('claude-code activation records model/effort without gating on their presence (HDR-2)', () => {
  const prepared = dispatched(prepareDelegation({ ...input, client: 'claude-code' }, { id: () => 'delegation-cc-relaxed' }));
  const event = {
    nativeAgent: 'agent-infra-lifecycle-reviewer', childId: 'child-cc-relaxed', parentId: 'parent-1'
  };

  // model/effort both absent: activation still succeeds, receipt records null (not an error).
  const missing = activateDelegation(prepared, event);
  assert.equal(missing.ok, true);
  if (missing.ok) {
    assert.equal(missing.receipt.actualModel, null);
    assert.equal(missing.receipt.actualReasoningEffort, null);
  }
});

test('claude-code activation records mismatched model/effort without a fallback reason (HDR-2)', () => {
  const prepared = dispatched(prepareDelegation({ ...input, client: 'claude-code' }, { id: () => 'delegation-cc-fallback' }));
  const activated = activateDelegation(prepared, {
    nativeAgent: 'agent-infra-lifecycle-reviewer', childId: 'child-cc-fallback', parentId: 'parent-1',
    actualModel: 'fallback-model', actualReasoningEffort: 'medium'
  });
  assert.equal(activated.ok, true);
  if (activated.ok) {
    assert.equal(activated.receipt.actualModel, 'fallback-model');
    assert.equal(activated.receipt.actualReasoningEffort, 'medium');
    assert.equal(activated.receipt.modelFallbackReason, null);
    assert.equal(activated.receipt.reasoningEffortFallbackReason, null);
  }
});

test('claude-code activation still rejects an unrelated fallback reason (HDR-2 does not relax this red line)', () => {
  const prepared = dispatched(prepareDelegation({ ...input, client: 'claude-code' }, { id: () => 'delegation-cc-invalid-fallback' }));
  const event = {
    nativeAgent: 'agent-infra-lifecycle-reviewer', childId: 'child-cc-invalid-fallback', parentId: 'parent-1'
  };
  assert.equal(activateDelegation(prepared, {
    ...event, actualModel: 'review-model', modelFallbackReason: 'unrelated reason'
  }).code, 'DELEGATION_MODEL_FALLBACK_INVALID');
  assert.equal(activateDelegation(prepared, {
    ...event, actualReasoningEffort: 'high', reasoningEffortFallbackReason: 'unrelated reason'
  }).code, 'DELEGATION_REASONING_EFFORT_FALLBACK_INVALID');
});

test('claude-code activation rejects a fabricated fallback reason when the actual value was never observed (review-code blocker)', () => {
  const prepared = dispatched(prepareDelegation({ ...input, client: 'claude-code' }, { id: () => 'delegation-cc-fabricated-fallback' }));
  const event = {
    nativeAgent: 'agent-infra-lifecycle-reviewer', childId: 'child-cc-fabricated-fallback', parentId: 'parent-1'
  };
  // no actualModel/actualReasoningEffort at all, yet a fallback reason is supplied: still a red-line violation.
  assert.equal(activateDelegation(prepared, {
    ...event, modelFallbackReason: 'fabricated reason'
  }).code, 'DELEGATION_MODEL_FALLBACK_INVALID');
  assert.equal(activateDelegation(prepared, {
    ...event, reasoningEffortFallbackReason: 'fabricated reason'
  }).code, 'DELEGATION_REASONING_EFFORT_FALLBACK_INVALID');
});

test('claude-code activation folds blank actual model/effort into null instead of recording them as observed', () => {
  const prepared = dispatched(prepareDelegation({ ...input, client: 'claude-code' }, { id: () => 'delegation-cc-blank' }));
  const activated = activateDelegation(prepared, {
    nativeAgent: 'agent-infra-lifecycle-reviewer', childId: 'child-cc-blank', parentId: 'parent-1',
    actualModel: '   ', actualReasoningEffort: '  '
  });
  assert.equal(activated.ok, true);
  if (activated.ok) {
    assert.equal(activated.receipt.actualModel, null);
    assert.equal(activated.receipt.actualReasoningEffort, null);
  }
});

test('claude-code seal folds blank actual model/effort into null instead of recording them as observed (review-code CD-3)', () => {
  const prepared = dispatched(prepareDelegation({ ...input, client: 'claude-code' }, { id: () => 'delegation-cc-seal-blank' }));
  // activation observes nothing (Start payload carries no model/effort), matching the Stop-side
  // fixture from review-code-r2.md#CD-3: the whitespace must be folded at seal too, not just at activation.
  const activated = activateDelegation(prepared, {
    nativeAgent: 'agent-infra-lifecycle-reviewer', childId: 'child-cc-seal-blank', parentId: 'parent-1'
  });
  assert.equal(activated.ok, true);
  if (!activated.ok) return;
  const completed = completeDelegationStage(activated.receipt, {
    stage: 'review-code', round: 1, artifact: 'review-code.md', agent: 'claude'
  });
  assert.equal(completed.ok, true);
  if (!completed.ok) return;
  const sealed = sealDelegation(completed.receipt, {
    childId: 'child-cc-seal-blank', exitCode: 0, afterFingerprint: 'after',
    changedPaths: ['.agents/workspace/active/TASK-20260101-000001/review-code.md'],
    actualModel: '   ', actualReasoningEffort: '  '
  });
  assert.equal(sealed.ok, true);
  if (sealed.ok) {
    assert.equal(sealed.receipt.actualModel, null);
    assert.equal(sealed.receipt.actualReasoningEffort, null);
  }
});

test('claude-code activation skips the fork-mode check but keeps parent/child identity fail-closed (HDR-9)', () => {
  const prepared = dispatched(prepareDelegation({ ...input, client: 'claude-code' }, { id: () => 'delegation-cc-identity' }));
  // no spawnMode provided at all, and even an explicit 'fork' value: claude-code has no host-provided
  // spawn_mode field to gate on (HDR-9 议题 B), so activation still succeeds.
  const noSpawnMode = activateDelegation(prepared, {
    nativeAgent: 'agent-infra-lifecycle-reviewer', childId: 'child-cc-identity', parentId: 'parent-1'
  });
  assert.equal(noSpawnMode.ok, true);
  if (noSpawnMode.ok) assert.equal(noSpawnMode.receipt.spawnMode, null);

  // parentId/childId identity is unconditional for every client, including claude-code.
  assert.equal(activateDelegation(prepared, {
    nativeAgent: 'agent-infra-lifecycle-reviewer', childId: 'child-cc-identity-2', parentId: ''
  }).code, 'DELEGATION_IDENTITY_INVALID');
  assert.equal(activateDelegation(prepared, {
    nativeAgent: 'agent-infra-lifecycle-reviewer', childId: 'same-id', parentId: 'same-id'
  }).code, 'DELEGATION_IDENTITY_INVALID');
});

test('claude-code receipt accepts the normalized short agent claude', () => {
  const prepared = dispatched(prepareDelegation({ ...input, client: 'claude-code' }, { id: () => 'delegation-cc' }));
  const activated = activateDelegation(prepared, {
    nativeAgent: 'agent-infra-lifecycle-reviewer', childId: 'child-cc', parentId: 'parent-1',
    spawnMode: 'fresh', actualModel: 'review-model', actualReasoningEffort: 'high'
  });
  assert.equal(activated.ok, true);
  if (!activated.ok) return;
  // The write-side normalizer turns `--agent claude-code` into the short token
  // `claude` before it reaches the orchestration layer; the existing
  // acceptedAgents check for a claude-code receipt must accept that short name.
  const completed = completeDelegationStage(activated.receipt, {
    stage: 'review-code', round: 1, artifact: 'review-code.md', agent: 'claude'
  });
  assert.equal(completed.ok, true);
  if (completed.ok) assert.equal(completed.code, undefined);
});

test('stage completion accepts the normalized activity token for every registered client', () => {
  for (const adapter of listAgentClientAdapters()) {
    const prepared = dispatched(prepareDelegation(
      { ...input, client: adapter.id, ...(adapter.id === 'codex' ? { lifecycleProvenance: {
        ...codexProvenance, capabilitySessionId: 'parent-1'
      } } : {}) },
      { id: () => `delegation-${adapter.id}` }
    ));
    const activated = activateDelegation(prepared, {
      nativeAgent: 'agent-infra-lifecycle-reviewer',
      childId: `child-${adapter.id}`,
      parentId: 'parent-1',
      spawnMode: 'fresh',
      actualModel: 'review-model',
      actualReasoningEffort: 'high',
      ...(adapter.id === 'codex' ? { hostEvidence: {
        kind: 'codex-lifecycle-v2' as const, startRevision: 1,
        ...codexProvenance, capabilitySessionId: 'parent-1', spawnToolUseId: 'spawn-tool',
        spawnObservedAt: '2099-01-01T00:00:00.500Z'
      } } : {})
    });
    assert.equal(activated.ok, true, adapter.id);
    if (!activated.ok) continue;
    const agent = normalizeAgentToken(adapter.id);
    assert.ok(agent, adapter.id);
    const completed = completeDelegationStage(activated.receipt, {
      stage: 'review-code',
      round: 1,
      artifact: 'review-code.md',
      agent
    });
    assert.equal(completed.ok, true, adapter.id);
  }
});

test('stage completion rejects cross-client and unknown activity tokens', () => {
  const prepared = dispatched(prepareDelegation(
    { ...input, client: 'claude-code' },
    { id: () => 'delegation-agent-mismatch' }
  ));
  const activated = activateDelegation(prepared, {
    nativeAgent: 'agent-infra-lifecycle-reviewer',
    childId: 'child-agent-mismatch',
    parentId: 'parent-1',
    spawnMode: 'fresh',
    actualModel: 'review-model',
    actualReasoningEffort: 'high'
  });
  assert.equal(activated.ok, true);
  if (!activated.ok) return;

  for (const agent of ['codex', 'gemini']) {
    const completed = completeDelegationStage(activated.receipt, {
      stage: 'review-code',
      round: 1,
      artifact: 'review-code.md',
      agent
    });
    assert.equal(completed.ok, false, agent);
    assert.equal(completed.code, 'DELEGATION_AGENT_MISMATCH', agent);
  }
});

test('reviewer write gate rejects shared, non-allowlisted task, and cross-task paths', () => {
  const prepared = dispatched(prepareDelegation(input, { id: () => 'delegation-3' }));
  const activated = activateDelegation(prepared, {
    nativeAgent: 'agent-infra-lifecycle-reviewer', childId: 'child-3', parentId: 'parent-1',
    spawnMode: 'fresh', actualModel: 'review-model', actualReasoningEffort: 'high'
  });
  assert.equal(activated.ok, true);
  if (!activated.ok) return;
  const completed = completeDelegationStage(activated.receipt, {
    stage: 'review-code', round: 1, artifact: 'review-code.md', agent: 'claude'
  });
  assert.equal(completed.ok, true);
  if (!completed.ok) return;

  for (const changedPath of [
    'lib/task/orchestration.ts',
    '.agents/workspace/active/TASK-20260101-000001/analysis.md',
    '.agents/workspace/active/TASK-20260101-999999/review-code.md'
  ]) {
    const result = sealDelegation(completed.receipt, {
      childId: 'child-3', exitCode: 0, afterFingerprint: 'after', changedPaths: [changedPath]
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'DELEGATION_REVIEWER_WRITE_FORBIDDEN');
  }
});
