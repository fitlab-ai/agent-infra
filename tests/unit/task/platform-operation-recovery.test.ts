import { taskWorkspaceRoot } from '../../helpers.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { coordinatePlatformWrite } from '../../../lib/platform/operation-coordinator.ts';
import { platformResult } from '../../../lib/platform/types.ts';
import { recoverCreatedPullRequest } from '../../../lib/platform/pull-requests.ts';
import { inspectPlatformCommentOperation } from '../../../lib/platform/issue-comments.ts';
import { fieldsMatchExpected, labelsMatchOwnedPrefix, recoverPlatformOperations } from '../../../lib/task/platform-operation-recovery.ts';
import { readPlatformOperationJournal, recordPlatformOperation } from '../../../lib/task/platform-operation-journal.ts';
import { createTaskWorkspaceFixture } from '../../helpers.ts';

const TASK_ID = 'TASK-20260101-000001';

test('Issue metadata recovery compares each label operation by its owned prefix', () => {
  const finalLabels = ['in: core', 'status: cancelled', 'type: bug'];
  const statusPlan = ['in: old', 'status: cancelled', 'type: bug'];
  const inPlan = ['in: core', 'status: open', 'type: bug'];

  assert.equal(labelsMatchOwnedPrefix(finalLabels, statusPlan, 'status:'), true);
  assert.equal(labelsMatchOwnedPrefix(finalLabels, inPlan, 'in:'), true);
  assert.equal(labelsMatchOwnedPrefix(finalLabels, statusPlan, 'in:'), false);
  assert.equal(labelsMatchOwnedPrefix(finalLabels, inPlan, 'status:'), false);
});

test('Issue metadata recovery confirms requested fields while ignoring unrelated remote fields', () => {
  const actual = { Priority: 'High', Team: 'Platform' };

  assert.equal(fieldsMatchExpected(actual, { Priority: 'High' }), true);
  assert.equal(fieldsMatchExpected(actual, { Priority: 'High', Effort: 'M' }), false);
  assert.equal(fieldsMatchExpected(actual, { Priority: 'Low' }), false);
});

function fixture() {
  const { repoRoot } = createTaskWorkspaceFixture('platform-operation-recovery-');
  const taskDir = path.join(taskWorkspaceRoot(repoRoot),  'active', TASK_ID);
  fs.mkdirSync(taskDir, { recursive: true });
  const taskFile = path.join(taskDir, 'task.md');
  fs.writeFileSync(taskFile, `---\nid: ${TASK_ID}\nplatform_issue_identity: '{"kind":"number","value":42}'\nstatus: active\n---\n\n# Original title\n`);
  const project = (JSON.parse(fs.readFileSync(path.join(repoRoot, '.agents', '.airc.json'), 'utf8')) as { project: string }).project;
  return { repoRoot, taskDir, taskFile, project };
}

function writePlatformConfig(repoRoot: string, platform: Record<string, unknown>): void {
  const configPath = path.join(repoRoot, '.agents', '.airc.json');
  const current = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>;
  fs.writeFileSync(configPath, JSON.stringify({ ...current, delivery: { remote: 'origin', baseRef: 'main' }, platform }));
}

test('recovery supersedes an old comment digest when its task projection changed', async () => {
  const f = fixture();
  try {
    const first = inspectPlatformCommentOperation(TASK_ID, { kind: 'task', agent: 'codex', cwd: f.repoRoot });
    assert.ok(first);
    recordPlatformOperation({ taskRef: TASK_ID, cwd: f.repoRoot, ...first, dependency: 'deferred', state: 'pending' });
    const later = recordPlatformOperation({
      taskRef: TASK_ID, cwd: f.repoRoot, kind: 'artifact-comment', target: 'later.md', expectedDigest: 'b'.repeat(64),
      dependency: 'deferred', state: 'queued'
    });
    fs.appendFileSync(f.taskFile, '\n## Description\nUpdated projection.\n');

    const recovered = await recoverPlatformOperations(TASK_ID, 'deferred', { agent: 'codex', cwd: f.repoRoot });
    const journal = readPlatformOperationJournal(TASK_ID, f.repoRoot);
    const current = journal.operations[0];
    assert.notEqual(current?.id, first.id);
    assert.ok(current);
    assert.notEqual(current.expectedDigest, first.expectedDigest);
    assert.equal(current.attempts, 4);
    assert.equal(current.state, 'unknown');
    assert.deepEqual(recovered.pending, [current.id, later.id]);
    assert.equal(journal.operations[1]?.id, later.id);
    assert.equal(journal.operations[1]?.state, 'queued');
  } finally {
    fs.rmSync(f.repoRoot, { recursive: true, force: true });
  }
});

