import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { onPlatforms } from '../../helpers.ts';
import { platformResult } from '../../../lib/platform/types.ts';
import { inspectCompletionBackfillEligibility } from '../../../lib/platform/completion-backfill.ts';
import {
  applyFinalizationReceiptMutation,
  applyTaskFinalization,
  bindTaskFinalizationReceipt,
  commitPreparedTaskFinalization,
  createFinalizationCapability,
  prepareTaskFinalization,
  readTaskFinalizationReceipt,
  terminalResult,
  type TaskFinalizationOptions,
  type TaskFinalizationRequest,
  type TaskFinalizationReceipt
} from '../../../lib/task/finalization.ts';
import {
  finalizationHandoffPath,
  publishTaskFinalizationHandoff,
  readTaskFinalizationHandoff
} from '../../../lib/task/finalization-handoff.ts';
import { applyTaskLifecycle } from '../../../lib/task/lifecycle.ts';
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
    '---', `id: ${TASK_ID}`, 'platform_issue_identity: \'{"kind":"number","value":42}\'', 'status: active', 'current_step: code-review',
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

function verificationChecks(status: 'pass' | 'fail' | 'blocked', target = 'artifact'): TaskVerificationResult {
  const payload = {
    gate: status,
    checks: [{ checkId: target, status, effectiveStatus: status, reason: `CHECK_${status.toUpperCase()}`, message: `${target} ${status}`, action: 're-run verification' }]
  };
  return {
    status, changed: false, event: 'complete-task.completed', requestRef: TASK_ID, taskId: TASK_ID,
    taskDir: `/completed/${TASK_ID}`, taskState: 'completed', skill: 'complete-task', mode: 'gate', artifact: null,
    invocations: [{ status, exitCode: ({ pass: 0, fail: 1, blocked: 2 } as const)[status], payload }], error: null
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
    backfill: async () => platformResult('no-op') as any,
    commentSync,
    verify
  };
}

const request: TaskFinalizationRequest = { taskRef: TASK_ID, intent: 'complete', agent: 'codex' };

test('completion backfill eligibility accepts only structured artifact warnings with controlled identities', () => {
  const f = fixture();
  const taskMd = path.join(f.taskDir, 'task.md');
  const warningTable = (message: string, step = 'complete-task') => [
    '## Workflow Warnings', '',
    '| id | time | step | severity | code | status | target | message | action | resolved_at | resolution |',
    '|----|------|------|----------|------|--------|--------|---------|--------|-------------|------------|',
    `| WW-1 | 2026-08-07 09:00:00+08:00 | ${step} | ACTION_REQUIRED | COMMENT_SYNC_FAILED | open | artifact | ${message} | retry |  |  |`,
    ''
  ].join('\n');
  try {
    assert.deepEqual(inspectCompletionBackfillEligibility(TASK_ID, { cwd: f.repoRoot }), {
      status: 'ready', eligible: false, error: null
    });
    fs.writeFileSync(path.join(f.taskDir, 'analysis.md'), '# analysis\n');
    fs.appendFileSync(taskMd, warningTable('analysis.md sync failed'));
    assert.equal(inspectCompletionBackfillEligibility(TASK_ID, { cwd: f.repoRoot }).eligible, true);

    fs.rmSync(path.join(f.taskDir, 'analysis.md'));
    fs.mkdirSync(path.join(f.taskDir, 'analysis.md'));
    assert.equal(inspectCompletionBackfillEligibility(TASK_ID, { cwd: f.repoRoot }).status, 'failed');

    fs.rmSync(path.join(f.taskDir, 'analysis.md'), { recursive: true });
    assert.equal(inspectCompletionBackfillEligibility(TASK_ID, { cwd: f.repoRoot }).status, 'failed');

    fs.writeFileSync(path.join(f.taskDir, 'analysis.md'), '# analysis\n');

    fs.writeFileSync(path.join(f.taskDir, 'pr-review.md'), '# review\n');
    fs.writeFileSync(taskMd, fs.readFileSync(taskMd, 'utf8').replace('analysis.md sync failed', 'unsupported pr-review.md'));
    assert.equal(inspectCompletionBackfillEligibility(TASK_ID, { cwd: f.repoRoot }).eligible, true);

    fs.writeFileSync(taskMd, fs.readFileSync(taskMd, 'utf8').replace('unsupported pr-review.md', 'analysis.md sync failed').replace('| complete-task |', '| issue-sync |'));
    assert.equal(inspectCompletionBackfillEligibility(TASK_ID, { cwd: f.repoRoot }).eligible, false);
    assert.equal(inspectCompletionBackfillEligibility('TASK-20990101-000000', { cwd: f.repoRoot }).status, 'failed');
  } finally {
    fs.rmSync(f.repoRoot, { recursive: true, force: true });
  }
});

test('completion backfill eligibility rejects a referenced artifact symlink', onPlatforms('linux', 'darwin'), () => {
  const f = fixture();
  const taskMd = path.join(f.taskDir, 'task.md');
  try {
    fs.symlinkSync('task.md', path.join(f.taskDir, 'analysis.md'));
    fs.appendFileSync(taskMd, [
      '## Workflow Warnings', '',
      '| id | time | step | severity | code | status | target | message | action | resolved_at | resolution |',
      '|----|------|------|----------|------|--------|--------|---------|--------|-------------|------------|',
      '| WW-1 | 2026-08-07 09:00:00+08:00 | complete-task | ACTION_REQUIRED | COMMENT_SYNC_FAILED | open | artifact | analysis.md sync failed | retry |  |  |',
      ''
    ].join('\n'));

    const eligibility = inspectCompletionBackfillEligibility(TASK_ID, { cwd: f.repoRoot });
    assert.equal(eligibility.status, 'failed');
    assert.equal(eligibility.error?.code, 'ARTIFACT_TOPOLOGY_CONFLICT');
  } finally {
    fs.rmSync(f.repoRoot, { recursive: true, force: true });
  }
});

test('host finalization waits for completion backfill before lifecycle and repeats the idempotent check on replay', async () => {
  const f = fixture();
  const staged = 'Delivered summary.\n';
  fs.writeFileSync(path.join(f.taskDir, '.delivery-summary.json'), `${JSON.stringify({
    taskId: TASK_ID, body: staged, sha256: createHash('sha256').update(staged).digest('hex')
  })}\n`);
  const calls: string[] = [];
  const backfill: NonNullable<TaskFinalizationOptions['backfill']> = async () => {
    calls.push('backfill');
    return platformResult('no-op') as any;
  };
  const commentSync: NonNullable<TaskFinalizationOptions['commentSync']> = async (_taskRef, received) => {
    calls.push(received.kind);
    return platformResult('no-op');
  };
  try {
    const first = await applyTaskFinalization(request, { ...options(f.repoRoot, commentSync, async () => verification('pass')), backfill });
    const replay = await applyTaskFinalization(request, { ...options(f.repoRoot, commentSync, async () => verification('pass')), backfill });
    assert.equal(first.result, 'completed');
    assert.equal(replay.result, 'completed');
    assert.deepEqual(calls, ['backfill', 'task', 'summary']);
  } finally {
    fs.rmSync(f.repoRoot, { recursive: true, force: true });
  }
});

