import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { platformResult } from '../../../lib/platform/types.ts';
import {
  applyFinalizationReceiptMutation,
  applyTaskFinalization,
  createFinalizationCapability,
  readTaskFinalizationReceipt,
  type TaskFinalizationOptions,
  type TaskFinalizationRequest,
  type TaskFinalizationReceipt
} from '../../../lib/task/finalization.ts';
import type { TaskVerificationResult } from '../../../lib/task/verification.ts';

const TASK_ID = 'TASK-20260101-000001';
const METADATA = { timestamp: '2026-08-24 12:00:00+00:00', agentInfraVersion: 'v0.9.9' };

function fixture(): { repoRoot: string; taskDir: string } {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'task-finalization-'));
  const taskDir = path.join(repoRoot, '.agents', 'workspace', 'active', TASK_ID);
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(repoRoot, '.agents', '.airc.json'), JSON.stringify({ task: { shortIdLength: 2 } }));
  fs.writeFileSync(path.join(repoRoot, '.agents', 'workspace', 'active', '.short-ids.json'), `${JSON.stringify({ version: 1, ids: { '01': TASK_ID } })}\n`);
  fs.writeFileSync(path.join(taskDir, 'task.md'), [
    '---', `id: ${TASK_ID}`, 'issue_number: 42', 'status: active', 'current_step: code-review',
    'assigned_to: codex', 'updated_at: old', 'agent_infra_version: v0.9.9', 'target_date:', '---',
    '', '# Task', '', '## Review Disagreement Ledger', '',
    '| id | stage | round | severity | status | evidence |',
    '|----|-------|-------|----------|--------|----------|', '', '## Activity Log', ''
  ].join('\n'));
  return { repoRoot, taskDir };
}

function verification(status: 'pass' | 'fail' | 'blocked'): TaskVerificationResult {
  const payload = status === 'pass'
    ? { gate: 'pass', summary: '1 passed, 0 failed', action: 'All declared checks passed' }
    : { gate: status, summary: status === 'blocked' ? '0 passed, 0 failed, 1 blocked' : '0 passed, 1 failed', action: status === 'blocked' ? 'Resolve blocked complete-task check and re-run gate' : 'Fix complete-task issues and re-run gate' };
  return {
    status,
    changed: false,
    event: 'complete-task.completed',
    requestRef: TASK_ID,
    taskId: TASK_ID,
    taskDir: `/completed/${TASK_ID}`,
    taskState: 'completed',
    skill: 'complete-task',
    mode: 'gate',
    artifact: null,
    invocations: status === 'pass' ? [] : [{ status, exitCode: status === 'blocked' ? 2 : 1, payload }],
    error: null
  };
}

function options(
  repoRoot: string,
  commentSync: NonNullable<TaskFinalizationOptions['commentSync']>,
  verify: NonNullable<TaskFinalizationOptions['verify']>
): TaskFinalizationOptions {
  return {
    repoRoot,
    metadataProvider: () => METADATA,
    commentSync,
    verify
  };
}

const request: TaskFinalizationRequest = { taskRef: TASK_ID, intent: 'complete', agent: 'codex' };

test('host finalization receipt records the sandbox generation and request binding', async () => {
  const f = fixture();
  const commentSync: NonNullable<TaskFinalizationOptions['commentSync']> = async () => platformResult('no-op');
  const verify: NonNullable<TaskFinalizationOptions['verify']> = async () => verification('pass');
  const requestId = '0123456789abcdef0123456789abcdef';
  try {
    await applyTaskFinalization(request, {
      ...options(f.repoRoot, commentSync, verify),
      controlBinding: { generation: 'sandbox-generation', requestId }
    });
    assert.deepEqual(readTaskFinalizationReceipt(f.repoRoot, TASK_ID)?.controlBinding, {
      generation: 'sandbox-generation', requestId
    });
  } finally {
    fs.rmSync(f.repoRoot, { recursive: true, force: true });
  }
});

