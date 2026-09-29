import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { gitSafeEnv, initIsolatedGitRepo } from '../../helpers/git.ts';
import { materializeSandboxGitMetadata } from '../../../lib/sandbox/git-metadata.ts';

test('sandbox Git metadata projects a linked worktree gitfile without changing the host file', () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-infra-sandbox-git-metadata-'));
  const repoRoot = path.join(fixtureRoot, 'repo');
  const worktreeRoot = path.join(fixtureRoot, 'worktree');
  const unrelatedRepoRoot = path.join(fixtureRoot, 'unrelated-repo');
  const controlDir = path.join(fixtureRoot, 'control');

  try {
    fs.mkdirSync(repoRoot, { recursive: true });
    initIsolatedGitRepo(repoRoot);
    fs.mkdirSync(unrelatedRepoRoot, { recursive: true });
    initIsolatedGitRepo(unrelatedRepoRoot);
    fs.writeFileSync(path.join(repoRoot, 'tracked.txt'), 'tracked\n', 'utf8');
    execFileSync('git', ['-C', repoRoot, 'add', 'tracked.txt'], { env: gitSafeEnv() });
    execFileSync('git', [
      '-C', repoRoot,
      '-c', 'user.name=Sandbox Test',
      '-c', 'user.email=sandbox-test@example.com',
      'commit', '-q', '-m', 'initial'
    ], { env: gitSafeEnv() });
    execFileSync('git', ['-C', repoRoot, 'worktree', 'add', '--detach', worktreeRoot, 'HEAD'], {
      env: gitSafeEnv()
    });

    const hostGitFile = path.join(worktreeRoot, '.git');
    const originalGitFile = fs.readFileSync(hostGitFile, 'utf8');
    const commonDir = execFileSync('git', [
      '-C', worktreeRoot, 'rev-parse', '--path-format=absolute', '--git-common-dir'
    ], { encoding: 'utf8', env: gitSafeEnv() }).trim();
    const adminDir = execFileSync('git', ['-C', worktreeRoot, 'rev-parse', '--absolute-git-dir'], {
      encoding: 'utf8', env: gitSafeEnv()
    }).trim();
    const expectedRelativeGitDir = path.relative(commonDir, adminDir).split(path.sep).join('/');

    const originalGitDir = process.env.GIT_DIR;
    const originalGitCommonDir = process.env.GIT_COMMON_DIR;
    try {
      process.env.GIT_DIR = path.join(unrelatedRepoRoot, '.git');
      process.env.GIT_COMMON_DIR = path.join(unrelatedRepoRoot, '.git');
      const metadata = materializeSandboxGitMetadata(worktreeRoot, controlDir);

      assert.equal(path.normalize(metadata.commonDir), path.normalize(commonDir));
      assert.equal(
        fs.readFileSync(metadata.worktreeGitFile, 'utf8'),
        `gitdir: /run/agent-infra/git/${expectedRelativeGitDir}\n`
      );
    } finally {
      if (originalGitDir === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = originalGitDir;
      if (originalGitCommonDir === undefined) delete process.env.GIT_COMMON_DIR;
      else process.env.GIT_COMMON_DIR = originalGitCommonDir;
    }
    assert.equal(fs.readFileSync(hostGitFile, 'utf8'), originalGitFile);
  } finally {
    if (fs.existsSync(worktreeRoot)) {
      execFileSync('git', ['-C', repoRoot, 'worktree', 'remove', '--force', worktreeRoot], {
        env: gitSafeEnv(), stdio: 'ignore'
      });
    }
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