test('host finalization stops before lifecycle when completion backfill has no successful terminal result', async () => {
  const f = fixture();
  let commentCalls = 0;
  let verifyCalls = 0;
  const backfill: NonNullable<TaskFinalizationOptions['backfill']> = async () => platformResult('blocked', {
    error: { code: 'BACKFILL_PENDING', message: 'accepted operation has no terminal result', retryable: true }
  }) as any;
  try {
    const result = await applyTaskFinalization(request, {
      ...options(
        f.repoRoot,
        async () => { commentCalls += 1; return platformResult('no-op'); },
        async () => { verifyCalls += 1; return verification('pass'); }
      ),
      backfill
    });
    assert.equal(result.status, 'blocked');
    assert.equal(result.lifecycle, null);
    assert.equal(result.error?.code, 'BACKFILL_PENDING');
    assert.equal(commentCalls, 0);
    assert.equal(verifyCalls, 0);
    assert.equal(fs.existsSync(path.join(f.repoRoot, '.agents', 'workspace', 'active', TASK_ID, 'task.md')), true);
  } finally {
    fs.rmSync(f.repoRoot, { recursive: true, force: true });
  }
});

test('completed finalization does not replay lifecycle for a backfill warning', async () => {
  const f = fixture();
  let calls = 0;
  const backfill: NonNullable<TaskFinalizationOptions['backfill']> = async () => {
    calls += 1;
    return calls === 1 ? platformResult('no-op') as any : platformResult('blocked', {
      error: { code: 'BACKFILL_PENDING', message: 'retry later', retryable: true }
    }) as any;
  };
  try {
    await applyTaskFinalization(request, {
      ...options(f.repoRoot, async () => platformResult('no-op'), async () => verification('pass')), backfill
    });
    const receiptPath = path.join(f.repoRoot, '.agents', 'workspace', '.task-finalization', `${TASK_ID}.json`);
    const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')) as TaskFinalizationReceipt;
    fs.writeFileSync(receiptPath, `${JSON.stringify({
      ...receipt,
      warnings: [{ code: 'BACKFILL_PENDING', message: 'retry later', retryable: true, step: 'backfill', target: 'artifact', severity: 'ACTION_REQUIRED', status: 'open', resolvedAt: null }]
    })}\n`);

    const retry = await applyTaskFinalization(request, {
      ...options(f.repoRoot, async () => platformResult('no-op'), async () => verification('pass')), backfill
    });
    assert.equal(retry.result, 'completed');
    assert.equal(retry.lifecycle, null);
    assert.equal(retry.warnings.some((warning) => warning.step === 'backfill'), true);
  } finally {
    fs.rmSync(f.repoRoot, { recursive: true, force: true });
  }
});

test('completed finalization schedules backfill from an eligible task artifact warning', async () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.taskDir, 'analysis.md'), '# analysis\n');
  const staged = 'Delivered summary.\n';
  fs.writeFileSync(path.join(f.taskDir, '.delivery-summary.json'), `${JSON.stringify({
    taskId: TASK_ID, body: staged, sha256: createHash('sha256').update(staged).digest('hex')
  })}\n`);
  let backfillCalls = 0;
  const backfill: NonNullable<TaskFinalizationOptions['backfill']> = async () => {
    backfillCalls += 1;
    return platformResult('no-op') as any;
  };
  try {
    await applyTaskFinalization(request, {
      ...options(f.repoRoot, async () => platformResult('no-op'), async () => verification('pass')), backfill
    });
    const taskMd = path.join(f.repoRoot, '.agents', 'workspace', 'completed', TASK_ID, 'task.md');
    const content = fs.readFileSync(taskMd, 'utf8');
    fs.writeFileSync(taskMd, content.replace('## Activity Log', [
      '## Workflow Warnings', '',
      '| id | time | step | severity | code | status | target | message | action | resolved_at | resolution |',
      '|----|------|------|----------|------|--------|--------|---------|--------|-------------|------------|',
      '| WW-1 | 2026-08-07 09:00:00+08:00 | complete-task | ACTION_REQUIRED | COMMENT_SYNC_FAILED | open | artifact | analysis.md sync failed | retry |  |  |',
      '', '## Activity Log'
    ].join('\n')));

    const replay = await applyTaskFinalization(request, {
      ...options(f.repoRoot, async () => platformResult('no-op'), async () => verification('pass')), backfill
    });
    assert.equal(replay.status, 'completed');
    assert.equal(backfillCalls, 2);
  } finally {
    fs.rmSync(f.repoRoot, { recursive: true, force: true });
  }
});

test('completed finalization fails closed when an artifact warning references a symlink', onPlatforms('linux', 'darwin'), async () => {
  const f = fixture();
  const staged = 'Delivered summary.\n';
  fs.writeFileSync(path.join(f.taskDir, '.delivery-summary.json'), `${JSON.stringify({
    taskId: TASK_ID, body: staged, sha256: createHash('sha256').update(staged).digest('hex')
  })}\n`);
  let backfillCalls = 0;
  let verifyCalls = 0;
  const backfill: NonNullable<TaskFinalizationOptions['backfill']> = async () => {
    backfillCalls += 1;
    return platformResult('no-op') as any;
  };
  try {
    await applyTaskFinalization(request, {
      ...options(f.repoRoot, async () => platformResult('no-op'), async () => { verifyCalls += 1; return verification('pass'); }), backfill
    });
    const taskDir = path.join(f.repoRoot, '.agents', 'workspace', 'completed', TASK_ID);
    const taskMd = path.join(taskDir, 'task.md');
    fs.symlinkSync('task.md', path.join(taskDir, 'analysis.md'));
    fs.writeFileSync(taskMd, fs.readFileSync(taskMd, 'utf8').replace('## Activity Log', [
      '## Workflow Warnings', '',
      '| id | time | step | severity | code | status | target | message | action | resolved_at | resolution |',
      '|----|------|------|----------|------|--------|--------|---------|--------|-------------|------------|',
      '| WW-1 | 2026-08-07 09:00:00+08:00 | complete-task | ACTION_REQUIRED | COMMENT_SYNC_FAILED | open | artifact | analysis.md sync failed | retry |  |  |',
      '', '## Activity Log'
    ].join('\n')));

    const replay = await applyTaskFinalization(request, {
      ...options(f.repoRoot, async () => platformResult('no-op'), async () => { verifyCalls += 1; return verification('pass'); }), backfill
    });
    assert.equal(replay.status, 'failed');
    assert.equal(replay.error?.code, 'ARTIFACT_TOPOLOGY_CONFLICT');
    assert.equal(replay.lifecycle, null);
    assert.equal(backfillCalls, 1);
    assert.equal(verifyCalls, 1);
  } finally {
    fs.rmSync(f.repoRoot, { recursive: true, force: true });
  }
});

