import { taskWorkspaceRoot } from '../../helpers.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { coordinateManagedSummary, coordinatePlatformWrite } from '../../../lib/platform/operation-coordinator.ts';
import { executeManagedSummary } from '../../../lib/platform/managed-summary-core.ts';
import { readPlatformOperationJournal, recordPlatformOperation } from '../../../lib/task/platform-operation-journal.ts';
import { platformResult } from '../../../lib/platform/types.ts';
import { createTaskWorkspaceFixture } from '../../helpers.ts';
import type { ManagedSummaryPolicy } from '../../../lib/platform/managed-summary-core.ts';

function managedSummaryFixture() {
  const { repoRoot } = createTaskWorkspaceFixture('managed-summary-persistence-');
  const taskId = 'TASK-20260101-000099';
  const taskDir = path.join(taskWorkspaceRoot(repoRoot), 'active', taskId);
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, 'task.md'), `---\nid: ${taskId}\nstatus: active\n---\n`);
  const marker = `<!-- sync-issue:${taskId}:summary -->`;
  const parent = { kind: 'number' as const, value: 7 };
  const remote: Array<{ id: string; body: string }> = [];
  let writes = 0;
  const loaded = {
    repositoryRoot: repoRoot, workingDirectory: repoRoot, snapshot: { scope: { id: 'acme/widgets' } },
    context: { platform: { type: 'github', repository: 'acme/widgets', currentUser: 'codex' }, capabilities: { comment: true }, operations: [] },
    provider: { type: 'github', identity: { comment: 'id' }, comments: {
      list: async () => ({ ok: true as const, value: remote.map((comment) => ({ ...comment, author: { name: 'codex' }, createdSequence: 1 })) }),
      write: async (request: { body: string; existingComment?: { value: string } }) => {
        writes += 1;
        if (request.existingComment) {
          const current = remote.find((comment) => comment.id === request.existingComment!.value);
          if (!current) return { ok: false as const, error: { code: 'COMMENT_NOT_FOUND', message: 'comment not found', retryable: false } };
          current.body = request.body;
          return { ok: true as const, value: { remoteId: current.id, changed: true } };
        }
        const id = `comment-${writes}`;
        remote.push({ id, body: request.body });
        return { ok: true as const, value: { remoteId: id, changed: true } };
      }
    } }
  } as never;
  const policy: ManagedSummaryPolicy = {
    kind: 'summary-comment', taskRef: taskId, target: 'summary', requestDigest: 'a'.repeat(64),
    dependency: 'deferred', cwd: repoRoot, agent: 'codex', loaded,
    prepare: async () => ({ parent, marker, body: `${marker}\ndesired`, position: 'none', fence: {} }),
    validate: async () => null
  };
  const operation = {
    taskRef: taskId, cwd: repoRoot, kind: 'summary-comment' as const, target: 'summary',
    expectedDigest: 'b'.repeat(64), dependency: 'deferred' as const
  };
  return { repoRoot, taskId, operation, policy, remote, get writes() { return writes; } };
}

