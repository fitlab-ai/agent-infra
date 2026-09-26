import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { resolvePrimaryWorktreeRoot } from '../../../../lib/git/primary-worktree.ts';
import { gitSafeEnv, initIsolatedGitRepo, onPlatforms } from '../../../helpers.ts';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: gitSafeEnv() }).trim();
}

function makeRepository(root: string): string {
  fs.mkdirSync(root, { recursive: true });
  initIsolatedGitRepo(root);
  git(root, ['config', 'user.name', 'Test']);
  git(root, ['config', 'user.email', 'test@example.com']);
  fs.writeFileSync(path.join(root, 'base.txt'), 'base\n');
  git(root, ['add', 'base.txt']);
  git(root, ['commit', '-qm', 'base']);
  return root;
}

test('resolves the primary worktree from primary, linked, and detached worktrees without using branch names', onPlatforms('linux', 'darwin', 'win32'), () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'primary-worktree-'));
  const primaryRoot = path.join(tempRoot, 'primary checkout');
  const linkedRoot = path.join(tempRoot, 'linked checkout');
  const detachedRoot = path.join(tempRoot, 'detached checkout');

  try {
    makeRepository(primaryRoot);
    git(primaryRoot, ['branch', '-m', 'primary-checkout']);
    git(primaryRoot, ['worktree', 'add', '-b', 'linked-checkout', linkedRoot]);
    git(primaryRoot, ['worktree', 'add', '--detach', detachedRoot, 'HEAD']);

    const expected = fs.realpathSync(primaryRoot);
    assert.equal(resolvePrimaryWorktreeRoot(primaryRoot), expected);
    assert.equal(resolvePrimaryWorktreeRoot(linkedRoot), expected);
    assert.equal(resolvePrimaryWorktreeRoot(detachedRoot), expected);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('fails closed when Git metadata cannot identify a primary worktree', onPlatforms('linux', 'darwin', 'win32'), () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'primary-worktree-missing-'));
  const primaryRoot = path.join(tempRoot, 'primary');
  const linkedRoot = path.join(tempRoot, 'linked');

  try {
    makeRepository(primaryRoot);
    git(primaryRoot, ['worktree', 'add', '-b', 'linked-checkout', linkedRoot]);
    fs.rmSync(primaryRoot, { recursive: true, force: true });

    assert.throws(
      () => resolvePrimaryWorktreeRoot(linkedRoot),
      (error: unknown) => error instanceof Error && error.message.startsWith('server: unable to locate primary worktree')
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('fails when called outside a Git worktree', onPlatforms('linux', 'darwin', 'win32'), () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'primary-worktree-outside-'));
  try {
    assert.throws(
      () => resolvePrimaryWorktreeRoot(dir),
      (error: unknown) => error instanceof Error && error.message.startsWith('server: unable to locate primary worktree')
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
