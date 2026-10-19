import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { createTempDir, INTERNAL_CLI_PATH, filePath, gitSafeEnv, sandboxControlSafeEnv, taskWorkspaceProject, taskWorkspaceRoot } from '../../helpers.ts';
import { buildBoundFact, encodePrDeliveryFact } from '../../../lib/task/pr-delivery-fact.ts';

const TASK_ID = 'TASK-20260101-000001';

function taskRoot(root: string): string {
  return taskWorkspaceRoot(root, path.join(root, '.home'));
}

function fixture() {
  const root = createTempDir('complete-task-preflight-');
  spawnSync('git', ['init', '-q'], { cwd: root });
  const home = path.join(root, '.home');
  fs.mkdirSync(home, { recursive: true });
  const activeDir = path.join(taskRoot(root), 'active', TASK_ID);
  fs.mkdirSync(activeDir, { recursive: true });
  fs.mkdirSync(path.join(root, '.agents', 'skills', 'complete-task', 'config'), { recursive: true });
  fs.writeFileSync(path.join(root, '.agents', '.airc.json'), JSON.stringify({ project: taskWorkspaceProject(root), prFlow: 'disabled', task: { shortIdLength: 2 } }));
  fs.writeFileSync(path.join(taskRoot(root), 'active', '.short-ids.json'), `${JSON.stringify({ version: 1, ids: { '01': TASK_ID } })}\n`);
  fs.writeFileSync(path.join(root, '.agents', 'skills', 'complete-task', 'config', 'verify.json'), JSON.stringify({
    skill: 'complete-task', checks: { 'required-pr-delivery': null }
  }));
  fs.writeFileSync(path.join(activeDir, 'task.md'), [
    '---', `id: ${TASK_ID}`, 'status: active', 'current_step: code-review',
    'updated_at: 2026-01-01 00:00:00+00:00', 'agent_infra_version: v0.0.0',
    'target_date:', '---', '', '# Task', '', '## Review Disagreement Ledger', '',
    '| id | stage | round | severity | status | evidence |',
    '|----|-------|-------|----------|--------|----------|', '', '## Workflow Warnings', '',
    '| id | time | step | severity | code | status | target | message | action | resolved_at | resolution |',
    '|----|------|------|----------|------|--------|--------|---------|--------|-------------|------------|',
    '', '## Activity Log', ''
  ].join('\n'));
  return { root, home, activeDir };
}

function writeControlManifest(root: string, controlRoot: string): void {
  for (const name of ['channel', 'public', 'processing', 'runtime']) fs.mkdirSync(path.join(controlRoot, name), { recursive: true });
  fs.writeFileSync(path.join(controlRoot, 'manifest.json'), `${JSON.stringify({
    branch: 'fixture-branch', channelDir: 'channel', container: 'fixture-container',
    containerIdentity: { id: 'fixture-container-id', labels: {} }, engine: 'docker', generation: 'fixture-generation',
    mode: 'task-bound', processingDir: 'processing', project: taskWorkspaceProject(root), publicStatusDir: 'public',
    repoRoot: root, runtimeDir: 'runtime', taskId: TASK_ID, token: 'fixture-token', worktreeRoot: root,
    authorityEvidence: {
      version: 1, provider: 'docker', lockDomain: 'a'.repeat(64), routeKind: 'default', routeSelector: {},
      normalizedEndpoint: 'unix:///var/run/docker.sock', endpointFingerprint: 'b'.repeat(64),
      daemonIdentity: { kind: 'docker-server-id', fingerprint: 'c'.repeat(64) },
      apiVersion: { major: 1, minor: 44 }, authorityFingerprint: 'd'.repeat(64)
    },
    controlRootId: 'e'.repeat(96)
  })}\n`);
}

function run(root: string, args: string[]) {
  const home = path.join(root, '.home');
  fs.mkdirSync(home, { recursive: true });
  return spawnSync(process.execPath, [INTERNAL_CLI_PATH, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: sandboxControlSafeEnv({ ...process.env, HOME: home })
  });
}

