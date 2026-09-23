import { execFileSync } from 'node:child_process';

function gitText(repositoryRoot: string, args: string[]): string | null {
  try {
    return execFileSync('git', ['-C', repositoryRoot, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim();
  } catch {
    return null;
  }
}

function verifiedWorktreeRoot(candidate: string, expectedBranch: string): string | null {
  const root = gitText(candidate, ['rev-parse', '--show-toplevel']);
  if (!root) return null;
  const branch = gitText(root, ['symbolic-ref', '--short', 'HEAD']);
  return branch === expectedBranch ? root : null;
}

export function resolveBranchWorktree(repositoryRoot: string, expectedBranch: string): string | null {
  const currentRoot = verifiedWorktreeRoot(repositoryRoot, expectedBranch);
  if (currentRoot) return currentRoot;

  const records = gitText(repositoryRoot, ['worktree', 'list', '--porcelain']);
  if (!records) return null;
  const expectedRef = `refs/heads/${expectedBranch}`;
  for (const record of records.split(/\r?\n\r?\n/)) {
    const candidate = /^worktree (.+)$/m.exec(record)?.[1];
    const branch = /^branch (.+)$/m.exec(record)?.[1];
    if (candidate && branch === expectedRef) {
      const verifiedRoot = verifiedWorktreeRoot(candidate, expectedBranch);
      if (verifiedRoot) return verifiedRoot;
    }
  }
  return null;
}