test('host finalization fails closed when an existing receipt has a different sandbox binding', async () => {
  const f = fixture();
  const commentSync: NonNullable<TaskFinalizationOptions['commentSync']> = async () => platformResult('no-op');
  const verify: NonNullable<TaskFinalizationOptions['verify']> = async () => verification('pass');
  const firstBinding = { generation: 'sandbox-generation', requestId: '0123456789abcdef0123456789abcdef' };
  const conflictingBinding = { generation: 'other-generation', requestId: 'fedcba9876543210fedcba9876543210' };
  try {
    assert.equal((await applyTaskFinalization(request, { ...options(f.repoRoot, commentSync, verify), controlBinding: firstBinding })).status, 'completed');
    const replay = await applyTaskFinalization(request, { ...options(f.repoRoot, commentSync, verify), controlBinding: conflictingBinding });
    assert.equal(replay.status, 'failed');
    assert.equal(replay.error?.code, 'TASK_FINALIZATION_CONTROL_BINDING_CONFLICT');
    assert.deepEqual(readTaskFinalizationReceipt(f.repoRoot, TASK_ID)?.controlBinding, firstBinding);
  } finally {
    fs.rmSync(f.repoRoot, { recursive: true, force: true });
  }
});

test('host finalization uses the canonical root and makes a successful replay a no-op', async () => {
  const f = fixture();
  let commentCalls = 0;
  let verifyCalls = 0;
  const commentSync: NonNullable<TaskFinalizationOptions['commentSync']> = async (_taskRef, received) => {
    commentCalls += 1;
    assert.equal(received.cwd, f.repoRoot);
    return platformResult(commentCalls === 1 ? 'applied' : 'no-op');
  };
  const verify: NonNullable<TaskFinalizationOptions['verify']> = async (received, receivedOptions) => {
    verifyCalls += 1;
    assert.deepEqual(received, { taskRef: TASK_ID, event: 'complete-task.completed' });
    assert.equal(receivedOptions?.repoRoot, f.repoRoot);
    return verification('pass');
  };
  try {
    const first = await applyTaskFinalization(request, options(f.repoRoot, commentSync, verify));
    const second = await applyTaskFinalization(request, options(f.repoRoot, commentSync, verify));
    assert.equal(first.status, 'completed');
    assert.equal(second.status, 'completed');
    assert.equal(commentCalls, 1);
    assert.equal(verifyCalls, 1);
    assert.equal(second.taskComment?.status, 'no-op');
    assert.equal(fs.existsSync(path.join(f.repoRoot, '.agents', 'workspace', 'completed', TASK_ID, 'task.md')), true);
    assert.equal((fs.readFileSync(path.join(f.repoRoot, '.agents', 'workspace', 'completed', TASK_ID, 'task.md'), 'utf8').match(/Complete Task/g) ?? []).length, 2);
  } finally {
    fs.rmSync(f.repoRoot, { recursive: true, force: true });
  }
});

test('host finalization revalidates canonical steps when the receipt is absent', async () => {
  const f = fixture();
  let commentCalls = 0;
  let verifyCalls = 0;
  const commentSync: NonNullable<TaskFinalizationOptions['commentSync']> = async () => {
    commentCalls += 1;
    return platformResult(commentCalls === 1 ? 'applied' : 'no-op');
  };
  const verify: NonNullable<TaskFinalizationOptions['verify']> = async () => {
    verifyCalls += 1;
    return verification('pass');
  };
  try {
    const first = await applyTaskFinalization(request, options(f.repoRoot, commentSync, verify));
    fs.rmSync(path.join(f.repoRoot, '.agents', 'workspace', '.task-finalization', `${TASK_ID}.json`));
    const second = await applyTaskFinalization(request, options(f.repoRoot, commentSync, verify));
    assert.equal(first.status, 'completed');
    assert.equal(second.status, 'completed');
    assert.equal(second.lifecycle?.status, 'no-op');
    assert.equal(commentCalls, 2);
    assert.equal(verifyCalls, 2);
  } finally {
    fs.rmSync(f.repoRoot, { recursive: true, force: true });
  }
});

