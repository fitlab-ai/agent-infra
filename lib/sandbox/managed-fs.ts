import fs from 'node:fs';
import path from 'node:path';
import { run } from './shell.ts';

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
  fs.rmSync(dir, { recursive: true, force: true });
}

export function removeWorktreeDir(repoRoot: string, worktreeBase: string, dir: string): void {
  try {
    run('git', ['-C', repoRoot, 'worktree', 'remove', dir, '--force']);
  } catch {
    removeManagedDir(worktreeBase, dir);
  }
}
