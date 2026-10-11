import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { gitSafeEnv, initIsolatedGitRepo } from '../../helpers/git.ts';
import { envWithPrependedPath, onPlatforms, sandboxControlSafeEnv } from '../../helpers.ts';

const SHORT_ID_SCRIPT = path.resolve(process.cwd(), '.agents/scripts/task-short-id.js');
const internalCli = path.resolve('bin/internal-cli.ts');
const CANONICAL_AGENT_CLIENTS = [
  'claude-code',
  'codex',
  'antigravity-cli',
  'opencode',
  'traecli'
].map((id) => ({ id, enabled: true, installInSandbox: true }));

function spawnTaskValidate(cwd: string, env: NodeJS.ProcessEnv, args: string[]) {
  return spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', internalCli, 'task-validate', ...args], {
    cwd, encoding: 'utf8', env
  });
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-validate-'));
  initIsolatedGitRepo(root);
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: root, env: gitSafeEnv() });
  spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root, env: gitSafeEnv() });
  const id = 'TASK-20260101-000001';
  const branch = 'agent-infra-feature-validation-fixture';
  spawnSync('git', ['switch', '-c', branch], { cwd: root, env: gitSafeEnv() });
  const taskDir = path.join(root, '.agents', 'workspace', 'active', id);
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(root, '.agents', '.airc.json'), JSON.stringify({ project: 'fixture', agentClients: CANONICAL_AGENT_CLIENTS }));
  fs.writeFileSync(path.join(taskDir, 'task.md'), `---\nid: ${id}\nbranch: ${branch}\nstatus: active\n---\n# Task\n`);
  fs.writeFileSync(path.join(root, 'tracked.txt'), 'committed\n');
  const allocation = spawnSync('node', [SHORT_ID_SCRIPT, 'alloc', id], {
    cwd: root, encoding: 'utf8', env: sandboxControlSafeEnv(gitSafeEnv())
  });
  assert.equal(allocation.status, 0, allocation.stderr);
  spawnSync('git', ['add', '.'], { cwd: root, env: gitSafeEnv() });
  const commit = spawnSync('git', ['commit', '-qm', 'fixture'], { cwd: root, env: gitSafeEnv() });
  assert.equal(commit.status, 0, commit.stderr?.toString());
  return { root, id, branch };
}

test('snapshot validation runs at the task commit and removes its temporary worktree', (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const evidenceFile = path.join(f.root, 'task-bound-evidence.json');
  fs.writeFileSync(path.join(f.root, 'tracked.txt'), 'dirty host state\n');
  const command = [
    f.id, '--scope', 'snapshot', '--format', 'json', '--evidence-file', evidenceFile, '--',
    process.execPath, '-e',
    "const fs=require('node:fs');if(process.env.AGENT_INFRA_VALIDATION_SCOPE!=='snapshot'||fs.readFileSync('tracked.txt','utf8')!=='committed\\n')process.exit(9)"
  ];
  const result = spawnTaskValidate(f.root, gitSafeEnv(), command);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.status, 'applied');
  assert.equal(payload.changed, false);
  const evidence = payload.evidence;
  assert.equal(evidence.taskId, f.id);
  assert.equal(evidence.branch, f.branch);
  assert.equal(evidence.scope, 'snapshot');
  assert.equal(evidence.exitCode, 0);
  assert.equal(evidence.cleanup, 'completed');
  const envelope = JSON.parse(fs.readFileSync(evidenceFile, 'utf8'));
  assert.equal(envelope.schema, 'agent-infra/branch-only-validation-evidence');
  assert.equal(envelope.mode, 'task-bound');
  assert.equal(envelope.taskId, f.id);
  assert.equal(envelope.recoverable, true);
  assert.equal(envelope.result.exitCode, 0);
  const worktrees = spawnSync('git', ['worktree', 'list', '--porcelain'], { cwd: f.root, encoding: 'utf8', env: gitSafeEnv() });
  assert.equal(worktrees.stdout.match(/^worktree /gm)?.length, 1);
});

test('snapshot validation completes when global worktree pruning is unavailable', onPlatforms('linux', 'darwin'), (t) => {
  const f = fixture();
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-validate-git-guard-'));
  t.after(() => {
    fs.rmSync(binDir, { recursive: true, force: true });
    fs.rmSync(f.root, { recursive: true, force: true });
  });
  const gitGuard = path.join(binDir, 'git');
  fs.writeFileSync(gitGuard, `#!/bin/sh
if [ "$1" = "worktree" ] && [ "$2" = "prune" ]; then
  exit 86
fi
exec /usr/bin/git "$@"
`);
  fs.chmodSync(gitGuard, 0o755);
  const env = envWithPrependedPath(gitSafeEnv(), binDir);

  const result = spawnTaskValidate(f.root, env, [
    f.id, '--scope', 'snapshot', '--format', 'json', '--', process.execPath, '-e', 'process.exit(0)'
  ]);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.evidence.cleanup, 'completed');
});

test('explicit branch validation writes a non-recoverable branch-only envelope', (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  fs.rmSync(path.join(f.root, '.agents', 'workspace', 'active', f.id), { recursive: true, force: true });
  const evidenceFile = path.join(f.root, 'branch-only-evidence.json');
  const result = spawnTaskValidate(f.root, gitSafeEnv(), [
    f.branch, '--scope', 'snapshot', '--format', 'json', '--evidence-file', evidenceFile, '--',
    process.execPath, '-e', 'process.exit(0)'
  ]);
  assert.equal(result.status, 0, result.stderr);
  const envelope = JSON.parse(fs.readFileSync(evidenceFile, 'utf8'));
  assert.equal(envelope.mode, 'branch-only');
  assert.equal(envelope.taskId, null);
  assert.equal(envelope.recoverable, false);
  assert.equal(envelope.result.cleanup, 'completed');
});

test('inplace validation runs in the host worktree and records the validation result', (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const evidenceFile = path.join(f.root, 'inplace-evidence.json');
  const cwdFile = path.join(f.root, 'inplace-cwd.txt');
  const result = spawnTaskValidate(f.root, gitSafeEnv(), [
    f.id, '--scope', 'inplace', '--format', 'json', '--evidence-file', evidenceFile, '--',
    process.execPath, '-e',
    "const fs=require('node:fs');if(process.env.AGENT_INFRA_VALIDATION_SCOPE!=='inplace')process.exit(9);fs.writeFileSync(process.argv[1],process.cwd());process.exit(17)",
    cwdFile
  ]);
  assert.equal(result.status, 17, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.status, 'applied');
  assert.equal(payload.evidence.taskId, f.id);
  assert.equal(payload.evidence.branch, f.branch);
  assert.equal(payload.evidence.scope, 'inplace');
  assert.equal(payload.evidence.exitCode, 17);
  assert.equal(payload.evidence.cleanup, 'completed');
  assert.equal(fs.readFileSync(cwdFile, 'utf8'), f.root);
  const envelope = JSON.parse(fs.readFileSync(evidenceFile, 'utf8'));
  assert.equal(envelope.mode, 'task-bound');
  assert.equal(envelope.taskId, f.id);
  assert.equal(envelope.result.exitCode, 17);
  const currentBranch = spawnSync('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd: f.root, encoding: 'utf8', env: gitSafeEnv() });
  assert.equal(currentBranch.stdout.trim(), f.branch);
});
