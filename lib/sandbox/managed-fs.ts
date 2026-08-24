import path from 'node:path';
import { run, runSafe } from './shell.ts';
import { removeDirRecursive } from '../remove-dir.ts';
import { verifyWorktreePermit } from './worktree-safety.ts';
import type { WorktreeRemovalPermit } from './worktree-safety.ts';

export function assertManagedPath(root: string, target: string): void {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  const relative = path.relative(resolvedRoot, resolvedTarget);
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    return;
  }

  throw new Error(`Refusing to remove path outside managed sandbox root: ${target}`);
}

export function removeManagedDir(root: string, dir: string): void {
  assertManagedPath(root, dir);
  removeDirRecursive(dir);
}

export function removeWorktreeDir(
  repoRoot: string,
  worktreeBase: string,
  dir: string,
  permit: WorktreeRemovalPermit,
  { runFn = run, runSafeFn = runSafe, allowRegisteredPathFallback = false }: {
    runFn?: typeof run;
    runSafeFn?: typeof runSafe;
    allowRegisteredPathFallback?: boolean;
  } = {}
): void {
  assertManagedPath(worktreeBase, dir);
  if (path.resolve(permit.snapshot.worktree) !== path.resolve(dir)) {
    throw new Error(`Worktree permit target mismatch: ${dir}`);
  }
  verifyWorktreePermit(permit);
  if (permit.snapshot.source === 'recovered') {
    removeManagedDir(worktreeBase, dir);
    runSafeFn('git', ['-C', repoRoot, 'worktree', 'prune']);
    return;
  }
  try {
    runFn('git', ['-C', repoRoot, 'worktree', 'remove', dir, '--force']);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const registeredPathMismatch = /(?:is not|not a valid) working tree|not a working tree/i.test(message);
    if (!allowRegisteredPathFallback || !registeredPathMismatch) {
      throw error;
    }
    // On WSL2 the worktree is registered under its `/mnt/<drive>/...` path, so
    // `git worktree remove <windows-path>` cannot match it. Delete the managed
    // directory directly, then prune the now-dangling worktree metadata so the
    // branch is no longer reported as checked out.
    verifyWorktreePermit(permit);
    removeManagedDir(worktreeBase, dir);
    runSafeFn('git', ['-C', repoRoot, 'worktree', 'prune']);
  }
}
