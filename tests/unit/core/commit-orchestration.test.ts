import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  advanceOrchestration,
  beginCommitIntent,
  beginOrResumeOrchestration,
  checkpointCommitIntent,
  completeCommitIntent,
  prepareOrchestrationDelegation,
  readRun,
  recoverCommitIntent,
  sealOrchestrationDelegation,
  statusCommitIntent
} from '../../../lib/task/orchestration.ts';
import { readCommitIntent } from '../../../lib/task/commit-intent.ts';

const taskId = 'TASK-20260101-000001';

function git(root: string, args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'commit-orchestration-'));
  git(root, ['init', '-q']);
  git(root, ['config', 'user.name', 'Test']);
  git(root, ['config', 'user.email', 'test@example.com']);
  fs.writeFileSync(path.join(root, 'source.txt'), 'base\n');
  git(root, ['add', 'source.txt']);
  git(root, ['commit', '-qm', 'base']);
  const taskDir = path.join(root, '.agents', 'workspace', 'active', taskId);
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, 'task.md'), [
    '---', `id: ${taskId}`, 'status: active', 'current_step: code-review', '---', '',
    '# Task', '', '## Activity Log', '',
    '- 2026-01-01 00:00:00+00:00 — **Commit [started]** by codex — started', ''
  ].join('\n'));
  return { root, taskDir, head: git(root, ['rev-parse', 'HEAD']) };
}

function checkpointReviewed(f: ReturnType<typeof fixture>, token: string) {
  fs.writeFileSync(path.join(f.root, 'source.txt'), 'changed\n');
  git(f.root, ['add', 'source.txt']);
  git(f.root, ['commit', '-qm', 'change']);
  const head = git(f.root, ['rev-parse', 'HEAD']);
  assert.equal(checkpointCommitIntent(taskId, {
    token, kind: 'committed', head
  }, { repoRoot: f.root }).status, 'ready');
  fs.writeFileSync(path.join(f.taskDir, 'review-code.md'), [
    '# Review', '', `- **Review Baseline Commit**: \`${f.head}\``,
    `- **Reviewed Snapshot Tree**: \`${git(f.root, ['rev-parse', 'HEAD^{tree}'])}\``, '',
    '## Review Summary', '', '- **Overall Verdict**: Approved',
    '- **Findings (AI-actionable)**: 0 blockers, 0 major, 0 minor / **Manual-validation**: 0', ''
  ].join('\n'));
  return head;
}

function activatedRun() {
  const receipt = {
    id: 'receipt-1', taskId, runId: 'run-1', role: 'executor', stage: 'commit', round: 1,
    artifact: 'commit', client: 'claude-code', requestedModel: 'model', requestedReasoningEffort: 'high',
    actualModel: 'model', actualReasoningEffort: 'high', modelFallbackReason: null,
    reasoningEffortFallbackReason: null, parentId: 'parent', childId: 'child', spawnMode: 'fresh',
    agent: null, status: 'activated', workspaceSnapshotScope: 'task', beforeFingerprint: 'before',
    afterFingerprint: null, changedPaths: [], createdAt: '2026-01-01T00:00:00.000Z',
    activatedAt: '2026-01-01T00:00:00.000Z', sealedAt: null, consumedAt: null
  };
  return {
    schemaVersion: 1, taskId, runId: 'run-1', status: 'running', nextStage: 'commit', stepCount: 6,
    maxSteps: 10, baseline: 'snapshot', pendingDelegation: receipt, receipts: [], pause: null,
    commitAuthorization: { issuedAt: '2026-01-01T00:00:00.000Z', consumedAt: null },
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z'
  };
}