test('recovery removes an already queued replacement and continues to the next comment', async () => {
  const f = fixture();
  try {
    fs.mkdirSync(path.join(f.repoRoot, '.agents'), { recursive: true });
    writePlatformConfig(f.repoRoot, {
      type: 'trae',
      providers: { trae: { source: path.resolve('tests/fixtures/platform-providers/opaque-identity-provider.mjs'), config: {} } }
    });
    const old = inspectPlatformCommentOperation(TASK_ID, { kind: 'task', agent: 'codex', cwd: f.repoRoot });
    assert.ok(old);
    recordPlatformOperation({ taskRef: TASK_ID, cwd: f.repoRoot, ...old, dependency: 'deferred', state: 'pending' });
    fs.appendFileSync(f.taskFile, '\n## Description\nUpdated projection.\n');
    const replacement = inspectPlatformCommentOperation(TASK_ID, { kind: 'task', agent: 'codex', cwd: f.repoRoot });
    assert.ok(replacement);
    recordPlatformOperation({ taskRef: TASK_ID, cwd: f.repoRoot, ...replacement, dependency: 'deferred', state: 'queued' });
    fs.writeFileSync(path.join(f.taskDir, 'code.md'), '# Later artifact\n');
    const later = inspectPlatformCommentOperation(TASK_ID, { kind: 'artifact', artifact: 'code.md', agent: 'codex', cwd: f.repoRoot });
    assert.ok(later);
    recordPlatformOperation({ taskRef: TASK_ID, cwd: f.repoRoot, ...later, dependency: 'deferred', state: 'queued' });

    const recovered = await recoverPlatformOperations(TASK_ID, 'deferred', { agent: 'codex', cwd: f.repoRoot });
    const journal = readPlatformOperationJournal(TASK_ID, f.repoRoot);

    assert.equal(recovered.status, 'applied');
    assert.deepEqual(recovered.pending, []);
    assert.deepEqual(journal.operations.map((operation) => operation.id), [replacement.id, later.id]);
    assert.deepEqual(journal.operations.map((operation) => operation.state), ['succeeded', 'succeeded']);
  } finally {
    fs.rmSync(f.repoRoot, { recursive: true, force: true });
  }
});

test('each automatic recovery run retries the head three times and records cumulative attempts', async () => {
  const f = fixture();
  const callsPath = path.join(f.repoRoot, 'provider-calls.txt');
  try {
    fs.mkdirSync(path.join(f.repoRoot, '.agents'), { recursive: true });
    writePlatformConfig(f.repoRoot, {
      type: 'trae',
      providers: { trae: { source: path.resolve('tests/fixtures/platform-providers/in-label-provider.mjs'), config: { callsPath, recoveryVerifyHead: true } } }
    });
    const operation = recordPlatformOperation({
      taskRef: TASK_ID, cwd: f.repoRoot, kind: 'pull-request', target: 'head:feature:base:main',
      expectedDigest: 'a'.repeat(64), pullRequest: { action: 'create', baseRef: 'main', headRef: 'feature' },
      dependency: 'required', state: 'pending'
    });

    for (const attempts of [4, 7]) {
      const recovery = await recoverPlatformOperations(TASK_ID, 'required', { agent: 'codex', cwd: f.repoRoot });
      const persisted = readPlatformOperationJournal(TASK_ID, f.repoRoot).operations.find((item) => item.id === operation.id);
      assert.equal(persisted?.attempts, attempts);
      assert.equal(persisted?.state, 'unknown', JSON.stringify({ recovery, providerCalls: fs.readFileSync(callsPath, 'utf8') }));
    }
    assert.equal(fs.readFileSync(callsPath, 'utf8').split('\n').filter((call) => call === 'changeRequests.verifyHead').length, 6);
  } finally {
    fs.rmSync(f.repoRoot, { recursive: true, force: true });
  }
});

