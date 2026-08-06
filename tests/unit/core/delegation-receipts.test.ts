import assert from 'node:assert/strict';
import test from 'node:test';

import {
  activateDelegation,
  completeDelegationStage,
  consumeDelegation,
  prepareDelegation,
  sealDelegation
} from '../../../lib/task/delegation-receipts.ts';

const input = {
  taskId: 'TASK-20260101-000001',
  runId: 'run-1',
  role: 'reviewer' as const,
  stage: 'review-code' as const,
  round: 1,
  artifact: 'review-code.md',
  client: 'codex' as const,
  requestedModel: 'review-model',
  beforeFingerprint: 'before'
};

test('delegation receipts follow the one-way lifecycle and reject replay', () => {
  const prepared = prepareDelegation({ ...input, workspaceSnapshotScope: 'task' }, {
    id: () => 'delegation-1', now: () => '2026-01-01T00:00:00.000Z'
  });
  assert.equal(prepared.workspaceSnapshotScope, 'task');
  const activated = activateDelegation(prepared, {
    nativeAgent: 'agent-infra-lifecycle-reviewer', childId: 'child-1', parentId: 'parent-1',
    spawnMode: 'fresh', actualModel: 'review-model'
  }, { now: () => '2026-01-01T00:00:01.000Z' });
  assert.equal(activated.ok, true);
  if (!activated.ok) return;
  const completed = completeDelegationStage(activated.receipt, {
    stage: 'review-code', round: 1, artifact: 'review-code.md', agent: 'codex'
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

test('managed identities fail closed while unrelated subagents are ignored', () => {
  const prepared = prepareDelegation(input, { id: () => 'delegation-2' });
  assert.deepEqual(activateDelegation(prepared, {
    nativeAgent: 'general-purpose', childId: 'child-2', parentId: 'parent-1', spawnMode: 'fresh'
  }), { ok: false, code: 'DELEGATION_IGNORED', message: "subagent 'general-purpose' is not lifecycle-managed" });
  assert.equal(activateDelegation(prepared, {
    nativeAgent: 'agent-infra-lifecycle-reviewer', childId: 'parent-1', parentId: 'parent-1', spawnMode: 'fresh'
  }).code, 'DELEGATION_IDENTITY_INVALID');
  assert.equal(activateDelegation(prepared, {
    nativeAgent: 'agent-infra-lifecycle-reviewer', childId: 'child-2', parentId: 'parent-1', spawnMode: 'fork'
  }).code, 'DELEGATION_FORK_FORBIDDEN');
  assert.equal(activateDelegation(prepared, {
    nativeAgent: 'agent-infra-lifecycle-executor', childId: 'child-2', parentId: 'parent-1', spawnMode: 'fresh'
  }).code, 'DELEGATION_ROLE_MISMATCH');
});

test('activation treats model evidence as optional and records justified fallback', () => {
  const prepared = prepareDelegation(input, { id: () => 'delegation-model' });
  const event = {
    nativeAgent: 'agent-infra-lifecycle-reviewer', childId: 'child-model',
    parentId: 'parent-model', spawnMode: 'fresh'
  };

  // 模型证据可选：宿主未回传 actual model（如 Claude Code 已验证不回传）不再失败关闭。
  const missing = activateDelegation(prepared, event);
  assert.equal(missing.ok, true);
  if (missing.ok) assert.equal(missing.receipt.actualModel, null);

  // 已回传 actual model 时，与 requested 不一致且无降级理由仍失败关闭。
  assert.equal(activateDelegation(prepared, { ...event, actualModel: 'fallback-model' }).code, 'DELEGATION_MODEL_FALLBACK_UNRECORDED');
  assert.equal(activateDelegation(prepared, {
    ...event, actualModel: 'fallback-model', modelFallbackReason: 'requested model unavailable'
  }).ok, true);

  // 一致路径仍正常记录。
  const matched = activateDelegation(prepared, { ...event, actualModel: 'review-model' });
  assert.equal(matched.ok, true);
  if (matched.ok) assert.equal(matched.receipt.actualModel, 'review-model');
});

test('claude-code receipt accepts the normalized short agent claude', () => {
  const prepared = prepareDelegation({ ...input, client: 'claude-code' }, { id: () => 'delegation-cc' });
  const activated = activateDelegation(prepared, {
    nativeAgent: 'agent-infra-lifecycle-reviewer', childId: 'child-cc', parentId: 'parent-1',
    spawnMode: 'fresh', actualModel: 'review-model'
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

test('reviewer write gate rejects shared, non-allowlisted task, and cross-task paths', () => {
  const prepared = prepareDelegation(input, { id: () => 'delegation-3' });
  const activated = activateDelegation(prepared, {
    nativeAgent: 'agent-infra-lifecycle-reviewer', childId: 'child-3', parentId: 'parent-1',
    spawnMode: 'fresh', actualModel: 'review-model'
  });
  assert.equal(activated.ok, true);
  if (!activated.ok) return;
  const completed = completeDelegationStage(activated.receipt, {
    stage: 'review-code', round: 1, artifact: 'review-code.md', agent: 'codex'
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
