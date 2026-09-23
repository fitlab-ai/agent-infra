import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { resolveBranchWorktree } from '../../../../lib/git/branch-worktree.ts';
import { gitSafeEnv, initIsolatedGitRepo, onPlatforms } from '../../../helpers.ts';

function git(root: string, args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', env: gitSafeEnv() }).trim();
}

test('resolves the current branch worktree after its registered path becomes unavailable', onPlatforms('linux', 'darwin'), () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'branch-worktree-'));
  const repositoryRoot = path.join(root, 'repository');
  const registeredWorktree = path.join(root, 'registered-worktree');
  const sandboxWorktree = path.join(root, 'sandbox-worktree');
  const branch = 'agent-infra-bugfix-sandbox-path';
  fs.mkdirSync(repositoryRoot);
  initIsolatedGitRepo(repositoryRoot);
  git(repositoryRoot, ['config', 'user.name', 'Test']);
  git(repositoryRoot, ['config', 'user.email', 'test@example.com']);
  fs.writeFileSync(path.join(repositoryRoot, 'base.txt'), 'base\n');
  git(repositoryRoot, ['add', 'base.txt']);
  git(repositoryRoot, ['commit', '-qm', 'base']);
  git(repositoryRoot, ['worktree', 'add', '-qb', branch, registeredWorktree]);
  fs.renameSync(registeredWorktree, sandboxWorktree);

  assert.equal(resolveBranchWorktree(sandboxWorktree, branch), sandboxWorktree);
});