test('completed finalization keeps deterministic backfill errors fail-closed', async () => {
  const f = fixture();
  let backfillCalls = 0;
  const backfill: NonNullable<TaskFinalizationOptions['backfill']> = async () => {
    backfillCalls += 1;
    return backfillCalls === 1 ? platformResult('no-op') as any : platformResult('failed', {
      error: { code: 'ARTIFACT_TOPOLOGY_CONFLICT', message: 'invalid topology', retryable: false }
    }) as any;
  };
  try {
    await applyTaskFinalization(request, {
      ...options(f.repoRoot, async () => platformResult('no-op'), async () => verification('pass')), backfill
    });
    const receiptPath = path.join(f.repoRoot, '.agents', 'workspace', '.task-finalization', `${TASK_ID}.json`);
    const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')) as TaskFinalizationReceipt;
    fs.writeFileSync(receiptPath, `${JSON.stringify({
      ...receipt,
      warnings: [{ code: 'BACKFILL_PENDING', message: 'retry', retryable: true, step: 'backfill', target: 'artifact', severity: 'ACTION_REQUIRED', status: 'open', resolvedAt: null }]
    })}\n`);

    const replay = await applyTaskFinalization(request, {
      ...options(f.repoRoot, async () => platformResult('no-op'), async () => verification('pass')), backfill
    });
    assert.equal(replay.status, 'failed');
    assert.equal(replay.result, 'failed');
    assert.equal(replay.error?.code, 'ARTIFACT_TOPOLOGY_CONFLICT');
    assert.equal(replay.completedSteps.includes('lifecycle'), true);
  } finally {
    fs.rmSync(f.repoRoot, { recursive: true, force: true });
  }
});

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

test('host finalization rejects an inconsistent copied-back lifecycle journal without side effects', async () => {
  const f = fixture();
  const binding = { generation: 'sandbox-generation', requestId: '0123456789abcdef0123456789abcdef' };
  const commentSync: NonNullable<TaskFinalizationOptions['commentSync']> = async () => platformResult('no-op');
  const verify: NonNullable<TaskFinalizationOptions['verify']> = async () => verification('pass');
  try {
    assert.equal((await prepareTaskFinalization(request, options(f.repoRoot, commentSync, verify))).status, 'prepared');
    bindTaskFinalizationReceipt(f.repoRoot, TASK_ID, binding);
    const interrupted = applyTaskLifecycle(request, {
      repoRoot: f.repoRoot, metadataProvider: () => METADATA,
      directoryRenameSync: () => { throw new Error('injected directory rename failure'); }
    });
    assert.equal(interrupted.status, 'failed');
    const journalPath = path.join(f.taskDir, '.task-lifecycle.json');
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as { completedSteps: string[] };
    journal.completedSteps.push('directory-moved');
    fs.writeFileSync(journalPath, `${JSON.stringify(journal)}\n`);

    const result = await commitPreparedTaskFinalization(
      request,
      { ...options(f.repoRoot, commentSync, verify), controlBinding: binding }
    );
    assert.equal(result.status, 'failed');
    assert.equal(result.error?.code, 'TASK_FINALIZATION_RECOVERY_PROOF_UNAVAILABLE');
    assert.equal(fs.existsSync(f.taskDir), true);
    assert.equal(fs.existsSync(path.join(f.repoRoot, '.agents', 'workspace', 'completed', TASK_ID)), false);
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(f.repoRoot, '.agents', 'workspace', 'active', '.short-ids.json'), 'utf8')).ids,
      { '01': TASK_ID }
    );
  } finally {
    fs.rmSync(f.repoRoot, { recursive: true, force: true });
  }
});

test('host finalization rejects a journal that claims a retained short id was released', async () => {
  const f = fixture();
  const binding = { generation: 'sandbox-generation', requestId: '0123456789abcdef0123456789abcdef' };
  const commentSync: NonNullable<TaskFinalizationOptions['commentSync']> = async () => platformResult('no-op');
  const verify: NonNullable<TaskFinalizationOptions['verify']> = async () => verification('pass');
  try {
    assert.equal((await prepareTaskFinalization(request, options(f.repoRoot, commentSync, verify))).status, 'prepared');
    bindTaskFinalizationReceipt(f.repoRoot, TASK_ID, binding);
    const interrupted = applyTaskLifecycle(request, {
      repoRoot: f.repoRoot, metadataProvider: () => METADATA,
      directoryRenameSync: () => { throw new Error('injected directory rename failure'); }
    });
    assert.equal(interrupted.status, 'failed');
    const targetDir = path.join(f.repoRoot, '.agents', 'workspace', 'completed', TASK_ID);
    fs.mkdirSync(path.dirname(targetDir), { recursive: true });
    fs.renameSync(f.taskDir, targetDir);
    const journalPath = path.join(targetDir, '.task-lifecycle.json');
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as { completedSteps: string[] };
    journal.completedSteps.push('directory-moved', 'registry-committed');
    fs.writeFileSync(journalPath, `${JSON.stringify(journal)}\n`);

    const result = await commitPreparedTaskFinalization(
      request,
      { ...options(f.repoRoot, commentSync, verify), controlBinding: binding }
    );
    assert.equal(result.status, 'failed');
    assert.equal(result.error?.code, 'TASK_FINALIZATION_RECOVERY_PROOF_UNAVAILABLE');
    assert.deepEqual(readTaskFinalizationReceipt(f.repoRoot, TASK_ID)?.lastError, null);
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(f.repoRoot, '.agents', 'workspace', 'active', '.short-ids.json'), 'utf8')).ids,
      { '01': TASK_ID }
    );
  } finally {
    fs.rmSync(f.repoRoot, { recursive: true, force: true });
  }
});

test('host imports a sandbox-prepared receipt only when its handoff is bound to the current request', async () => {
  const sandbox = fixture();
  const host = fixture();
  const handoff = fs.mkdtempSync(path.join(os.tmpdir(), 'task-finalization-handoff-'));
  const binding = { generation: 'sandbox-generation', requestId: '0123456789abcdef0123456789abcdef' };
  const commentSync: NonNullable<TaskFinalizationOptions['commentSync']> = async () => platformResult('no-op');
  const verify: NonNullable<TaskFinalizationOptions['verify']> = async () => verification('pass');
  try {
    const prepared = await prepareTaskFinalization(request, options(sandbox.repoRoot, commentSync, verify));
    assert.equal(prepared.status, 'prepared');
    const receipt = bindTaskFinalizationReceipt(sandbox.repoRoot, TASK_ID, binding);
    const handoffSha256 = publishTaskFinalizationHandoff(handoff, receipt, binding);
    const result = await commitPreparedTaskFinalization(
      { ...request, handoffSha256 },
      { ...options(host.repoRoot, commentSync, verify), controlBinding: binding, handoffDirectory: handoff }
    );
    assert.equal(result.status, 'completed');
    assert.deepEqual(readTaskFinalizationReceipt(host.repoRoot, TASK_ID)?.controlBinding, binding);
    assert.equal(fs.existsSync(finalizationHandoffPath(handoff, TASK_ID)), false);
  } finally {
    fs.rmSync(sandbox.repoRoot, { recursive: true, force: true });
    fs.rmSync(host.repoRoot, { recursive: true, force: true });
    fs.rmSync(handoff, { recursive: true, force: true });
  }
});