test('standalone begin and complete preserve historical orchestration bytes', () => {
  for (const status of ['paused', 'completed'] as const) {
    const f = fixture();
    const runPath = path.join(f.taskDir, 'orchestration.json');
    const historical = { ...activatedRun(), status, pendingDelegation: null };
    fs.writeFileSync(runPath, `${JSON.stringify(historical, null, 2)}\n`);
    const before = fs.readFileSync(runPath);

    const begun = beginCommitIntent(taskId, {
      agent: 'codex', orchestrated: false, baselineHead: f.head
    }, { repoRoot: f.root, token: () => `token-${status}` });
    assert.equal(begun.status, 'ready');
    assert.equal(begun.intent?.mode, 'standalone');
    assert.deepEqual(fs.readFileSync(runPath), before);
    checkpointReviewed(f, begun.token!);
    assert.equal(completeCommitIntent(taskId, { token: begun.token!, agent: 'codex' }, { repoRoot: f.root }).status, 'ready');
    assert.deepEqual(fs.readFileSync(runPath), before);
    assert.equal(fs.existsSync(path.join(f.taskDir, 'commit-intent.json')), false);
  }
});

test('standalone commit without review finalizes without creating a review anchor', () => {
  const f = fixture();
  const begun = beginCommitIntent(taskId, {
    agent: 'codex', orchestrated: false, baselineHead: f.head
  }, { repoRoot: f.root, token: () => 'token' });
  assert.equal(begun.status, 'ready');
  fs.writeFileSync(path.join(f.root, 'source.txt'), 'changed\n');
  git(f.root, ['add', 'source.txt']);
  git(f.root, ['commit', '-qm', 'change']);
  const head = git(f.root, ['rev-parse', 'HEAD']);
  assert.equal(checkpointCommitIntent(taskId, {
    token: 'token', kind: 'committed', head
  }, { repoRoot: f.root }).status, 'ready');

  const completed = completeCommitIntent(taskId, {
    token: 'token', agent: 'codex'
  }, { repoRoot: f.root });

  assert.equal(completed.status, 'ready');
  assert.equal(completed.error, null);
  assert.equal(fs.existsSync(path.join(f.taskDir, 'commit-intent.json')), false);
  const task = fs.readFileSync(path.join(f.taskDir, 'task.md'), 'utf8');
  assert.equal((task.match(/\*\*Commit\*\*/g) || []).length, 1);
  assert.equal(task.includes('last_reviewed_commit:'), false);
});

test('standalone fails before intent creation when any delegation is pending', () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.taskDir, 'orchestration.json'), `${JSON.stringify(activatedRun(), null, 2)}\n`);
  const result = beginCommitIntent(taskId, {
    agent: 'codex', orchestrated: false, baselineHead: f.head
  }, { repoRoot: f.root });
  assert.equal(result.error?.code, 'ORCHESTRATION_STANDALONE_BUSY');
  assert.equal(fs.existsSync(path.join(f.taskDir, 'commit-intent.json')), false);
});

test('orchestrated complete commits the preplanned receipt without consuming authorization', () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.taskDir, 'orchestration.json'), `${JSON.stringify(activatedRun(), null, 2)}\n`);
  const begun = beginCommitIntent(taskId, {
    agent: 'claude', orchestrated: true, baselineHead: f.head
  }, {
    repoRoot: f.root, token: () => 'token', now: () => '2026-01-01T00:00:01.000Z'
  });
  assert.equal(begun.status, 'ready');
  checkpointReviewed(f, 'token');
  assert.equal(completeCommitIntent(taskId, { token: 'token', agent: 'claude' }, { repoRoot: f.root }).status, 'ready');
  assert.equal(readRun(f.taskDir)?.pendingDelegation?.status, 'stage-completed');
  assert.equal(readRun(f.taskDir)?.commitAuthorization.consumedAt, null);
  assert.equal(sealOrchestrationDelegation(taskId, {
    childId: 'child', exitCode: 0, afterFingerprint: 'after', changedPaths: []
  }, { repoRoot: f.root, now: () => '2026-01-01T00:00:02.000Z' }).status, 'running');
  assert.equal(advanceOrchestration(taskId, {
    repoRoot: f.root, now: () => '2026-01-01T00:00:03.000Z'
  }).status, 'completed');
  assert.equal(readRun(f.taskDir)?.commitAuthorization.consumedAt, '2026-01-01T00:00:03.000Z');
});