test('host finalization rejects a current receipt that omits warningProjection', async () => {
  const f = fixture();
  const commentSync: NonNullable<TaskFinalizationOptions['commentSync']> = async () => platformResult('no-op');
  const verify: NonNullable<TaskFinalizationOptions['verify']> = async () => verification('pass');
  const receiptPath = path.join(f.repoRoot, '.agents', 'workspace', '.task-finalization', `${TASK_ID}.json`);
  try {
    const first = await applyTaskFinalization(request, options(f.repoRoot, commentSync, verify));
    assert.equal(first.status, 'completed');
    const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')) as Record<string, unknown>;
    delete receipt.warningProjection;
    fs.writeFileSync(receiptPath, `${JSON.stringify(receipt)}\n`);
    const replay = await applyTaskFinalization(request, options(f.repoRoot, commentSync, verify));
    assert.equal(replay.status, 'failed');
    assert.equal(replay.error?.code, 'TASK_FINALIZATION_RECEIPT_INVALID');
  } finally {
    fs.rmSync(f.repoRoot, { recursive: true, force: true });
  }
});

test('host finalization returns actionable verification gate failures and retries them', async () => {
  const f = fixture();
  let commentCalls = 0;
  const commentSnapshots: string[] = [];
  let verifyCalls = 0;
  const commentSync: NonNullable<TaskFinalizationOptions['commentSync']> = async () => {
    commentCalls += 1;
    commentSnapshots.push(fs.readFileSync(path.join(f.repoRoot, '.agents', 'workspace', 'completed', TASK_ID, 'task.md'), 'utf8'));
    return platformResult(commentCalls === 1 ? 'applied' : 'no-op');
  };
  const verify: NonNullable<TaskFinalizationOptions['verify']> = async () => {
    verifyCalls += 1;
    return verification(verifyCalls === 1 ? 'fail' : 'pass');
  };
  try {
    const failed = await applyTaskFinalization(request, options(f.repoRoot, commentSync, verify));
    const recovered = await applyTaskFinalization(request, options(f.repoRoot, commentSync, verify));
    const replay = await applyTaskFinalization(request, options(f.repoRoot, commentSync, verify));
    assert.equal(failed.status, 'completed');
    assert.equal(failed.result, 'completed_with_warnings');
    assert.equal(failed.warnings[0]?.code, 'CHECK_FAILED');
    assert.match(failed.warnings[0]?.message ?? '', /Fix complete-task issues/);
    assert.deepEqual(failed.pendingSteps, ['task-comment', 'verification']);
    assert.equal(recovered.status, 'completed');
    assert.equal(replay.status, 'completed');
    assert.equal(verifyCalls, 2);
    assert.equal(commentCalls, 3);
    assert.doesNotMatch(commentSnapshots[0]!, /CHECK_FAILED/);
    assert.match(commentSnapshots[1]!, /\| CHECK_FAILED \| open \|/);
    assert.match(commentSnapshots[2]!, /\| CHECK_FAILED \| resolved \|/);
  } finally {
    fs.rmSync(f.repoRoot, { recursive: true, force: true });
  }
});