test('host imports a bound handoff after the shared active task has prepared its lifecycle', async () => {
  const sandbox = fixture();
  const host = fixture();
  const handoff = fs.mkdtempSync(path.join(os.tmpdir(), 'task-finalization-handoff-'));
  const binding = { generation: 'sandbox-generation', requestId: '0123456789abcdef0123456789abcdef' };
  const commentSync: NonNullable<TaskFinalizationOptions['commentSync']> = async () => platformResult('no-op');
  const verify: NonNullable<TaskFinalizationOptions['verify']> = async () => verification('pass');
  try {
    assert.equal((await prepareTaskFinalization(request, options(sandbox.repoRoot, commentSync, verify))).status, 'prepared');
    const receipt = bindTaskFinalizationReceipt(sandbox.repoRoot, TASK_ID, binding);
    const handoffSha256 = publishTaskFinalizationHandoff(handoff, receipt, binding);
    fs.copyFileSync(path.join(sandbox.taskDir, 'task.md'), path.join(host.taskDir, 'task.md'));
    fs.copyFileSync(path.join(sandbox.taskDir, '.task-lifecycle.json'), path.join(host.taskDir, '.task-lifecycle.json'));

    const result = await commitPreparedTaskFinalization(
      { ...request, handoffSha256 },
      { ...options(host.repoRoot, commentSync, verify), controlBinding: binding, handoffDirectory: handoff }
    );
    assert.equal(result.status, 'completed');
    assert.deepEqual(readTaskFinalizationReceipt(host.repoRoot, TASK_ID)?.controlBinding, binding);
    assert.equal(fs.existsSync(finalizationHandoffPath(handoff, TASK_ID)), false);
  } finally {
    fs.rmSync(sandbox.repoRoot, { recursive: true, force: true });
    fs.rmSync(host.repoRoot, { recursive: true, force: true });
    fs.rmSync(handoff, { recursive: true, force: true });
  }
});

test('host rejects a handoff with a different binding before finalization side effects', async () => {
  const sandbox = fixture();
  const host = fixture();
  const handoff = fs.mkdtempSync(path.join(os.tmpdir(), 'task-finalization-handoff-'));
  const published = { generation: 'sandbox-generation', requestId: '0123456789abcdef0123456789abcdef' };
  const requested = { generation: 'sandbox-generation', requestId: 'fedcba9876543210fedcba9876543210' };
  const commentSync: NonNullable<TaskFinalizationOptions['commentSync']> = async () => platformResult('no-op');
  const verify: NonNullable<TaskFinalizationOptions['verify']> = async () => verification('pass');
  try {
    await prepareTaskFinalization(request, options(sandbox.repoRoot, commentSync, verify));
    const receipt = bindTaskFinalizationReceipt(sandbox.repoRoot, TASK_ID, published);
    const handoffSha256 = publishTaskFinalizationHandoff(handoff, receipt, published);
    const result = await commitPreparedTaskFinalization(
      { ...request, handoffSha256 },
      { ...options(host.repoRoot, commentSync, verify), controlBinding: requested, handoffDirectory: handoff }
    );
    assert.equal(result.status, 'failed');
    assert.equal(result.error?.code, 'TASK_FINALIZATION_HANDOFF_INVALID');
    assert.equal(fs.existsSync(path.join(host.repoRoot, '.agents', 'workspace', 'completed', TASK_ID)), false);
  } finally {
    fs.rmSync(sandbox.repoRoot, { recursive: true, force: true });
    fs.rmSync(host.repoRoot, { recursive: true, force: true });
    fs.rmSync(handoff, { recursive: true, force: true });
  }
});

test('host rebinds an imported pending receipt after a failed pre-lifecycle commit', async () => {
  const sandbox = fixture();
  const host = fixture();
  const handoff = fs.mkdtempSync(path.join(os.tmpdir(), 'task-finalization-handoff-'));
  const oldBinding = { generation: 'sandbox-generation', requestId: '0123456789abcdef0123456789abcdef' };
  const newBinding = { generation: oldBinding.generation, requestId: 'fedcba9876543210fedcba9876543210' };
  const commentSync: NonNullable<TaskFinalizationOptions['commentSync']> = async () => platformResult('no-op');
  const verify: NonNullable<TaskFinalizationOptions['verify']> = async () => verification('pass');
  try {
    await prepareTaskFinalization(request, options(sandbox.repoRoot, commentSync, verify));
    const oldReceipt = bindTaskFinalizationReceipt(sandbox.repoRoot, TASK_ID, oldBinding);
    const oldDigest = publishTaskFinalizationHandoff(handoff, oldReceipt, oldBinding);
    const registryPath = path.join(host.repoRoot, '.agents', 'workspace', 'active', '.short-ids.json');
    fs.writeFileSync(registryPath, 'invalid json');
    const first = await commitPreparedTaskFinalization(
      { ...request, handoffSha256: oldDigest },
      { ...options(host.repoRoot, commentSync, verify), controlBinding: oldBinding, handoffDirectory: handoff }
    );
    assert.equal(first.status, 'failed');
    assert.deepEqual(readTaskFinalizationReceipt(host.repoRoot, TASK_ID)?.controlBinding, oldBinding);
    fs.writeFileSync(registryPath, `${JSON.stringify({ version: 1, ids: { '01': TASK_ID } })}\n`);
    const newReceipt = bindTaskFinalizationReceipt(sandbox.repoRoot, TASK_ID, newBinding);
    const newDigest = publishTaskFinalizationHandoff(handoff, newReceipt, newBinding);
    const retry = await commitPreparedTaskFinalization(
      { ...request, handoffSha256: newDigest },
      { ...options(host.repoRoot, commentSync, verify), controlBinding: newBinding, handoffDirectory: handoff }
    );
    assert.equal(retry.status, 'completed', JSON.stringify(retry));
    assert.deepEqual(readTaskFinalizationReceipt(host.repoRoot, TASK_ID)?.controlBinding, newBinding);
    assert.equal(fs.existsSync(finalizationHandoffPath(handoff, TASK_ID)), false);
    assert.equal(fs.existsSync(path.join(host.repoRoot, '.agents', 'workspace', 'completed', TASK_ID)), true);
  } finally {
    fs.rmSync(sandbox.repoRoot, { recursive: true, force: true });
    fs.rmSync(host.repoRoot, { recursive: true, force: true });
    fs.rmSync(handoff, { recursive: true, force: true });
  }
});

test('host resumes a matching lifecycle journal without replacing its old binding', async () => {
  const sandbox = fixture();
  const host = fixture();
  const handoff = fs.mkdtempSync(path.join(os.tmpdir(), 'task-finalization-handoff-'));
  const oldBinding = { generation: 'sandbox-generation', requestId: '0123456789abcdef0123456789abcdef' };
  const newBinding = { generation: oldBinding.generation, requestId: 'fedcba9876543210fedcba9876543210' };
  const commentSync: NonNullable<TaskFinalizationOptions['commentSync']> = async () => platformResult('no-op');
  const verify: NonNullable<TaskFinalizationOptions['verify']> = async () => verification('pass');
  try {
    await prepareTaskFinalization(request, options(sandbox.repoRoot, commentSync, verify));
    const receipt = bindTaskFinalizationReceipt(sandbox.repoRoot, TASK_ID, oldBinding);
    const digest = publishTaskFinalizationHandoff(handoff, receipt, oldBinding);
    const first = await commitPreparedTaskFinalization(
      { ...request, handoffSha256: digest },
      {
        ...options(host.repoRoot, commentSync, verify), controlBinding: oldBinding, handoffDirectory: handoff,
        lifecycle: (input, lifecycleOptions) => applyTaskLifecycle(input, {
          ...lifecycleOptions, directoryRenameSync: () => { throw new Error('injected move interruption'); }
        })
      }
    );
    assert.equal(first.status, 'failed');
    const journalPath = path.join(host.taskDir, '.task-lifecycle.json');
    assert.equal(fs.existsSync(journalPath), true);
    const retry = await commitPreparedTaskFinalization(
      { ...request, handoffSha256: '0'.repeat(64) },
      { ...options(host.repoRoot, commentSync, verify), controlBinding: newBinding, handoffDirectory: handoff }
    );
    assert.equal(retry.status, 'completed', JSON.stringify(retry));
    assert.deepEqual(readTaskFinalizationReceipt(host.repoRoot, TASK_ID)?.controlBinding, oldBinding);
    assert.equal(fs.existsSync(path.join(host.repoRoot, '.agents', 'workspace', 'completed', TASK_ID)), true);
  } finally {
    fs.rmSync(sandbox.repoRoot, { recursive: true, force: true });
    fs.rmSync(host.repoRoot, { recursive: true, force: true });
    fs.rmSync(handoff, { recursive: true, force: true });
  }
});