test('orchestrated complete recovers after the planned run was written but the intent remains', () => {
  const f = fixture();
  const runPath = path.join(f.taskDir, 'orchestration.json');
  fs.writeFileSync(runPath, `${JSON.stringify(activatedRun(), null, 2)}\n`);
  beginCommitIntent(taskId, {
    agent: 'claude', orchestrated: true, baselineHead: f.head
  }, {
    repoRoot: f.root, token: () => 'token', now: () => '2026-01-01T00:00:01.000Z'
  });
  checkpointReviewed(f, 'token');
  const intent = readCommitIntent(f.taskDir, taskId, 'token');
  assert.notEqual(intent.orchestration, null);
  const plannedRun = {
    ...JSON.parse(fs.readFileSync(runPath, 'utf8')),
    pendingDelegation: intent.orchestration!.plannedReceipt,
    updatedAt: intent.orchestration!.completionUpdatedAt
  };
  const plannedBytes = `${JSON.stringify(plannedRun, null, 2)}\n`;
  fs.writeFileSync(runPath, plannedBytes);

  const result = completeCommitIntent(taskId, { token: 'token', agent: 'claude' }, { repoRoot: f.root });
  assert.equal(result.status, 'ready');
  assert.equal(result.changed, true);
  assert.equal(fs.readFileSync(runPath, 'utf8'), plannedBytes);
  assert.equal(fs.existsSync(path.join(f.taskDir, 'commit-intent.json')), false);
});

test('token-less recovery finalizes a committed intent exactly once', () => {
  const f = fixture();
  beginCommitIntent(taskId, {
    agent: 'codex', orchestrated: false, baselineHead: f.head
  }, { repoRoot: f.root, token: () => 'lost-token' });
  const committedHead = checkpointReviewed(f, 'lost-token');

  const recovered = recoverCommitIntent(taskId, { agent: 'codex' }, { repoRoot: f.root });
  assert.equal(recovered.status, 'ready');
  assert.equal(fs.existsSync(path.join(f.taskDir, 'commit-intent.json')), false);
  const content = fs.readFileSync(path.join(f.taskDir, 'task.md'), 'utf8');
  assert.match(content, new RegExp(`^last_reviewed_commit: ${committedHead}$`, 'm'));
  assert.equal((content.match(/\*\*Commit\*\*/g) || []).length, 1);
  assert.equal(statusCommitIntent(taskId, { repoRoot: f.root }).finalization?.disposition, 'idle');
});

test('commit intent status is ready when no intent exists', () => {
  const f = fixture();
  const status = statusCommitIntent(taskId, { repoRoot: f.root });
  assert.equal(status.status, 'ready');
  assert.equal(status.changed, false);
  assert.equal(status.taskId, taskId);
  assert.equal(status.intent, null);
  assert.equal(status.finalization?.disposition, 'orphaned-start');
  assert.equal(status.error, null);
});

test('orchestrated complete fails closed on run drift and retains recovery evidence', () => {
  const f = fixture();
  const runPath = path.join(f.taskDir, 'orchestration.json');
  fs.writeFileSync(runPath, `${JSON.stringify(activatedRun(), null, 2)}\n`);
  beginCommitIntent(taskId, {
    agent: 'claude', orchestrated: true, baselineHead: f.head
  }, { repoRoot: f.root, token: () => 'token' });
  checkpointReviewed(f, 'token');
  const drifted = JSON.parse(fs.readFileSync(runPath, 'utf8'));
  drifted.pause = { code: 'DRIFT', message: 'changed', recoverable: true };
  fs.writeFileSync(runPath, `${JSON.stringify(drifted, null, 2)}\n`);

  const result = completeCommitIntent(taskId, { token: 'token', agent: 'claude' }, { repoRoot: f.root });
  assert.equal(result.error?.code, 'ORCHESTRATION_COMMIT_RECOVERY_REQUIRED');
  assert.equal(fs.existsSync(path.join(f.taskDir, 'commit-intent.json')), true);
});

test('orchestrated begin pauses invalid authorization before creating an intent', () => {
  const f = fixture();
  const invalid = { ...activatedRun(), commitAuthorization: { issuedAt: null, consumedAt: null } };
  fs.writeFileSync(path.join(f.taskDir, 'orchestration.json'), `${JSON.stringify(invalid, null, 2)}\n`);
  const result = beginCommitIntent(taskId, {
    agent: 'claude', orchestrated: true, baselineHead: f.head
  }, { repoRoot: f.root, now: () => '2026-01-01T00:00:01.000Z' });
  assert.equal(result.error?.code, 'ORCHESTRATION_COMMIT_AUTHORIZATION_INVALID');
  assert.equal(readRun(f.taskDir)?.status, 'paused');
  assert.equal(fs.existsSync(path.join(f.taskDir, 'commit-intent.json')), false);
});