test('compiled preflight does not require a checks snapshot for a bound historical PR', () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.root, 'README.md'), 'fixture\n');
    spawnSync('git', ['config', 'user.name', 'Test User'], { cwd: f.root });
    spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: f.root });
    spawnSync('git', ['add', 'README.md'], { cwd: f.root });
    const committed = spawnSync('git', ['commit', '-qm', 'fixture'], { cwd: f.root, encoding: 'utf8' });
    assert.equal(committed.status, 0, committed.stderr);
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: f.root, encoding: 'utf8' }).stdout.trim();
    spawnSync('git', ['remote', 'add', 'origin', 'https://github.com/acme/demo.git'], { cwd: f.root });

    fs.writeFileSync(path.join(f.root, '.agents', '.airc.json'), JSON.stringify({
      project: taskWorkspaceProject(f.root),
      platform: { type: 'github' },
      prFlow: 'disabled',
      task: { shortIdLength: 2 }
    }));
    fs.writeFileSync(path.join(f.root, '.agents', 'skills', 'complete-task', 'config', 'verify.json'), JSON.stringify({
      skill: 'complete-task',
      checks: { 'required-pr-delivery': null }
    }));
    fs.writeFileSync(path.join(f.activeDir, 'task.md'), [
      '---', `id: ${TASK_ID}`, 'status: active', 'current_step: code-review',
      'updated_at: 2026-01-01 00:00:00+00:00', 'agent_infra_version: v0.0.0',
      `pr_delivery_fact: ${JSON.stringify(encodePrDeliveryFact(buildBoundFact({
        identity: { resource: { kind: 'number', value: 42 }, repository: 'acme/demo', url: 'https://github.com/acme/demo/pull/42', head: { repository: 'acme/demo', ref: 'feature', sha: head }, base: { repository: 'acme/demo', ref: 'main', sha: 'b'.repeat(40) } }, source: 'reused', verifiedAt: '2026-01-01T00:00:00.000Z', remoteState: 'closed', mergedAt: '2026-08-01T00:00:00Z', mergeCommitSha: 'c'.repeat(40)
      })))}`, `last_reviewed_commit: ${head}`,
      'target_date:', '---', '', '# Task', '', '## Review Disagreement Ledger', '',
      '| id | stage | round | severity | status | evidence |',
      '|----|-------|-------|----------|--------|----------|', ''
    ].join('\n'));

    const result = spawnSync(filePath('bin/internal-cli.sh'), [
      'task-verify', TASK_ID, 'complete-task.preflight', '--format', 'json'
    ], {
      cwd: f.root,
      encoding: 'utf8',
      env: sandboxControlSafeEnv(gitSafeEnv({ ...process.env, HOME: f.home }))
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.deepEqual(
      payload.invocations.map((invocation: { payload: { type: string } }) => invocation.payload.type),
      ['required-pr-delivery']
    );
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('preflight success releases only this task short id when its sandbox control root is absent', () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(taskRoot(f.root), 'active', '.short-ids.json'), `${JSON.stringify({ version: 1, ids: { '01': TASK_ID, '02': 'TASK-20260101-000002' } })}\n`);
    const preflight = run(f.root, ['task-verify', TASK_ID, 'complete-task.preflight', '--format', 'text']);
    assert.equal(preflight.status, 0, preflight.stderr);
    assert.match(preflight.stdout, /Verification: pass \| Target: complete-task\.preflight \| Skill: complete-task/);
    assert.match(preflight.stdout, /Result: \d+ passed, 0 failed/);
    const completed = run(f.root, ['task-finalization', TASK_ID, 'complete', '--agent', 'codex']);
    assert.equal(completed.status, 0, JSON.stringify(completed));
    assert.equal(JSON.parse(completed.stdout).status, 'completed');
    assert.equal(fs.existsSync(path.join(taskRoot(f.root), 'completed', TASK_ID, 'task.md')), true);
    assert.equal(run(f.root, ['task-context', 'resolve', '01']).status, 1);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(taskRoot(f.root), 'active', '.short-ids.json'), 'utf8')).ids, { '02': 'TASK-20260101-000002' });
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('host finalization CLI completes the terminal sequence and makes replay idempotent', () => {
  const f = fixture();
  try {
    const first = run(f.root, ['task-finalization', TASK_ID, 'complete', '--agent', 'codex']);
    assert.equal(first.status, 0, first.stderr || first.stdout);
    const firstPayload = JSON.parse(first.stdout);
    assert.equal(firstPayload.status, 'completed');
    assert.equal(firstPayload.accepted, true);
    assert.equal(firstPayload.result.status, 'completed');
    assert.equal(fs.existsSync(path.join(taskRoot(f.root), 'completed', TASK_ID, 'task.md')), true);

    const second = run(f.root, ['task-finalization', TASK_ID, 'complete', '--agent', 'codex']);
    assert.equal(second.status, 0, second.stderr || second.stdout);
    const secondPayload = JSON.parse(second.stdout);
    assert.equal(secondPayload.status, 'completed');
    assert.equal(secondPayload.changed, false);
    assert.equal((fs.readFileSync(path.join(taskRoot(f.root), 'completed', TASK_ID, 'task.md'), 'utf8').match(/Complete Task/g) ?? []).length, 2);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('successful replay releases the short id after the target sandbox control root is removed', () => {
  const f = fixture();
  const controlRoot = path.join(f.home, '.agent-infra', 'sandbox-control', taskWorkspaceProject(f.root), 'tasks', TASK_ID);
  try {
    writeControlManifest(f.root, controlRoot);
    const first = run(f.root, ['task-finalization', TASK_ID, 'complete', '--agent', 'codex']);
    assert.equal(first.status, 0, first.stderr || first.stdout);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(taskRoot(f.root), 'active', '.short-ids.json'), 'utf8')).ids, { '01': TASK_ID });

    fs.rmSync(controlRoot, { recursive: true, force: true });
    const replay = run(f.root, ['task-finalization', TASK_ID, 'complete', '--agent', 'codex']);
    assert.equal(replay.status, 0, replay.stderr || replay.stdout);
    const replayPayload = JSON.parse(replay.stdout);
    assert.equal(replayPayload.status, 'completed');
    assert.equal(replayPayload.changed, true);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(taskRoot(f.root), 'active', '.short-ids.json'), 'utf8')).ids, {});
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('failed short id release after successful replay can be retried', () => {
  const f = fixture();
  const controlRoot = path.join(f.home, '.agent-infra', 'sandbox-control', taskWorkspaceProject(f.root), 'tasks', TASK_ID);
  const activeDir = path.join(taskRoot(f.root), 'active');
  const lockPath = path.join(activeDir, '.short-ids.json.lock');
  try {
    writeControlManifest(f.root, controlRoot);
    const first = run(f.root, ['task-finalization', TASK_ID, 'complete', '--agent', 'codex']);
    assert.equal(first.status, 0, first.stderr || first.stdout);
    fs.rmSync(controlRoot, { recursive: true, force: true });
    fs.mkdirSync(lockPath);

    const blocked = run(f.root, ['task-finalization', TASK_ID, 'complete', '--agent', 'codex']);
    assert.notEqual(blocked.status, 0);
    assert.equal(JSON.parse(blocked.stdout).status, 'blocked');
    assert.equal(JSON.parse(fs.readFileSync(path.join(activeDir, '.short-ids.json'), 'utf8')).ids['01'], TASK_ID);

    fs.rmdirSync(lockPath);
    const retry = run(f.root, ['task-finalization', TASK_ID, 'complete', '--agent', 'codex']);
    assert.equal(retry.status, 0, retry.stderr || retry.stdout);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(activeDir, '.short-ids.json'), 'utf8')).ids, {});
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('malformed target control state prevents short id release', () => {
  const f = fixture();
  const controlRoot = path.join(f.home, '.agent-infra', 'sandbox-control', taskWorkspaceProject(f.root), 'tasks', TASK_ID);
  const registryPath = path.join(taskRoot(f.root), 'active', '.short-ids.json');
  try {
    fs.mkdirSync(controlRoot, { recursive: true });
    fs.writeFileSync(path.join(controlRoot, 'manifest.json'), '{}\n');

    const result = run(f.root, ['task-finalization', TASK_ID, 'complete', '--agent', 'codex']);
    assert.notEqual(result.status, 0);
    assert.equal(JSON.parse(result.stdout).status, 'failed');
    assert.equal(JSON.parse(fs.readFileSync(registryPath, 'utf8')).ids['01'], TASK_ID);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('completed verification resolves the archived task without moving it back to active', () => {
  const f = fixture();
  try {
    assert.equal(run(f.root, ['task-finalization', TASK_ID, 'complete', '--agent', 'codex']).status, 0);
    const verified = run(f.root, ['task-verify', TASK_ID, 'complete-task.completed', '--format', 'text']);
    assert.equal(verified.status, 0, verified.stderr);
    assert.match(verified.stdout, /Verification: pass \| Target: complete-task\.completed \| Skill: complete-task/);
    assert.equal(fs.existsSync(path.join(taskRoot(f.root), 'active', TASK_ID, 'task.md')), false);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});
