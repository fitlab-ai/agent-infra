import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { CLI_PATH } from '../../helpers.ts';
import { gitSafeEnv, initIsolatedGitRepo } from '../../helpers/git.ts';

const SHORT_ID_SCRIPT = path.resolve(process.cwd(), '.agents/scripts/task-short-id.js');

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
  fs.writeFileSync(path.join(root, '.agents', '.airc.json'), JSON.stringify({ project: 'fixture' }));
  fs.writeFileSync(path.join(taskDir, 'task.md'), `---\nid: ${id}\nbranch: ${branch}\nstatus: active\n---\n# Task\n`);
  fs.writeFileSync(path.join(root, 'tracked.txt'), 'committed\n');
  const allocation = spawnSync('node', [SHORT_ID_SCRIPT, 'alloc', id], { cwd: root, encoding: 'utf8', env: gitSafeEnv() });
  assert.equal(allocation.status, 0, allocation.stderr);
  spawnSync('git', ['add', '.'], { cwd: root, env: gitSafeEnv() });
  const commit = spawnSync('git', ['commit', '-qm', 'fixture'], { cwd: root, env: gitSafeEnv() });
  assert.equal(commit.status, 0, commit.stderr?.toString());
  return { root, id, branch };
}

test('snapshot validation runs at the task commit and removes its temporary worktree', (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(f.root, 'tracked.txt'), 'dirty host state\n');
  const command = [
    'task', 'validate', f.id, '--scope', 'snapshot', '--format', 'json', '--',
    process.execPath, '-e',
    "const fs=require('node:fs');if(process.env.AGENT_INFRA_VALIDATION_SCOPE!=='snapshot'||fs.readFileSync('tracked.txt','utf8')!=='committed\\n')process.exit(9)"
  ];
  const result = spawnSync('node', [CLI_PATH, ...command], { cwd: f.root, encoding: 'utf8', env: gitSafeEnv() });
  assert.equal(result.status, 0, result.stderr);
  const evidence = JSON.parse(result.stdout);
  assert.equal(evidence.taskId, f.id);
  assert.equal(evidence.branch, f.branch);
  assert.equal(evidence.scope, 'snapshot');
  assert.equal(evidence.exitCode, 0);
  assert.equal(evidence.cleanup, 'completed');
  const worktrees = spawnSync('git', ['worktree', 'list', '--porcelain'], { cwd: f.root, encoding: 'utf8', env: gitSafeEnv() });
  assert.equal(worktrees.stdout.match(/^worktree /gm)?.length, 1);
});
