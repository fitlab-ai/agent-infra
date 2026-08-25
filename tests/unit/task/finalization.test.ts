import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { platformResult } from '../../../lib/platform/types.ts';
import {
  applyTaskFinalization,
  type TaskFinalizationOptions,
  type TaskFinalizationRequest
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
    'assigned_to: codex', 'updated_at: old', 'agent_infra_version: old', 'target_date:', '---',
    '', '# Task', '', '## Activity Log', ''
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

test('host finalization uses the canonical root and makes a successful replay a no-op', () => {
  const f = fixture();
  let commentCalls = 0;
  let verifyCalls = 0;
  const commentSync: NonNullable<TaskFinalizationOptions['commentSync']> = (_taskRef, received) => {
    commentCalls += 1;
    assert.equal(received.cwd, f.repoRoot);
    return platformResult(commentCalls === 1 ? 'applied' : 'no-op');
  };
  const verify: NonNullable<TaskFinalizationOptions['verify']> = (received, receivedOptions) => {
    verifyCalls += 1;
    assert.deepEqual(received, { taskRef: TASK_ID, event: 'complete-task.completed' });
    assert.equal(receivedOptions?.repoRoot, f.repoRoot);
    return verification('pass');
  };
  try {
    const first = applyTaskFinalization(request, options(f.repoRoot, commentSync, verify));
    const second = applyTaskFinalization(request, options(f.repoRoot, commentSync, verify));
    assert.equal(first.status, 'completed');
    assert.equal(second.status, 'completed');
    assert.equal(commentCalls, 2);
    assert.equal(verifyCalls, 2);
    assert.equal(second.taskComment?.status, 'no-op');
    assert.equal(fs.existsSync(path.join(f.repoRoot, '.agents', 'workspace', 'completed', TASK_ID, 'task.md')), true);
    assert.equal((fs.readFileSync(path.join(f.repoRoot, '.agents', 'workspace', 'completed', TASK_ID, 'task.md'), 'utf8').match(/Complete Task/g) ?? []).length, 2);
  } finally {
    fs.rmSync(f.repoRoot, { recursive: true, force: true });
  }
});

test('host finalization revalidates canonical steps when the receipt is absent', () => {
  const f = fixture();
  let commentCalls = 0;
  let verifyCalls = 0;
  const commentSync: NonNullable<TaskFinalizationOptions['commentSync']> = () => {
    commentCalls += 1;
    return platformResult(commentCalls === 1 ? 'applied' : 'no-op');
  };
  const verify: NonNullable<TaskFinalizationOptions['verify']> = () => {
    verifyCalls += 1;
    return verification('pass');
  };
  try {
    const first = applyTaskFinalization(request, options(f.repoRoot, commentSync, verify));
    fs.rmSync(path.join(f.repoRoot, '.agents', 'workspace', '.task-finalization', `${TASK_ID}.json`));
    const second = applyTaskFinalization(request, options(f.repoRoot, commentSync, verify));
    assert.equal(first.status, 'completed');
    assert.equal(second.status, 'completed');
    assert.equal(second.lifecycle?.status, 'no-op');
    assert.equal(commentCalls, 2);
    assert.equal(verifyCalls, 2);
  } finally {
    fs.rmSync(f.repoRoot, { recursive: true, force: true });
  }
});

test('host finalization returns actionable verification gate failures and retries them', () => {
  const f = fixture();
  let verifyCalls = 0;
  const commentSync: NonNullable<TaskFinalizationOptions['commentSync']> = () => platformResult('no-op');
  const verify: NonNullable<TaskFinalizationOptions['verify']> = () => {
    verifyCalls += 1;
    return verification(verifyCalls === 2 ? 'fail' : 'pass');
  };
  try {
    const first = applyTaskFinalization(request, options(f.repoRoot, commentSync, verify));
    const failed = applyTaskFinalization(request, options(f.repoRoot, commentSync, verify));
    const recovered = applyTaskFinalization(request, options(f.repoRoot, commentSync, verify));
    assert.equal(first.status, 'completed');
    assert.equal(failed.status, 'failed');
    assert.equal(failed.error?.code, 'CHECK_FAILED');
    assert.match(failed.error?.message ?? '', /Fix complete-task issues/);
    assert.deepEqual(failed.pendingSteps, ['verification']);
    assert.equal(recovered.status, 'completed');
    assert.equal(verifyCalls, 3);
  } finally {
    fs.rmSync(f.repoRoot, { recursive: true, force: true });
  }
});

test('host finalization retries only the pending terminal steps after a comment failure', () => {
  const f = fixture();
  let commentCalls = 0;
  let verifyCalls = 0;
  const commentSync: NonNullable<TaskFinalizationOptions['commentSync']> = () => {
    commentCalls += 1;
    return commentCalls === 1
      ? platformResult('blocked', { error: { code: 'NETWORK_RETRY', message: 'temporary', retryable: true } })
      : platformResult('no-op');
  };
  const verify: NonNullable<TaskFinalizationOptions['verify']> = () => {
    verifyCalls += 1;
    return verification('pass');
  };
  try {
    const first = applyTaskFinalization(request, options(f.repoRoot, commentSync, verify));
    const second = applyTaskFinalization(request, options(f.repoRoot, commentSync, verify));
    assert.equal(first.status, 'blocked');
    assert.equal(first.lifecycle?.status, 'applied');
    assert.equal(first.pendingSteps.includes('task-comment'), true);
    assert.equal(second.status, 'completed');
    assert.equal(commentCalls, 2);
    assert.equal(verifyCalls, 1);
    assert.equal(fs.existsSync(path.join(f.repoRoot, '.agents', 'workspace', 'completed', TASK_ID)), true);
  } finally {
    fs.rmSync(f.repoRoot, { recursive: true, force: true });
  }
});

test('host finalization fails closed when the canonical short-id registry is unavailable', () => {
  const mutations: Array<[string, (registryPath: string) => void]> = [
    ['missing', (registryPath) => fs.unlinkSync(registryPath)],
    ['malformed JSON', (registryPath) => fs.writeFileSync(registryPath, '{not-json\n')],
    ['invalid schema', (registryPath) => fs.writeFileSync(registryPath, JSON.stringify({ version: 1, ids: [] }))]
  ];

  for (const [label, mutate] of mutations) {
    const f = fixture();
    const commentSync: NonNullable<TaskFinalizationOptions['commentSync']> = () => platformResult('no-op');
    const verify: NonNullable<TaskFinalizationOptions['verify']> = () => verification('pass');
    const registryPath = path.join(f.repoRoot, '.agents', 'workspace', 'active', '.short-ids.json');
    try {
      const first = applyTaskFinalization(request, options(f.repoRoot, commentSync, verify));
      mutate(registryPath);
      const replay = applyTaskFinalization(request, options(f.repoRoot, commentSync, verify));
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