test('host refuses an otherwise valid handoff with an extra receipt field', async () => {
  const sandbox = fixture();
  const host = fixture();
  const handoff = fs.mkdtempSync(path.join(os.tmpdir(), 'task-finalization-handoff-'));
  const binding = { generation: 'sandbox-generation', requestId: '0123456789abcdef0123456789abcdef' };
  const commentSync: NonNullable<TaskFinalizationOptions['commentSync']> = async () => platformResult('no-op');
  const verify: NonNullable<TaskFinalizationOptions['verify']> = async () => verification('pass');
  try {
    await prepareTaskFinalization(request, options(sandbox.repoRoot, commentSync, verify));
    const receipt = bindTaskFinalizationReceipt(sandbox.repoRoot, TASK_ID, binding);
    const altered = { ...receipt, unexpected: 'field' };
    const digest = publishTaskFinalizationHandoff(handoff, altered, binding);
    const result = await commitPreparedTaskFinalization(
      { ...request, handoffSha256: digest },
      { ...options(host.repoRoot, commentSync, verify), controlBinding: binding, handoffDirectory: handoff }
    );
    assert.equal(result.status, 'failed');
    assert.equal(result.error?.code, 'TASK_FINALIZATION_HANDOFF_INVALID');
    assert.equal(readTaskFinalizationReceipt(host.repoRoot, TASK_ID), null);
  } finally {
    fs.rmSync(sandbox.repoRoot, { recursive: true, force: true });
    fs.rmSync(host.repoRoot, { recursive: true, force: true });
    fs.rmSync(handoff, { recursive: true, force: true });
  }
});

test('host rejects a cross-generation rebind without changing its canonical receipt', async () => {
  const sandbox = fixture();
  const host = fixture();
  const handoff = fs.mkdtempSync(path.join(os.tmpdir(), 'task-finalization-handoff-'));
  const oldBinding = { generation: 'old-generation', requestId: '0123456789abcdef0123456789abcdef' };
  const newBinding = { generation: 'new-generation', requestId: 'fedcba9876543210fedcba9876543210' };
  const commentSync: NonNullable<TaskFinalizationOptions['commentSync']> = async () => platformResult('no-op');
  const verify: NonNullable<TaskFinalizationOptions['verify']> = async () => verification('pass');
  try {
    await prepareTaskFinalization(request, options(sandbox.repoRoot, commentSync, verify));
    const oldDigest = publishTaskFinalizationHandoff(handoff, bindTaskFinalizationReceipt(sandbox.repoRoot, TASK_ID, oldBinding), oldBinding);
    const registryPath = path.join(host.repoRoot, '.agents', 'workspace', 'active', '.short-ids.json');
    fs.writeFileSync(registryPath, 'invalid json');
    await commitPreparedTaskFinalization(
      { ...request, handoffSha256: oldDigest },
      { ...options(host.repoRoot, commentSync, verify), controlBinding: oldBinding, handoffDirectory: handoff }
    );
    fs.writeFileSync(registryPath, `${JSON.stringify({ version: 1, ids: { '01': TASK_ID } })}\n`);
    const newDigest = publishTaskFinalizationHandoff(handoff, bindTaskFinalizationReceipt(sandbox.repoRoot, TASK_ID, newBinding), newBinding);
    const retry = await commitPreparedTaskFinalization(
      { ...request, handoffSha256: newDigest },
      { ...options(host.repoRoot, commentSync, verify), controlBinding: newBinding, handoffDirectory: handoff }
    );
    assert.equal(retry.error?.code, 'TASK_FINALIZATION_RECOVERY_PROOF_UNAVAILABLE');
    assert.deepEqual(readTaskFinalizationReceipt(host.repoRoot, TASK_ID)?.controlBinding, oldBinding);
    assert.equal(fs.existsSync(path.join(host.repoRoot, '.agents', 'workspace', 'completed', TASK_ID)), false);
  } finally {
    fs.rmSync(sandbox.repoRoot, { recursive: true, force: true });
    fs.rmSync(host.repoRoot, { recursive: true, force: true });
    fs.rmSync(handoff, { recursive: true, force: true });
  }
});

test('host refuses rebind when its lifecycle journal is malformed', async () => {
  const sandbox = fixture();
  const host = fixture();
  const handoff = fs.mkdtempSync(path.join(os.tmpdir(), 'task-finalization-handoff-'));
  const oldBinding = { generation: 'sandbox-generation', requestId: '0123456789abcdef0123456789abcdef' };
  const newBinding = { generation: oldBinding.generation, requestId: 'fedcba9876543210fedcba9876543210' };
  const commentSync: NonNullable<TaskFinalizationOptions['commentSync']> = async () => platformResult('no-op');
  const verify: NonNullable<TaskFinalizationOptions['verify']> = async () => verification('pass');
  try {
    await prepareTaskFinalization(request, options(sandbox.repoRoot, commentSync, verify));
    const oldDigest = publishTaskFinalizationHandoff(handoff, bindTaskFinalizationReceipt(sandbox.repoRoot, TASK_ID, oldBinding), oldBinding);
    const registryPath = path.join(host.repoRoot, '.agents', 'workspace', 'active', '.short-ids.json');
    fs.writeFileSync(registryPath, 'invalid json');
    await commitPreparedTaskFinalization(
      { ...request, handoffSha256: oldDigest },
      { ...options(host.repoRoot, commentSync, verify), controlBinding: oldBinding, handoffDirectory: handoff }
    );
    fs.writeFileSync(registryPath, `${JSON.stringify({ version: 1, ids: { '01': TASK_ID } })}\n`);
    fs.writeFileSync(path.join(host.taskDir, '.task-lifecycle.json'), '{"version":1,"taskId":"wrong"}\n');
    const newDigest = publishTaskFinalizationHandoff(handoff, bindTaskFinalizationReceipt(sandbox.repoRoot, TASK_ID, newBinding), newBinding);
    const retry = await commitPreparedTaskFinalization(
      { ...request, handoffSha256: newDigest },
      { ...options(host.repoRoot, commentSync, verify), controlBinding: newBinding, handoffDirectory: handoff }
    );
    assert.equal(retry.error?.code, 'TASK_FINALIZATION_RECOVERY_PROOF_UNAVAILABLE');
    assert.deepEqual(readTaskFinalizationReceipt(host.repoRoot, TASK_ID)?.controlBinding, oldBinding);
    assert.equal(fs.existsSync(path.join(host.repoRoot, '.agents', 'workspace', 'completed', TASK_ID)), false);
  } finally {
    fs.rmSync(sandbox.repoRoot, { recursive: true, force: true });
    fs.rmSync(host.repoRoot, { recursive: true, force: true });
    fs.rmSync(handoff, { recursive: true, force: true });
  }
});