test('host finalization retries only the pending terminal steps after a comment failure', async () => {
  const f = fixture();
  let commentCalls = 0;
  let verifyCalls = 0;
  const commentSync: NonNullable<TaskFinalizationOptions['commentSync']> = async () => {
    commentCalls += 1;
    return commentCalls === 1
      ? platformResult('blocked', { error: { code: 'NETWORK_RETRY', message: 'temporary', retryable: true } })
      : platformResult('no-op');
  };
  const verify: NonNullable<TaskFinalizationOptions['verify']> = async () => {
    verifyCalls += 1;
    return verification('pass');
  };
  try {
    const first = await applyTaskFinalization(request, options(f.repoRoot, commentSync, verify));
    const second = await applyTaskFinalization(request, options(f.repoRoot, commentSync, verify));
    assert.equal(first.status, 'completed');
    assert.equal(first.result, 'completed_with_warnings');
    assert.equal(first.warnings[0]?.code, 'NETWORK_RETRY');
    assert.equal(first.lifecycle?.status, 'applied');
    assert.equal(first.pendingSteps.includes('task-comment'), true);
    assert.equal(second.status, 'completed');
    assert.equal(commentCalls, 2);
    assert.equal(verifyCalls, 1);
    assert.equal(fs.existsSync(path.join(f.repoRoot, '.agents', 'workspace', 'completed', TASK_ID)), true);
    const completed = fs.readFileSync(path.join(f.repoRoot, '.agents', 'workspace', 'completed', TASK_ID, 'task.md'), 'utf8');
    assert.match(completed, /\| NETWORK_RETRY \| resolved \|/);
  } finally {
    fs.rmSync(f.repoRoot, { recursive: true, force: true });
  }
});

test('host finalization projects every stable warning key for a step before resolving projection', async () => {
  const f = fixture();
  let commentCalls = 0;
  const commentSync: NonNullable<TaskFinalizationOptions['commentSync']> = async () => {
    commentCalls += 1;
    if (commentCalls === 1) return platformResult('blocked', { error: { code: 'ERROR_A', message: 'first', retryable: true } });
    if (commentCalls === 2) return platformResult('blocked', { error: { code: 'ERROR_B', message: 'second', retryable: true } });
    return platformResult('no-op');
  };
  const verify: NonNullable<TaskFinalizationOptions['verify']> = async () => verification('pass');
  try {
    await applyTaskFinalization(request, options(f.repoRoot, commentSync, verify));
    await applyTaskFinalization(request, options(f.repoRoot, commentSync, verify));
    const recovered = await applyTaskFinalization(request, options(f.repoRoot, commentSync, verify));
    const completed = fs.readFileSync(path.join(f.repoRoot, '.agents', 'workspace', 'completed', TASK_ID, 'task.md'), 'utf8');
    assert.equal(recovered.result, 'completed');
    assert.match(completed, /\| ERROR_A \| resolved \|/);
    assert.match(completed, /\| ERROR_B \| resolved \|/);
  } finally {
    fs.rmSync(f.repoRoot, { recursive: true, force: true });
  }
});

test('host finalization receipt mutations are lock-bound and scope-safe', async () => {
  const f = fixture();
  const commentSync: NonNullable<TaskFinalizationOptions['commentSync']> = async () => platformResult('blocked', {
    error: { code: 'NETWORK_RETRY', message: 'temporary', retryable: true }
  });
  const verify: NonNullable<TaskFinalizationOptions['verify']> = async () => verification('pass');
  const receiptPath = path.join(f.repoRoot, '.agents', 'workspace', '.task-finalization', `${TASK_ID}.json`);
  try {
    await applyTaskFinalization(request, options(f.repoRoot, commentSync, verify));
    const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')) as TaskFinalizationReceipt;
    const wrongScope = createFinalizationCapability(receipt, 'task-comment');
    assert.throws(
      () => applyFinalizationReceiptMutation(f.repoRoot, receipt, wrongScope, { scope: 'verification', operation: 'succeeded' }),
      (error: any) => error?.code === 'FINALIZATION_SCOPE_INVALID'
    );

    const capability = createFinalizationCapability(receipt, 'task-comment');
    assert.throws(
      () => applyFinalizationReceiptMutation(f.repoRoot, receipt, capability, { scope: 'task-comment', operation: 'succeeded', state: 'pending' } as never),
      (error: any) => error?.code === 'FINALIZATION_SCOPE_INVALID'
    );
    assert.throws(
      () => applyFinalizationReceiptMutation(f.repoRoot, receipt, capability, { scope: 'task-comment', operation: 'succeeded', state: 'done', warnings: [] } as never),
      (error: any) => error?.code === 'FINALIZATION_SCOPE_INVALID'
    );
    const updated = applyFinalizationReceiptMutation(f.repoRoot, receipt, capability, { scope: 'task-comment', operation: 'succeeded', state: 'done' });
    assert.equal(updated.taskComment, 'done');
    const pendingProjection = { ...updated, warningProjection: 'pending' as const };
    fs.writeFileSync(receiptPath, `${JSON.stringify(pendingProjection)}\n`);
    const projectionCapability = createFinalizationCapability(pendingProjection, 'warning-projection');
    const projected = applyFinalizationReceiptMutation(f.repoRoot, pendingProjection, projectionCapability, { scope: 'warning-projection', operation: 'succeeded' });
    assert.equal(projected.warningProjection, 'done');
    assert.throws(
      () => applyFinalizationReceiptMutation(f.repoRoot, receipt, capability, { scope: 'task-comment', operation: 'succeeded', state: 'done' }),
      (error: any) => error?.code === 'FINALIZATION_CAPABILITY_STALE'
    );
  } finally {
    fs.rmSync(f.repoRoot, { recursive: true, force: true });
  }
});