test('a queued write stays local when an earlier operation cannot drain', async () => {
  const { repoRoot } = createTaskWorkspaceFixture('platform-operation-coordinator-');
  const taskId = 'TASK-20260101-000001';
  const taskDir = path.join(taskWorkspaceRoot(repoRoot),  'active', taskId);
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, 'task.md'), `---\nid: ${taskId}\nstatus: active\n---\n`);
  let drainCalled = false;
  let executeCalled = false;
  try {
    const result = await coordinatePlatformWrite({
      operation: {
        taskRef: taskId, cwd: repoRoot, kind: 'artifact-comment', target: 'review.md',
        expectedDigest: createHash('sha256').update('review').digest('hex'), dependency: 'deferred'
      },
      agent: 'codex',
      drain: async () => {
        drainCalled = true;
        return { status: 'blocked', error: { code: 'NETWORK_TIMEOUT', message: 'prior write remains unknown', retryable: true } };
      },
      execute: async () => {
        executeCalled = true;
        return platformResult('applied');
      },
      block: (error) => platformResult('blocked', { error }),
      persistenceFailure: (error) => platformResult('failed', { error })
    });

    assert.equal(drainCalled, true);
    assert.equal(executeCalled, false);
    assert.equal(result.status, 'blocked');
    assert.equal(readPlatformOperationJournal(taskId, repoRoot).operations[0]?.state, 'queued');
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('the current platform write starts only after earlier work drains', async () => {
  const { repoRoot } = createTaskWorkspaceFixture('platform-operation-order-');
  const taskId = 'TASK-20260101-000002';
  const taskDir = path.join(taskWorkspaceRoot(repoRoot),  'active', taskId);
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, 'task.md'), `---\nid: ${taskId}\nstatus: active\n---\n`);
  const events: string[] = [];
  try {
    const result = await coordinatePlatformWrite({
      operation: {
        taskRef: taskId, cwd: repoRoot, kind: 'artifact-comment', target: 'review.md',
        expectedDigest: createHash('sha256').update('review').digest('hex'), dependency: 'deferred'
      },
      agent: 'codex',
      drain: async () => {
        events.push('drain');
        return { status: 'no-op', error: null };
      },
      execute: async () => {
        events.push('write');
        return platformResult('applied');
      },
      block: (error) => platformResult('blocked', { error }),
      persistenceFailure: (error) => platformResult('failed', { error })
    });

    assert.deepEqual(events, ['drain', 'write']);
    assert.equal(result.status, 'applied');
    const operation = readPlatformOperationJournal(taskId, repoRoot).operations[0];
    assert.equal(operation?.state, 'succeeded');
    assert.equal(operation?.attempts, 1);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('a required write waits behind an earlier deferred failure', async () => {
  const { repoRoot } = createTaskWorkspaceFixture('platform-operation-dependency-');
  const taskId = 'TASK-20260101-000003';
  const taskDir = path.join(taskWorkspaceRoot(repoRoot),  'active', taskId);
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, 'task.md'), `---\nid: ${taskId}\nstatus: active\n---\n`);
  try {
    const deferred = recordPlatformOperation({
      taskRef: taskId, cwd: repoRoot, kind: 'artifact-comment', target: 'analysis.md',
      expectedDigest: createHash('sha256').update('analysis').digest('hex'),
      dependency: 'deferred', state: 'failed', lastCode: 'NETWORK_TIMEOUT'
    });
    let executed = false;
    const result = await coordinatePlatformWrite({
      operation: {
        taskRef: taskId, cwd: repoRoot, kind: 'pull-request', target: 'head:feature:base:main',
        expectedDigest: createHash('sha256').update('pr').digest('hex'), dependency: 'required',
        pullRequest: { action: 'create', baseRef: 'main', headRef: 'feature' }
      },
      agent: 'codex',
      execute: async () => { executed = true; return platformResult('applied'); },
      block: (error) => platformResult('blocked', { error }),
      persistenceFailure: (error) => platformResult('failed', { error })
    });

    assert.equal(result.status, 'blocked');
    assert.equal(executed, false);
    assert.equal(readPlatformOperationJournal(taskId, repoRoot).operations.find((item) => item.id === deferred.id)?.state, 'failed');
    assert.equal(readPlatformOperationJournal(taskId, repoRoot).operations[1]?.state, 'queued');
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('Issue closure waits for earlier deferred writes before changing the terminal state', async () => {
  const { repoRoot } = createTaskWorkspaceFixture('platform-operation-close-');
  const taskId = 'TASK-20260101-000004';
  const taskDir = path.join(taskWorkspaceRoot(repoRoot),  'completed', taskId);
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, 'task.md'), `---\nid: ${taskId}\nstatus: completed\n---\n`);
  try {
    recordPlatformOperation({
      taskRef: taskId, cwd: repoRoot, kind: 'artifact-comment', target: 'analysis.md',
      expectedDigest: createHash('sha256').update('analysis').digest('hex'),
      dependency: 'deferred', state: 'failed', lastCode: 'NETWORK_TIMEOUT'
    });
    let executed = false;
    const result = await coordinatePlatformWrite({
      operation: {
        taskRef: taskId, cwd: repoRoot, kind: 'issue-metadata', target: '{"kind":"number","value":42}',
        expectedDigest: createHash('sha256').update('cancel').digest('hex'), dependency: 'required',
        issueMetadata: { requirements: false, issueType: false, fields: false, state: 'closed', closeReason: 'not_planned' }
      },
      agent: 'codex',
      execute: async () => { executed = true; return platformResult('applied'); },
      block: (error) => platformResult('blocked', { error }),
      persistenceFailure: (error) => platformResult('failed', { error })
    });
    assert.equal(result.status, 'blocked');
    assert.equal(executed, false);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('managed summary preparation persistence failure never reaches the provider', async () => {
  const fixture = managedSummaryFixture();
  const originalRename = fs.renameSync;
  let renames = 0;
  try {
    fs.renameSync = ((...args: Parameters<typeof fs.renameSync>) => {
      renames += 1;
      if (renames === 2) throw Object.assign(new Error('frozen execution persistence failed'), { code: 'EIO' });
      return originalRename(...args);
    }) as typeof fs.renameSync;
    const output = await coordinateManagedSummary({ operation: fixture.operation, policy: fixture.policy, agent: 'codex' });
    assert.equal(output.result.status, 'blocked');
    assert.equal(fixture.writes, 0);
    assert.equal(readPlatformOperationJournal(fixture.taskId, fixture.repoRoot).operations[0]?.managedSummary?.execution, undefined);
  } finally {
    fs.renameSync = originalRename;
    fs.rmSync(fixture.repoRoot, { recursive: true, force: true });
  }
});

test('pending written-receipt persistence failure observes the remote postimage without another write', async () => {
  const fixture = managedSummaryFixture();
  const originalRename = fs.renameSync;
  let renames = 0;
  let failedOnce = false;
  try {
    fs.renameSync = ((...args: Parameters<typeof fs.renameSync>) => {
      renames += 1;
      if (renames === 3 && !failedOnce) { failedOnce = true; throw Object.assign(new Error('written receipt persistence failed'), { code: 'EIO' }); }
      return originalRename(...args);
    }) as typeof fs.renameSync;
    const output = await coordinateManagedSummary({ operation: fixture.operation, policy: fixture.policy, agent: 'codex' });
    assert.equal(output.result.status, 'no-op', JSON.stringify(output.result));
    assert.equal(fixture.writes, 1);
    assert.equal(readPlatformOperationJournal(fixture.taskId, fixture.repoRoot).operations[0]?.state, 'succeeded');
  } finally {
    fs.renameSync = originalRename;
    fs.rmSync(fixture.repoRoot, { recursive: true, force: true });
  }
});

test('unknown managed summary without frozen execution evidence cannot prepare or write', async () => {
  const fixture = managedSummaryFixture();
  try {
    const operation = recordPlatformOperation({ ...fixture.operation, state: 'unknown', stableId: 'c'.repeat(64), managedSummary: { requestDigest: fixture.policy.requestDigest } });
    const output = await executeManagedSummary(fixture.policy, operation);
    assert.equal(output.result.status, 'blocked');
    assert.equal(output.result.error?.code, 'MANAGED_SUMMARY_EXECUTION_EVIDENCE_MISSING');
    assert.equal(fixture.writes, 0);
  } finally {
    fs.rmSync(fixture.repoRoot, { recursive: true, force: true });
  }
});

test('pending managed summary without frozen evidence stays blocked regardless of attempt count', async () => {
  const fixture = managedSummaryFixture();
  try {
    const operation = recordPlatformOperation({ ...fixture.operation, state: 'pending', stableId: 'f'.repeat(64), managedSummary: { requestDigest: fixture.policy.requestDigest } });
    assert.equal(operation.attempts, 1);
    const output = await executeManagedSummary(fixture.policy, operation);
    assert.equal(output.result.status, 'blocked');
    assert.equal(output.result.error?.code, 'MANAGED_SUMMARY_EXECUTION_EVIDENCE_MISSING');
    assert.equal(fixture.writes, 0);
  } finally {
    fs.rmSync(fixture.repoRoot, { recursive: true, force: true });
  }
});

test('prepared reposition continues from the original managed comment', async () => {
  const fixture = managedSummaryFixture();
  const marker = `<!-- sync-issue:${fixture.taskId}:summary -->`;
  const oldBody = `${marker}\nold`;
  fixture.remote.push({ id: 'comment-old', body: oldBody });
  const execution = {
    parentKind: 'issue' as const, parent: { kind: 'number' as const, value: 7 }, marker,
    body: `${marker}\ndesired`, bodyDigest: createHash('sha256').update(`${marker}\ndesired`).digest('hex'),
    action: 'reposition' as const, phase: 'prepared' as const,
    preimage: { kind: 'comment' as const, id: 'comment-old', body: oldBody, bodyDigest: createHash('sha256').update(oldBody).digest('hex') },
    fence: {}, position: 'summary-last' as const, idempotencyKey: 'original-operation:reposition'
  };
  const provider = fixture.policy.loaded as NonNullable<ManagedSummaryPolicy['loaded']>;
  provider.provider.comments!.delete = async (request) => {
    const index = fixture.remote.findIndex((comment) => comment.id === String(request.comment.value));
    if (index >= 0) fixture.remote.splice(index, 1);
    return { ok: true as const, value: { remoteId: String(request.comment.value), changed: true } };
  };
  try {
    const operation = recordPlatformOperation({ ...fixture.operation, state: 'pending', stableId: 'd'.repeat(64), managedSummary: { requestDigest: fixture.policy.requestDigest, execution } });
    const output = await executeManagedSummary(fixture.policy, operation);
    assert.equal(output.result.status, 'applied');
    assert.equal(fixture.writes, 1);
    assert.equal(readPlatformOperationJournal(fixture.taskId, fixture.repoRoot).operations[0]?.id, operation.id);
  } finally {
    fs.rmSync(fixture.repoRoot, { recursive: true, force: true });
  }
});

test('update recovery rejects a replacement object with the same body', async () => {
  const fixture = managedSummaryFixture();
  const marker = `<!-- sync-issue:${fixture.taskId}:summary -->`;
  const body = `${marker}\ndesired`;
  fixture.remote.push({ id: 'replacement-comment', body });
  const execution = {
    parentKind: 'issue' as const, parent: { kind: 'number' as const, value: 7 }, marker,
    body, bodyDigest: createHash('sha256').update(body).digest('hex'), action: 'update' as const, phase: 'written' as const,
    preimage: { kind: 'comment' as const, id: 'original-comment', body: `${marker}\nold`, bodyDigest: createHash('sha256').update(`${marker}\nold`).digest('hex') },
    fence: {}, position: 'none' as const, idempotencyKey: 'original-operation:update', remoteId: 'original-comment'
  };
  try {
    const operation = recordPlatformOperation({ ...fixture.operation, state: 'unknown', stableId: 'e'.repeat(64), managedSummary: { requestDigest: fixture.policy.requestDigest, execution } });
    const output = await executeManagedSummary(fixture.policy, operation);
    assert.equal(output.result.status, 'blocked');
    assert.equal(fixture.writes, 0);
    assert.equal(fixture.remote[0]?.id, 'replacement-comment');
  } finally {
    fs.rmSync(fixture.repoRoot, { recursive: true, force: true });
  }
});

test('update compensation restores only its original comment preimage', async () => {
  const fixture = managedSummaryFixture();
  const marker = `<!-- sync-issue:${fixture.taskId}:summary -->`;
  const oldBody = `${marker}\noriginal`;
  fixture.remote.push({ id: 'comment-original', body: oldBody });
  let validations = 0;
  (fixture.policy as unknown as { validate: ManagedSummaryPolicy['validate'] }).validate = async () => ++validations === 2
    ? { code: 'SUMMARY_READBACK_REJECTED', message: 'post-write guard rejected the result', retryable: false }
    : null;
  try {
    const output = await coordinateManagedSummary({ operation: fixture.operation, policy: fixture.policy, agent: 'codex' });
    assert.equal(output.result.status, 'failed');
    assert.equal(fixture.remote.length, 1);
    assert.equal(fixture.remote[0]?.id, 'comment-original');
    assert.equal(fixture.remote[0]?.body, oldBody);
    assert.equal(fixture.writes, 2);
    const operation = readPlatformOperationJournal(fixture.taskId, fixture.repoRoot).operations[0];
    assert.equal(operation?.state, 'failed');
    assert.equal(operation?.managedSummary?.execution?.preimage.kind, 'comment');
  } finally {
    fs.rmSync(fixture.repoRoot, { recursive: true, force: true });
  }
});

test('update recovery leaves a third-party body on the original comment untouched', async () => {
  const fixture = managedSummaryFixture();
  const marker = `<!-- sync-issue:${fixture.taskId}:summary -->`;
  fixture.remote.push({ id: 'comment-original', body: `${marker}\nthird-party edit` });
  const execution = {
    parentKind: 'issue' as const, parent: { kind: 'number' as const, value: 7 }, marker,
    body: `${marker}\ndesired`, bodyDigest: createHash('sha256').update(`${marker}\ndesired`).digest('hex'),
    action: 'update' as const, phase: 'written' as const,
    preimage: { kind: 'comment' as const, id: 'comment-original', body: `${marker}\noriginal`, bodyDigest: createHash('sha256').update(`${marker}\noriginal`).digest('hex') },
    fence: {}, position: 'none' as const, idempotencyKey: 'original-operation:update', remoteId: 'comment-original'
  };
  try {
    const operation = recordPlatformOperation({ ...fixture.operation, state: 'unknown', stableId: 'a'.repeat(64), managedSummary: { requestDigest: fixture.policy.requestDigest, execution } });
    const output = await executeManagedSummary(fixture.policy, operation);
    assert.equal(output.result.status, 'blocked');
    assert.equal(output.result.error?.code, 'MANAGED_SUMMARY_OUTCOME_UNKNOWN');
    assert.equal(fixture.writes, 0);
    assert.equal(fixture.remote[0]?.body, `${marker}\nthird-party edit`);
  } finally {
    fs.rmSync(fixture.repoRoot, { recursive: true, force: true });
  }
});

test('verified managed summary compensation remains terminal failed', async () => {
  const fixture = managedSummaryFixture();
  let validations = 0;
  const mutablePolicy = fixture.policy as unknown as { validate: ManagedSummaryPolicy['validate'] };
  mutablePolicy.validate = async () => ++validations === 2
    ? { code: 'SUMMARY_READBACK_REJECTED', message: 'post-write guard rejected the result', retryable: false }
    : null;
  fixture.policy.loaded!.provider.comments!.delete = async (request) => {
    const index = fixture.remote.findIndex((comment) => comment.id === String(request.comment.value));
    if (index >= 0) fixture.remote.splice(index, 1);
    return { ok: true as const, value: { remoteId: String(request.comment.value), changed: true } };
  };
  try {
    const output = await coordinateManagedSummary({ operation: fixture.operation, policy: fixture.policy, agent: 'codex' });
    const operation = readPlatformOperationJournal(fixture.taskId, fixture.repoRoot).operations[0];
    assert.equal(output.result.status, 'failed');
    assert.equal(operation?.state, 'failed');
    assert.equal(fixture.remote.length, 0);
    assert.equal(fixture.writes, 1);
  } finally {
    fs.rmSync(fixture.repoRoot, { recursive: true, force: true });
  }
});
