import path from 'node:path';
import { run, runSafe } from './shell.ts';
import { removeDirRecursive } from '../remove-dir.ts';

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
  { runFn = run, runSafeFn = runSafe }: {
    runFn?: typeof run;
    runSafeFn?: typeof runSafe;
  } = {}
): void {
  try {
    runFn('git', ['-C', repoRoot, 'worktree', 'remove', dir, '--force']);
  } catch {
    // On WSL2 the worktree is registered under its `/mnt/<drive>/...` path, so
    // `git worktree remove <windows-path>` cannot match it. Delete the managed
    // directory directly, then prune the now-dangling worktree metadata so the
    // branch is no longer reported as checked out.
    removeManagedDir(worktreeBase, dir);
    runSafeFn('git', ['-C', repoRoot, 'worktree', 'prune']);
  }
}