test('host rejects malformed nested receipt fields even with a matching handoff digest', async () => {
  const sandbox = fixture();
  const handoff = fs.mkdtempSync(path.join(os.tmpdir(), 'task-finalization-handoff-'));
  const binding = { generation: 'sandbox-generation', requestId: '0123456789abcdef0123456789abcdef' };
  const commentSync: NonNullable<TaskFinalizationOptions['commentSync']> = async () => platformResult('no-op');
  const verify: NonNullable<TaskFinalizationOptions['verify']> = async () => verification('pass');
  try {
    await prepareTaskFinalization(request, options(sandbox.repoRoot, commentSync, verify));
    const receipt = bindTaskFinalizationReceipt(sandbox.repoRoot, TASK_ID, binding);
    for (const altered of [
      { ...receipt, controlBinding: { ...binding, unexpected: true } },
      { ...receipt, lastError: { code: 'TEST', message: 'test', retryable: false, unexpected: true } }
    ]) {
      const host = fixture();
      try {
        const digest = publishTaskFinalizationHandoff(handoff, altered, binding);
        const result = await commitPreparedTaskFinalization(
          { ...request, handoffSha256: digest },
          { ...options(host.repoRoot, commentSync, verify), controlBinding: binding, handoffDirectory: handoff }
        );
        assert.equal(result.error?.code, 'TASK_FINALIZATION_HANDOFF_INVALID');
        assert.equal(readTaskFinalizationReceipt(host.repoRoot, TASK_ID), null);
      } finally {
        fs.rmSync(host.repoRoot, { recursive: true, force: true });
      }
    }
  } finally {
    fs.rmSync(sandbox.repoRoot, { recursive: true, force: true });
    fs.rmSync(handoff, { recursive: true, force: true });
  }
});

test('handoff cleanup preserves a replacement file', async () => {
  const sandbox = fixture();
  const handoff = fs.mkdtempSync(path.join(os.tmpdir(), 'task-finalization-handoff-'));
  const binding = { generation: 'sandbox-generation', requestId: '0123456789abcdef0123456789abcdef' };
  try {
    await prepareTaskFinalization(request, options(sandbox.repoRoot, async () => platformResult('no-op'), async () => verification('pass')));
    const receipt = bindTaskFinalizationReceipt(sandbox.repoRoot, TASK_ID, binding);
    const digest = publishTaskFinalizationHandoff(handoff, receipt, binding);
    const read = readTaskFinalizationHandoff(handoff, TASK_ID, binding, digest);
    publishTaskFinalizationHandoff(handoff, receipt, binding);
    read.cleanup();
    assert.equal(fs.existsSync(finalizationHandoffPath(handoff, TASK_ID)), true);
  } finally {
    fs.rmSync(sandbox.repoRoot, { recursive: true, force: true });
    fs.rmSync(handoff, { recursive: true, force: true });
  }
});

test('terminal host finalization ignores a conflicting sandbox binding', async () => {
  const f = fixture();
  const commentSync: NonNullable<TaskFinalizationOptions['commentSync']> = async () => platformResult('no-op');
  const verify: NonNullable<TaskFinalizationOptions['verify']> = async () => verification('pass');
  const firstBinding = { generation: 'sandbox-generation', requestId: '0123456789abcdef0123456789abcdef' };
  const conflictingBinding = { generation: 'other-generation', requestId: 'fedcba9876543210fedcba9876543210' };
  try {
    assert.equal((await applyTaskFinalization(request, { ...options(f.repoRoot, commentSync, verify), controlBinding: firstBinding })).status, 'completed');
    const replay = await applyTaskFinalization(request, { ...options(f.repoRoot, commentSync, verify), controlBinding: conflictingBinding });
    assert.equal(replay.status, 'completed');
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
    assert.deepEqual(received, { taskRef: TASK_ID, event: 'complete-task.prepared' });
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
    assert.equal(second.verification, null);
    assert.equal(second.taskComment, null);
    assert.equal(fs.existsSync(path.join(f.repoRoot, '.agents', 'workspace', 'completed', TASK_ID, 'task.md')), true);
    assert.equal((fs.readFileSync(path.join(f.repoRoot, '.agents', 'workspace', 'completed', TASK_ID, 'task.md'), 'utf8').match(/Complete Task/g) ?? []).length, 2);
  } finally {
    fs.rmSync(f.repoRoot, { recursive: true, force: true });
  }
});

test('host finalization seals a staged summary after core verification and retains its retry input', async () => {
  const f = fixture();
  const staged = 'Delivered summary.\n';
  const stagingPath = path.join(f.taskDir, '.delivery-summary.json');
  fs.writeFileSync(stagingPath, `${JSON.stringify({
    taskId: TASK_ID,
    body: staged,
    sha256: createHash('sha256').update(staged).digest('hex')
  })}\n`);
  const kinds: string[] = [];
  const timeline: string[] = [];
  let verifyCalls = 0;
  const commentSync: NonNullable<TaskFinalizationOptions['commentSync']> = async (_taskRef, received) => {
    kinds.push(received.kind);
    timeline.push(received.kind);
    return platformResult('applied');
  };
  const verify: NonNullable<TaskFinalizationOptions['verify']> = async () => {
    verifyCalls += 1;
    timeline.push('verify');
    return verification('pass');
  };
  try {
    const result = await applyTaskFinalization(request, options(f.repoRoot, commentSync, verify));
    const receipt = readTaskFinalizationReceipt(f.repoRoot, TASK_ID);
    assert.equal(result.result, 'completed');
    assert.deepEqual(kinds, ['task', 'summary']);
    assert.deepEqual(timeline, ['verify', 'task', 'summary']);
    assert.equal(verifyCalls, 1);
    assert.equal(receipt?.summary, 'done');
    assert.equal(fs.existsSync(path.join(f.repoRoot, '.agents', 'workspace', 'completed', TASK_ID, '.delivery-summary.json')), true);
  } finally {
    fs.rmSync(f.repoRoot, { recursive: true, force: true });
  }
});

