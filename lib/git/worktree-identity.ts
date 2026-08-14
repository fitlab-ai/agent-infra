import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

type GitWorktreeIdentity = Readonly<{
  worktreeRoot: string;
  commonDir: string;
  branch: string;
}>;

function normalizeCanonicalPath(value: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32'
    ? path.win32.normalize(value).replaceAll('/', '\\').toLowerCase()
    : path.posix.normalize(value);
}

function sameFilesystemEntry(left: string, right: string, platform: NodeJS.Platform = process.platform): boolean {
  const leftReal = fs.realpathSync.native(left);
  const rightReal = fs.realpathSync.native(right);
  const leftStat = fs.statSync(leftReal, { bigint: true });
  const rightStat = fs.statSync(rightReal, { bigint: true });
  if (leftStat.ino !== 0n && rightStat.ino !== 0n) {
    return leftStat.dev === rightStat.dev && leftStat.ino === rightStat.ino;
  }
  return normalizeCanonicalPath(leftReal, platform) === normalizeCanonicalPath(rightReal, platform);
}

function git(root: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim();
}

function resolveGitWorktreeIdentity(worktreeRoot: string): GitWorktreeIdentity {
  try {
    const canonical = fs.realpathSync.native(worktreeRoot);
    const topLevel = fs.realpathSync.native(git(canonical, ['rev-parse', '--show-toplevel']));
    if (!sameFilesystemEntry(canonical, topLevel)) {
      throw new Error('worktree root is not the Git top-level directory');
    }
    const commonDir = fs.realpathSync.native(git(canonical, [
      'rev-parse', '--path-format=absolute', '--git-common-dir'
    ]));
    const branch = git(canonical, ['symbolic-ref', '--short', 'HEAD']);
    return { worktreeRoot: canonical, commonDir, branch };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`SANDBOX_CONTROL_WORKTREE_INVALID: ${message}`);
  }
}

function assertGitWorktreeBinding(
  stateRoot: string,
  worktreeRoot: string,
  expectedBranch: string
): GitWorktreeIdentity {
  const state = resolveGitWorktreeIdentity(stateRoot);
  const worktree = resolveGitWorktreeIdentity(worktreeRoot);
  if (!sameFilesystemEntry(state.commonDir, worktree.commonDir)) {
    throw new Error('SANDBOX_CONTROL_WORKTREE_INVALID: state and worktree roots have different Git common directories');
  }
  if (worktree.branch !== expectedBranch) {
    throw new Error(`SANDBOX_CONTROL_WORKTREE_INVALID: expected branch '${expectedBranch}', got '${worktree.branch}'`);
  }
  return worktree;
}

function assertGitRepositoryBinding(stateRoot: string, worktreeRoot: string): GitWorktreeIdentity {
  const state = resolveGitWorktreeIdentity(stateRoot);
  const worktree = resolveGitWorktreeIdentity(worktreeRoot);
  if (!sameFilesystemEntry(state.commonDir, worktree.commonDir)) {
    throw new Error('SANDBOX_CONTROL_WORKTREE_INVALID: state and worktree roots have different Git common directories');
  }
  return worktree;
}

export {
  assertGitWorktreeBinding,
  assertGitRepositoryBinding,
  normalizeCanonicalPath,
  resolveGitWorktreeIdentity,
  sameFilesystemEntry
};
export type { GitWorktreeIdentity };
