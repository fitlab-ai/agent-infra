import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

import { sameFilesystemEntry } from './worktree-identity.ts';

function gitText(repositoryRoot: string, args: string[]): string {
  return execFileSync('git', ['-C', repositoryRoot, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }).replace(/\r?\n$/, '');
}

function isPrimaryWorktree(candidate: string, expectedCommonDirectory: string): boolean {
  try {
    const root = fs.realpathSync.native(candidate);
    if (!fs.statSync(root).isDirectory()) return false;
    if (gitText(root, ['rev-parse', '--show-prefix']) !== '') return false;

    const commonDirectory = gitText(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    const gitDirectory = gitText(root, ['rev-parse', '--absolute-git-dir']);
    return sameFilesystemEntry(commonDirectory, expectedCommonDirectory) &&
      sameFilesystemEntry(gitDirectory, expectedCommonDirectory);
  } catch {
    return false;
  }
}

function worktreePaths(repositoryRoot: string): string[] {
  const output = execFileSync('git', ['-C', repositoryRoot, 'worktree', 'list', '--porcelain', '-z'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });

  return output
    .split('\0\0')
    .flatMap((record) => record.split('\0'))
    .filter((field) => field.startsWith('worktree '))
    .map((field) => field.slice('worktree '.length));
}

export function resolvePrimaryWorktreeRoot(repositoryRoot: string): string {
  try {
    const root = fs.realpathSync.native(repositoryRoot);
    if (!fs.statSync(root).isDirectory() || gitText(root, ['rev-parse', '--show-prefix']) !== '') {
      throw new Error('repository root is not a worktree root');
    }

    const commonDirectory = gitText(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    const gitDirectory = gitText(root, ['rev-parse', '--absolute-git-dir']);
    if (sameFilesystemEntry(gitDirectory, commonDirectory)) return root;

    const matches = worktreePaths(root).filter((candidate) => isPrimaryWorktree(candidate, commonDirectory));
    if (matches.length !== 1) {
      throw new Error(matches.length === 0 ? 'primary worktree metadata was not found' : 'primary worktree metadata is ambiguous');
    }

    return fs.realpathSync.native(matches[0]!);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`server: unable to locate primary worktree: ${detail}`);
  }
}