test('host finalization skips terminal verification and summary when no recovery fact is pending', async () => {
  const f = fixture();
  const staged = 'Delivered summary.\n';
  fs.writeFileSync(path.join(f.taskDir, '.delivery-summary.json'), `${JSON.stringify({
    taskId: TASK_ID, body: staged, sha256: createHash('sha256').update(staged).digest('hex')
  })}\n`);
  const kinds: string[] = [];
  let verifyCalls = 0;
  const commentSync: NonNullable<TaskFinalizationOptions['commentSync']> = async (_taskRef, received) => {
    kinds.push(received.kind);
    return platformResult('no-op');
  };
  const verify: NonNullable<TaskFinalizationOptions['verify']> = async () => {
    verifyCalls += 1;
    return verification('pass');
  };
  try {
    assert.equal((await applyTaskFinalization(request, options(f.repoRoot, commentSync, verify))).status, 'completed');
    assert.equal((await applyTaskFinalization(request, options(f.repoRoot, commentSync, verify))).status, 'completed');
    assert.equal(verifyCalls, 1);
    assert.deepEqual(kinds, ['task', 'summary']);
  } finally {
    fs.rmSync(f.repoRoot, { recursive: true, force: true });
  }
});

test('host finalization records a replayed verification exception and recovers on a later pass', async () => {
  const f = fixture();
  const staged = 'Delivered summary.\n';
  fs.writeFileSync(path.join(f.taskDir, '.delivery-summary.json'), `${JSON.stringify({
    taskId: TASK_ID, body: staged, sha256: createHash('sha256').update(staged).digest('hex')
  })}\n`);
  let verifyCalls = 0;
  const verificationEvents: string[] = [];
  const commentSync: NonNullable<TaskFinalizationOptions['commentSync']> = async () => platformResult('no-op');
  const verify: NonNullable<TaskFinalizationOptions['verify']> = async (received) => {
    verifyCalls += 1;
    verificationEvents.push(received.event);
    if (verifyCalls === 2) throw new Error('verification input unavailable');
    return verifyCalls === 3 ? verificationChecks('pass') : verification('pass');
  };
  try {
    const first = await applyTaskFinalization(request, options(f.repoRoot, commentSync, verify));
    const receiptPath = path.join(f.repoRoot, '.agents', 'workspace', '.task-finalization', `${TASK_ID}.json`);
    const completedReceipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')) as TaskFinalizationReceipt;
    fs.writeFileSync(receiptPath, `${JSON.stringify({ ...completedReceipt, verification: 'pending' })}\n`);
    const replay = await applyTaskFinalization(request, options(f.repoRoot, commentSync, verify));
    const replayReceipt = readTaskFinalizationReceipt(f.repoRoot, TASK_ID);
    const recovered = await applyTaskFinalization(request, options(f.repoRoot, commentSync, verify));
    const recoveredReceipt = readTaskFinalizationReceipt(f.repoRoot, TASK_ID);
    assert.equal(first.result, 'completed');
    assert.equal(replay.result, 'completed_with_warnings');
    assert.deepEqual(replay.pendingSteps, ['verification', 'summary']);
    assert.equal(replay.error, null);
    assert.equal(replayReceipt?.verification, 'pending');
    assert.equal(replayReceipt?.warnings.some((warning) => warning.step === 'verification' && warning.code === 'VERIFY_FAILED' && warning.status === 'open'), true);
    assert.equal(recovered.result, 'completed');
    assert.equal(recoveredReceipt?.verification, 'done');
    assert.equal(recoveredReceipt?.warnings.some((warning) => warning.step === 'verification' && warning.status === 'open'), false);
    assert.equal(verifyCalls, 3);
    assert.deepEqual(verificationEvents, ['complete-task.prepared', 'complete-task.completed', 'complete-task.completed']);
  } finally {
    fs.rmSync(f.repoRoot, { recursive: true, force: true });
  }
});

test('host finalization keeps a receipt persistence error blocked when warnings are pending', () => {
  const receipt: TaskFinalizationReceipt = {
    version: 4,
    taskId: TASK_ID,
    intent: 'complete',
    receiptId: 'receipt-1',
    revision: 3,
    lifecycle: 'done',
    taskComment: 'pending',
    verification: 'pending',
    summary: 'pending',
    warningProjection: 'pending',
    warnings: [{
      code: 'VERIFY_FAILED', message: 'verification failed', retryable: true,
      step: 'verification', target: 'complete-task', severity: 'ACTION_REQUIRED', status: 'open', resolvedAt: null
    }],
    updatedAt: '2026-09-18T00:00:00.000Z',
    lastError: null
  };
  const result = terminalResult(TASK_ID, receipt, {}, false, {
    code: 'FINALIZATION_RECEIPT_WRITE_FAILED', message: 'receipt write failed', retryable: true
  });
  assert.equal(result.status, 'blocked');
  assert.equal(result.result, 'blocked');
  assert.equal(result.error?.code, 'FINALIZATION_RECEIPT_WRITE_FAILED');
});

test('host finalization blocks when a warning-state replayed verification failure cannot be persisted', onPlatforms('linux', 'darwin'), async () => {
  const f = fixture();
  const staged = 'Delivered summary.\n';
  const receiptDirectory = path.join(f.repoRoot, '.agents', 'workspace', '.task-finalization');
  fs.writeFileSync(path.join(f.taskDir, '.delivery-summary.json'), `${JSON.stringify({
    taskId: TASK_ID, body: staged, sha256: createHash('sha256').update(staged).digest('hex')
  })}\n`);
  const comments: string[] = [];
  let verifyCalls = 0;
  const commentSync: NonNullable<TaskFinalizationOptions['commentSync']> = async (_taskRef, received) => {
    comments.push(received.kind);
    return platformResult('no-op');
  };
  const verify: NonNullable<TaskFinalizationOptions['verify']> = async () => {
    verifyCalls += 1;
    if (verifyCalls === 2) return verification('fail');
    if (verifyCalls === 3) {
      fs.chmodSync(receiptDirectory, 0o500);
      const error = new Error('terminal verification unavailable');
      Object.assign(error, { code: 'VERIFY_UNAVAILABLE', retryable: true });
      throw error;
    }
    return verification('pass');
  };
  try {
    const first = await applyTaskFinalization(request, options(f.repoRoot, commentSync, verify));
    const receiptPath = path.join(receiptDirectory, `${TASK_ID}.json`);
    const completedReceipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')) as TaskFinalizationReceipt;
    fs.writeFileSync(receiptPath, `${JSON.stringify({ ...completedReceipt, verification: 'pending' })}\n`);
    const warned = await applyTaskFinalization(request, options(f.repoRoot, commentSync, verify));
    const blocked = await applyTaskFinalization(request, options(f.repoRoot, commentSync, verify));
    const blockedReceipt = readTaskFinalizationReceipt(f.repoRoot, TASK_ID);
    fs.chmodSync(receiptDirectory, 0o700);
    const recovered = await applyTaskFinalization(request, options(f.repoRoot, commentSync, verify));
    const recoveredReceipt = readTaskFinalizationReceipt(f.repoRoot, TASK_ID);
    assert.equal(first.result, 'completed');
    assert.equal(warned.result, 'completed_with_warnings');
    assert.equal(blocked.status, 'blocked');
    assert.equal(blocked.result, 'blocked');
    assert.equal(blocked.error?.code, 'FINALIZATION_RECEIPT_WRITE_FAILED');
    assert.match(blocked.error?.message ?? '', /VERIFY_UNAVAILABLE/);
    assert.match(blocked.error?.message ?? '', /EACCES|permission denied/i);
    assert.equal(blockedReceipt?.verification, 'pending');
    assert.equal(blockedReceipt?.warnings.some((warning) => warning.step === 'verification' && warning.status === 'open'), true);
    assert.equal(recovered.result, 'completed');
    assert.equal(recoveredReceipt?.verification, 'done');
    assert.equal(verifyCalls, 4);
    assert.equal(comments.filter((kind) => kind === 'summary').length, 2);
  } finally {
    if (fs.existsSync(receiptDirectory)) fs.chmodSync(receiptDirectory, 0o700);
    fs.rmSync(f.repoRoot, { recursive: true, force: true });
  }
});