test('recovery retries the failed head and leaves later writes queued', async () => {
  const f = fixture();
  const callsPath = path.join(f.repoRoot, 'provider-calls.txt');
  try {
    fs.mkdirSync(path.join(f.repoRoot, '.agents'), { recursive: true });
    writePlatformConfig(f.repoRoot, {
      type: 'trae',
      providers: { trae: { source: path.resolve('tests/fixtures/platform-providers/in-label-provider.mjs'), config: { callsPath, recoveryVerifyHead: true } } }
    });
    const earlier = {
      taskRef: TASK_ID, cwd: f.repoRoot, kind: 'pull-request' as const,
      target: 'head:feature:base:main', expectedDigest: 'a'.repeat(64),
      pullRequest: { action: 'create' as const, baseRef: 'main', headRef: 'feature' },
      dependency: 'required' as const, state: 'pending' as const
    };
    const firstOperation = recordPlatformOperation(earlier);
    const later = recordPlatformOperation({
      ...earlier, target: 'head:other:base:main', expectedDigest: 'b'.repeat(64), state: 'queued'
    });

    const recovered = await recoverPlatformOperations(TASK_ID, 'all', { agent: 'codex', cwd: f.repoRoot });
    const journal = readPlatformOperationJournal(TASK_ID, f.repoRoot);
    const first = journal.operations[0]!;

    assert.equal(recovered.status, 'blocked');
    assert.deepEqual(recovered.pending, [firstOperation.id, later.id]);
    assert.equal(first.id, firstOperation.id);
    assert.equal(first.attempts, 4);
    assert.equal(first.state, 'unknown');
    assert.equal(journal.operations.find((operation) => operation.id === later.id)?.state, 'queued');
    assert.equal(fs.readFileSync(callsPath, 'utf8').split('\n').filter((call) => call === 'changeRequests.verifyHead').length, 3);
  } finally {
    fs.rmSync(f.repoRoot, { recursive: true, force: true });
  }
});

test('human supplied retry count overrides the automatic retry budget even when errors say non-retryable', async () => {
  const f = fixture();
  const callsPath = path.join(f.repoRoot, 'provider-calls.txt');
  try {
    fs.mkdirSync(path.join(f.repoRoot, '.agents'), { recursive: true });
    writePlatformConfig(f.repoRoot, {
      type: 'trae',
      providers: { trae: { source: path.resolve('tests/fixtures/platform-providers/in-label-provider.mjs'), config: { callsPath, recoveryVerifyHead: true, verifyHeadFailures: 5 } } }
    });
    const operation = recordPlatformOperation({
      taskRef: TASK_ID, cwd: f.repoRoot, kind: 'pull-request', target: 'head:feature:base:main',
      expectedDigest: 'a'.repeat(64), pullRequest: { action: 'create', baseRef: 'main', headRef: 'feature' },
      dependency: 'required', state: 'pending'
    });

    const recovery = await recoverPlatformOperations(TASK_ID, 'required', { agent: 'codex', cwd: f.repoRoot, attempts: 5 });
    const persisted = readPlatformOperationJournal(TASK_ID, f.repoRoot).operations.find((item) => item.id === operation.id);
    assert.equal(recovery.status, 'failed');
    assert.deepEqual(recovery.error, { code: 'PLATFORM_REQUEST_FAILED', message: 'The platform request failed' });
    assert.equal(persisted?.attempts, 6);
    assert.equal(persisted?.state, 'unknown');
    assert.equal(fs.readFileSync(callsPath, 'utf8').split('\n').filter((call) => call === 'changeRequests.verifyHead').length, 5);
  } finally {
    fs.rmSync(f.repoRoot, { recursive: true, force: true });
  }
});

