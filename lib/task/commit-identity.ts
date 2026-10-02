import { execFileSync } from 'node:child_process';

import type { CheckpointIntent } from './commit-intent.ts';

function gitText(repoRoot: string, args: readonly string[]): string {
  return execFileSync('git', [...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim();
}

function gitOutput(repoRoot: string, args: readonly string[]): string {
  return execFileSync('git', [...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

function commitPaths(repoRoot: string, head: string, pathspec?: readonly string[]): string[] {
  const args = ['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', head];
  if (pathspec && pathspec.length > 0) args.push('--', ...pathspec);
  return gitOutput(repoRoot, args).split('\0').filter(Boolean).sort();
}

function canonicalMessage(message: string): string {
  return message.replace(/\r\n/g, '\n').replace(/\n+$/, '');
}

function checkpointCommitMatches(repoRoot: string, intent: CheckpointIntent, head: string): boolean {
  try {
    const parent = gitText(repoRoot, ['rev-parse', `${head}^`]);
    const tree = gitText(repoRoot, ['rev-parse', `${head}^{tree}`]);
    const message = canonicalMessage(gitOutput(repoRoot, ['show', '-s', '--format=%B', head]));
    const changed = commitPaths(repoRoot, head);
    const selected = commitPaths(repoRoot, head, intent.paths);
    return parent === intent.expectedHead
      && tree === intent.expectedTree
      && message === canonicalMessage(intent.message)
      && changed.length > 0
      && JSON.stringify(changed) === JSON.stringify(selected);
  } catch {
    return false;
  }
}

export { checkpointCommitMatches };