test('commit checkpoints follow repository HEAD and active intent blocks prepare', () => {
  const f = fixture();
  const begun = beginCommitIntent(taskId, {
    agent: 'codex', orchestrated: false, baselineHead: f.head
  }, { repoRoot: f.root, token: () => 'token' });
  assert.equal(begun.status, 'ready');
  const blocked = prepareOrchestrationDelegation(taskId, {
    client: 'codex', requestedModel: 'model', requestedReasoningEffort: 'high'
  }, { repoRoot: f.root, supportsLifecycleDelegation: () => true });
  assert.equal(blocked.error?.code, 'ORCHESTRATION_COMMIT_INTENT_BUSY');

  fs.writeFileSync(path.join(f.root, 'source.txt'), 'changed\n');
  git(f.root, ['add', 'source.txt']);
  git(f.root, ['commit', '-qm', 'change']);
  const head = git(f.root, ['rev-parse', 'HEAD']);
  const checkpoint = checkpointCommitIntent(taskId, {
    token: 'token', kind: 'committed', head
  }, { repoRoot: f.root });
  assert.equal(checkpoint.intent?.phase, 'committed');
  assert.equal(checkpoint.intent?.committedHead, head);
  const pushed = checkpointCommitIntent(taskId, {
    token: 'token', kind: 'pushed', head, remote: 'origin', ref: 'refs/heads/feature'
  }, { repoRoot: f.root });
  assert.equal(pushed.intent?.phase, 'pushed');
  assert.deepEqual(pushed.intent?.pushEvidence, { remote: 'origin', ref: 'refs/heads/feature', head });
});

test('commit begin and delegation prepare serialize across independent processes', async () => {
  const f = fixture();
  const modelPolicy = {
    executor: { model: 'executor-model', reasoningEffort: 'high' },
    reviewer: { model: 'reviewer-model', reasoningEffort: 'high' }
  } as const;
  assert.equal(beginOrResumeOrchestration(taskId, {
    repoRoot: f.root, client: 'claude-code', modelPolicy
  }).status, 'running');
  const moduleUrl = new URL('../../../lib/task/orchestration.ts', import.meta.url).href;
  const runChild = (source: string) => new Promise<Record<string, unknown>>((resolve, reject) => {
    const child = spawn(process.execPath, [
      '--experimental-strip-types', '--no-warnings', '--input-type=module', '--eval', source
    ], { cwd: f.root, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', () => {
      if (!stdout.trim()) reject(new Error(stderr));
      else resolve(JSON.parse(stdout));
    });
  });
  const beginSource = `
    import { beginCommitIntent } from ${JSON.stringify(moduleUrl)};
    console.log(JSON.stringify(beginCommitIntent(${JSON.stringify(taskId)}, {
      agent: 'codex', orchestrated: false, baselineHead: ${JSON.stringify(f.head)}
    }, { repoRoot: ${JSON.stringify(f.root)} })));
  `;
  const prepareSource = `
    import { prepareOrchestrationDelegation } from ${JSON.stringify(moduleUrl)};
    console.log(JSON.stringify(prepareOrchestrationDelegation(${JSON.stringify(taskId)}, {
      client: 'claude-code', requestedModel: 'executor-model', requestedReasoningEffort: 'high'
    }, {
      repoRoot: ${JSON.stringify(f.root)}, supportsLifecycleDelegation: () => true,
      captureWorkspace: () => 'snapshot'
    })));
  `;
  const results = await Promise.all([runChild(beginSource), runChild(prepareSource)]);
  assert.equal(results.filter((result) => result.status !== 'failed').length, 1);
  const run = readRun(f.taskDir);
  assert.equal(
    Number(fs.existsSync(path.join(f.taskDir, 'commit-intent.json'))) + Number(run?.pendingDelegation !== null),
    1
  );
});