test('PR recovery preserves its typed intent when a replay does not succeed', async () => {
  const f = fixture();
  const intent = { action: 'create' as const, baseRef: 'main', headRef: 'feature' };
  try {
    const operation = recordPlatformOperation({
      taskRef: TASK_ID, cwd: f.repoRoot, kind: 'pull-request', target: `head:feature:base:main`,
      expectedDigest: 'a'.repeat(64), dependency: 'required', state: 'pending', pullRequest: intent
    });
    await recoverPlatformOperations(TASK_ID, 'required', { agent: 'codex', cwd: f.repoRoot });
    const journal = readPlatformOperationJournal(TASK_ID, f.repoRoot);
    const persisted = journal.operations.find((item) => item.id === operation.id);
    assert.deepEqual(persisted?.pullRequest, intent);
    assert.ok(['unknown', 'failed', 'succeeded'].includes(persisted?.state ?? ''));
  } finally {
    fs.rmSync(f.repoRoot, { recursive: true, force: true });
  }
});


test('capability-skipped metadata before a PR converges without replaying later writes', async () => {
  const f = fixture();
  const callsPath = path.join(f.repoRoot, 'provider-calls.txt');
  try {
    fs.writeFileSync(f.taskFile, `---\nid: ${TASK_ID}\nplatform_issue_identity: '{"kind":"number","value":7}'\nstatus: active\n---\n`);
    writePlatformConfig(f.repoRoot, { type: 'trae', providers: { trae: { source: path.resolve('tests/fixtures/platform-providers/in-label-provider.mjs'), config: { callsPath, push: false } } } });
    recordPlatformOperation({ taskRef: TASK_ID, cwd: f.repoRoot, kind: 'issue-metadata', target: '{"kind":"number","value":7}', expectedDigest: 'a'.repeat(64), dependency: 'deferred', state: 'unknown', lastCode: 'PUSH_REQUIRED', issueMetadata: { requirements: false, issueType: false, fields: true } });
    const boundary = recordPlatformOperation({ taskRef: TASK_ID, cwd: f.repoRoot, kind: 'pull-request', target: 'pr:1', expectedDigest: 'b'.repeat(64), dependency: 'required', state: 'queued', pullRequest: { action: 'bind', prToken: '1' } });
    const later = recordPlatformOperation({ taskRef: TASK_ID, cwd: f.repoRoot, kind: 'artifact-comment', target: 'later.md', expectedDigest: 'c'.repeat(64), dependency: 'deferred', state: 'queued' });
    const result = await recoverPlatformOperations(TASK_ID, 'all', { agent: 'codex', cwd: f.repoRoot, beforeId: boundary.id });
    const journal = readPlatformOperationJournal(TASK_ID, f.repoRoot);
    assert.equal(result.status, 'applied');
    assert.deepEqual(result.pending, []);
    assert.deepEqual(result.degraded, [{ id: journal.operations[0]?.id, reasonCode: 'PUSH_REQUIRED' }]);
    assert.equal(journal.operations[0]?.state, 'succeeded');
    assert.equal(journal.operations[0]?.lastCode, 'PUSH_REQUIRED');
    assert.equal(journal.operations.find((op) => op.id === later.id)?.state, 'queued');
    assert.equal(fs.readFileSync(callsPath, 'utf8').includes('issues.update'), false);
  } finally { fs.rmSync(f.repoRoot, { recursive: true, force: true }); }
});