test('host finalization rejects capability mutations for active tasks', async () => {
  const f = fixture();
  const preflight: NonNullable<TaskFinalizationOptions['preflight']> = async () => verification('fail');
  const receiptPath = path.join(f.repoRoot, '.agents', 'workspace', '.task-finalization', `${TASK_ID}.json`);
  try {
    await applyTaskFinalization(request, {
      ...options(f.repoRoot, async () => platformResult('no-op'), async () => verification('pass')),
      preflight
    });
    const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')) as TaskFinalizationReceipt;
    const capability = createFinalizationCapability(receipt, 'task-comment');
    assert.throws(
      () => applyFinalizationReceiptMutation(f.repoRoot, receipt, capability, { scope: 'task-comment', operation: 'succeeded', state: 'done' }),
      (error: any) => error?.code === 'FINALIZATION_SCOPE_INVALID'
    );
  } finally {
    fs.rmSync(f.repoRoot, { recursive: true, force: true });
  }
});

test('host finalization fails closed when the canonical short-id registry is unavailable', async () => {
  const mutations: Array<[string, (registryPath: string) => void]> = [
    ['missing', (registryPath) => fs.unlinkSync(registryPath)],
    ['malformed JSON', (registryPath) => fs.writeFileSync(registryPath, '{not-json\n')],
    ['invalid schema', (registryPath) => fs.writeFileSync(registryPath, JSON.stringify({ version: 1, ids: [] }))]
  ];

  for (const [label, mutate] of mutations) {
    const f = fixture();
    const commentSync: NonNullable<TaskFinalizationOptions['commentSync']> = async () => platformResult('no-op');
    const verify: NonNullable<TaskFinalizationOptions['verify']> = async () => verification('pass');
    const registryPath = path.join(f.repoRoot, '.agents', 'workspace', 'active', '.short-ids.json');
    try {
      const first = await applyTaskFinalization(request, options(f.repoRoot, commentSync, verify));
      mutate(registryPath);
      const replay = await applyTaskFinalization(request, options(f.repoRoot, commentSync, verify));
      assert.equal(first.status, 'completed', label);
      assert.equal(replay.status, 'failed', label);
      assert.equal(replay.error?.code, 'TASK_FINALIZATION_SHORT_ID_REGISTRY_UNAVAILABLE', label);
      assert.equal(replay.lifecycle?.status, 'failed', label);
      assert.equal(replay.pendingSteps.includes('lifecycle'), true, label);
      const receipt = fs.readFileSync(path.join(f.repoRoot, '.agents', 'workspace', '.task-finalization', `${TASK_ID}.json`), 'utf8');
      assert.equal(JSON.stringify(replay).includes(f.repoRoot), false, label);
      assert.equal(receipt.includes(f.repoRoot), false, label);
    } finally {
      fs.rmSync(f.repoRoot, { recursive: true, force: true });
    }
  }
});
