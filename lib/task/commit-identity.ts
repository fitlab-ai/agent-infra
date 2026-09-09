import { execFileSync } from 'node:child_process';

import type { CheckpointIntent } from './commit-intent.ts';

function gitText(repoRoot: string, args: readonly string[]): string {
  return execFileSync('git', [...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim();
}

function checkpointCommitMatches(repoRoot: string, intent: CheckpointIntent, head: string): boolean {
  try {
    const parent = gitText(repoRoot, ['rev-parse', `${head}^`]);
    const tree = gitText(repoRoot, ['rev-parse', `${head}^{tree}`]);
    const message = gitText(repoRoot, ['show', '-s', '--format=%s', head]);
    const changed = gitText(repoRoot, ['diff-tree', '--no-commit-id', '--name-only', '-r', head])
      .split('\n')
      .filter(Boolean)
      .sort();
    return parent === intent.expectedHead
      && tree === intent.expectedTree
      && message === intent.message
      && JSON.stringify(changed) === JSON.stringify([...intent.paths].sort());
  } catch {
    return false;
  }
}

export { checkpointCommitMatches };