test('required PR retry drains its prefix but leaves a later deferred failure untouched', async () => {
  const f = fixture();
  try {
    fs.writeFileSync(f.taskFile, `---\nid: ${TASK_ID}\nplatform_issue_identity: '{"kind":"number","value":7}'\nstatus: active\n---\n`);
    writePlatformConfig(f.repoRoot, { type: 'trae', providers: { trae: { source: path.resolve('tests/fixtures/platform-providers/in-label-provider.mjs'), config: { push: false } } } });
    recordPlatformOperation({ taskRef: TASK_ID, cwd: f.repoRoot, kind: 'issue-metadata', target: '{"kind":"number","value":7}', expectedDigest: 'a'.repeat(64), dependency: 'deferred', state: 'unknown', issueMetadata: { requirements: false, issueType: false, fields: true } });
    const operation = { taskRef: TASK_ID, cwd: f.repoRoot, kind: 'pull-request' as const, target: 'pr:1', expectedDigest: 'b'.repeat(64), dependency: 'required' as const, pullRequest: { action: 'bind' as const, prToken: '1' } };
    recordPlatformOperation({ ...operation, state: 'queued' });
    const later = recordPlatformOperation({ taskRef: TASK_ID, cwd: f.repoRoot, kind: 'artifact-comment', target: 'missing.md', expectedDigest: 'c'.repeat(64), dependency: 'deferred', state: 'failed', lastCode: 'NETWORK_TIMEOUT' });
    let executions = 0;
    const result = await coordinatePlatformWrite({ operation, agent: 'codex', execute: async () => { executions++; return platformResult('applied'); }, block: (error) => platformResult('blocked', { error }), persistenceFailure: (error) => platformResult('failed', { error }) });
    assert.equal(result.status, 'applied');
    assert.equal(executions, 1);
    assert.equal(readPlatformOperationJournal(TASK_ID, f.repoRoot).operations.find((op) => op.id === later.id)?.state, 'failed');
  } finally { fs.rmSync(f.repoRoot, { recursive: true, force: true }); }
});

test('PR creation recovery uses delivered head when provider omits verifyHead', async () => {
  const f = fixture();
  try {
    const header = `---\nid: ${TASK_ID}\nplatform_issue_identity: '{"kind":"number","value":7}'\nstatus: active\nagent_infra_version: v0.12.1\nbranch: feature\ndelivery_remote: origin\ndelivery_base_ref: main\npr_delivery_fact: '{"version":2,"state":"unbound","reason":"initial"}'\n`;
    fs.writeFileSync(f.taskFile, `${header}---\n`);
    writePlatformConfig(f.repoRoot, { type: 'trae', providers: { trae: { source: path.resolve('tests/fixtures/platform-providers/in-label-provider.mjs'), config: { closingMatch: true } } } });
    const missing = await recoverCreatedPullRequest(TASK_ID, { agent: 'codex', cwd: f.repoRoot, base: 'main', head: 'feature' });
    assert.equal(missing.error?.code, 'PR_HEAD_UNVERIFIED');
    fs.writeFileSync(f.taskFile, `${header}delivery_remote_head: ${'c'.repeat(40)}\n---\n`);
    const mismatch = await recoverCreatedPullRequest(TASK_ID, { agent: 'codex', cwd: f.repoRoot, base: 'main', head: 'feature' });
    assert.equal(mismatch.error?.code, 'PLATFORM_OPERATION_PR_NOT_CONFIRMED');
    fs.writeFileSync(f.taskFile, `${header}delivery_remote_head: ${'a'.repeat(40)}\n---\n\n## Review Disagreement Ledger\n\n| id | stage | round | severity | status | evidence |\n|----|-------|-------|----------|--------|----------|\n` );
    const recovered = await recoverCreatedPullRequest(TASK_ID, { agent: 'codex', cwd: f.repoRoot, base: 'main', head: 'feature' });
    assert.equal(recovered.status, 'applied', JSON.stringify(recovered));
    assert.equal(recovered.warnings?.some((warning) => warning.code === 'ACTIVITY_LOG_UNAVAILABLE'), true);
    assert.match(fs.readFileSync(f.taskFile, 'utf8'), /state.*bound/);
  } finally { fs.rmSync(f.repoRoot, { recursive: true, force: true }); }
});