test('host finalization resolves a summary warning after a successful retry', async () => {
  const f = fixture();
  const staged = 'Delivered summary.\n';
  fs.writeFileSync(path.join(f.taskDir, '.delivery-summary.json'), `${JSON.stringify({
    taskId: TASK_ID, body: staged, sha256: createHash('sha256').update(staged).digest('hex')
  })}\n`);
  let summaryCalls = 0;
  const calls: string[] = [];
  const commentSync: NonNullable<TaskFinalizationOptions['commentSync']> = async (_taskRef, received) => {
    calls.push(received.kind);
    if (received.kind === 'summary') {
      summaryCalls += 1;
      return summaryCalls === 1
        ? platformResult('blocked', { error: { code: 'NETWORK_ERROR', message: 'temporary', retryable: true } })
        : platformResult('applied');
    }
    return platformResult(received.kind === 'task' ? 'applied' : 'no-op');
  };
  const verify: NonNullable<TaskFinalizationOptions['verify']> = async () => verification('pass');
  try {
    const first = await applyTaskFinalization(request, options(f.repoRoot, commentSync, verify));
    const second = await applyTaskFinalization(request, options(f.repoRoot, commentSync, verify));
    const third = await applyTaskFinalization(request, options(f.repoRoot, commentSync, verify));
    const receipt = readTaskFinalizationReceipt(f.repoRoot, TASK_ID);
    assert.equal(first.result, 'blocked');
    assert.equal(second.result, 'completed');
    assert.equal(third.result, 'completed');
    assert.deepEqual(calls.slice(-2), ['summary', 'task']);
    assert.equal(receipt?.warnings.some((warning) => warning.step === 'summary' && warning.status === 'open'), false);
    assert.equal(fs.existsSync(path.join(f.repoRoot, '.agents', 'workspace', 'completed', TASK_ID, '.delivery-summary.json')), true);
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
  const timeline: string[] = [];
  let verifyCalls = 0;
  const commentSync: NonNullable<TaskFinalizationOptions['commentSync']> = async (_taskRef, received) => {
    commentCalls += 1;
    timeline.push(received.kind);
    commentSnapshots.push(fs.readFileSync(path.join(f.repoRoot, '.agents', 'workspace', 'active', TASK_ID, 'task.md'), 'utf8'));
    return platformResult(commentCalls === 1 ? 'applied' : 'no-op');
  };
  const verify: NonNullable<TaskFinalizationOptions['verify']> = async () => {
    verifyCalls += 1;
    timeline.push('verify');
    return verification(verifyCalls === 1 ? 'fail' : 'pass');
  };
  try {
    const failed = await applyTaskFinalization(request, options(f.repoRoot, commentSync, verify));
    const recovered = await applyTaskFinalization(request, options(f.repoRoot, commentSync, verify));
    const replay = await applyTaskFinalization(request, options(f.repoRoot, commentSync, verify));
    assert.equal(failed.status, 'failed');
    assert.equal(failed.result, 'failed');
    assert.equal(failed.warnings[0]?.code, 'CHECK_FAILED');
    assert.match(failed.warnings[0]?.message ?? '', /Fix complete-task issues/);
    assert.deepEqual(failed.pendingSteps, ['lifecycle', 'verification', 'summary']);
    assert.equal(recovered.status, 'completed');
    assert.equal(replay.status, 'completed');
    assert.equal(verifyCalls, 2);
    assert.equal(commentCalls, 2);
    assert.deepEqual(timeline, ['verify', 'task', 'verify', 'task']);
    assert.match(commentSnapshots[0]!, /\| CHECK_FAILED \| open \|/);
    assert.match(commentSnapshots[1]!, /\| CHECK_FAILED \| resolved \|/);
  } finally {
    fs.rmSync(f.repoRoot, { recursive: true, force: true });
  }
});

test('host finalization supersedes an observed verification target without resolving unobserved targets', async () => {
  const f = fixture();
  let calls = 0;
  const verify: NonNullable<TaskFinalizationOptions['verify']> = async () => {
    calls += 1;
    return verificationChecks(calls === 1 ? 'blocked' : calls === 2 ? 'fail' : 'pass');
  };
  try {
    await applyTaskFinalization(request, options(f.repoRoot, async () => platformResult('no-op'), verify));
    const blocked = readTaskFinalizationReceipt(f.repoRoot, TASK_ID)!;
    assert.equal(blocked.warnings.some((warning) => warning.target === 'artifact' && warning.code === 'CHECK_BLOCKED' && warning.status === 'open'), true);

    await applyTaskFinalization(request, options(f.repoRoot, async () => platformResult('no-op'), verify));
    const failed = readTaskFinalizationReceipt(f.repoRoot, TASK_ID)!;
    assert.equal(failed.warnings.some((warning) => warning.target === 'artifact' && warning.code === 'CHECK_BLOCKED' && warning.status === 'resolved'), true);
    assert.equal(failed.warnings.some((warning) => warning.target === 'artifact' && warning.code === 'CHECK_FAILED' && warning.status === 'open'), true);

    await applyTaskFinalization(request, options(f.repoRoot, async () => platformResult('no-op'), verify));
    const passed = readTaskFinalizationReceipt(f.repoRoot, TASK_ID)!;
    assert.equal(passed.warnings.some((warning) => warning.target === 'artifact' && warning.status === 'open'), false);
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
    assert.equal(first.status, 'blocked');
    assert.equal(first.result, 'blocked');
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
  const staged = 'Delivered summary.\n';
  fs.writeFileSync(path.join(f.taskDir, '.delivery-summary.json'), `${JSON.stringify({
    taskId: TASK_ID, body: staged, sha256: createHash('sha256').update(staged).digest('hex')
  })}\n`);
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

test('broker commit fails closed on the short-id registry after sandbox preparation', async () => {
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
      const first = await prepareTaskFinalization(request, options(f.repoRoot, commentSync, verify));
      mutate(registryPath);
      const commit = await commitPreparedTaskFinalization(request, options(f.repoRoot, commentSync, verify));
      assert.equal(first.status, 'prepared', label);
      assert.equal(commit.status, 'failed', label);
      assert.equal(commit.error?.code, 'TASK_FINALIZATION_SHORT_ID_REGISTRY_UNAVAILABLE', label);
      assert.equal(commit.lifecycle, null, label);
      assert.equal(fs.existsSync(path.join(f.repoRoot, '.agents', 'workspace', 'active', TASK_ID)), true, label);
      const receipt = fs.readFileSync(path.join(f.repoRoot, '.agents', 'workspace', '.task-finalization', `${TASK_ID}.json`), 'utf8');
      assert.equal(JSON.stringify(commit).includes(f.repoRoot), false, label);
      assert.equal(receipt.includes(f.repoRoot), false, label);
    } finally {
      fs.rmSync(f.repoRoot, { recursive: true, force: true });
    }
  }
});
