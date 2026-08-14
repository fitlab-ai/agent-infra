import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  assertGitWorktreeBinding,
  normalizeCanonicalPath,
  sameFilesystemEntry
} from '../../../lib/git/worktree-identity.ts';

function git(root: string, args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

test('platform path fallback normalizes Windows identity without folding POSIX case', () => {
  assert.equal(
    normalizeCanonicalPath('C:\\Repo\\Feature', 'win32'),
    normalizeCanonicalPath('c:/repo/feature', 'win32')
  );
  assert.notEqual(
    normalizeCanonicalPath('/Repo/Feature', 'darwin'),
    normalizeCanonicalPath('/repo/feature', 'darwin')
  );
});

test('filesystem identity recognizes two canonical names for the same directory', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'worktree-identity-'));
  assert.equal(sameFilesystemEntry(root, path.join(root, '.')), true);
});

test('linked worktree binding accepts the same common directory and rejects another repository', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'worktree-binding-'));
  const main = path.join(root, 'main');
  const linked = path.join(root, 'linked');
  const unrelated = path.join(root, 'unrelated');
  fs.mkdirSync(main);
  git(main, ['init', '-q']);
  git(main, ['config', 'user.name', 'Test']);
  git(main, ['config', 'user.email', 'test@example.com']);
  fs.writeFileSync(path.join(main, 'source.txt'), 'base\n');
  git(main, ['add', 'source.txt']);
  git(main, ['commit', '-qm', 'base']);
  git(main, ['worktree', 'add', '-qb', 'feature', linked]);

  const identity = assertGitWorktreeBinding(main, linked, 'feature');
  assert.equal(identity.worktreeRoot, fs.realpathSync.native(linked));
  assert.equal(identity.branch, 'feature');

  fs.mkdirSync(unrelated);
  git(unrelated, ['init', '-q']);
  assert.throws(
    () => assertGitWorktreeBinding(main, unrelated, 'master'),
    /SANDBOX_CONTROL_WORKTREE_INVALID/
  );
});
