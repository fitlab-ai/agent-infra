import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const SANDBOX_GIT_COMMON_DIR = '/run/agent-infra/git';

export type SandboxGitMetadata = Readonly<{
  commonDir: string;
  worktreeGitFile: string;
  worktreeGitFileContent: string;
}>;

function gitText(worktreeRoot: string, args: string[]): string {
  const env = { ...process.env };
  for (const key of [
    'GIT_DIR',
    'GIT_COMMON_DIR',
    'GIT_WORK_TREE',
    'GIT_INDEX_FILE',
    'GIT_PREFIX',
    'GIT_NAMESPACE',
    'GIT_OBJECT_DIRECTORY',
    'GIT_CEILING_DIRECTORIES',
    'GIT_DISCOVERY_ACROSS_FILESYSTEM'
  ]) {
    delete env[key];
  }
  return execFileSync('git', ['-C', worktreeRoot, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env
  }).trim();
}

export function resolveSandboxGitMetadata(
  worktreeRoot: string,
  controlDir: string
): SandboxGitMetadata {
  const commonDir = fs.realpathSync.native(gitText(worktreeRoot, [
    'rev-parse', '--path-format=absolute', '--git-common-dir'
  ]));
  const gitDir = fs.realpathSync.native(gitText(worktreeRoot, ['rev-parse', '--absolute-git-dir']));
  const relativeGitDir = path.relative(commonDir, gitDir);
  if (path.isAbsolute(relativeGitDir) || relativeGitDir.startsWith(`..${path.sep}`) || relativeGitDir === '..') {
    throw new Error('SANDBOX_GIT_METADATA_INVALID: worktree git directory is outside its common directory');
  }

  const containerGitDir = relativeGitDir === '.'
    ? SANDBOX_GIT_COMMON_DIR
    : path.posix.join(SANDBOX_GIT_COMMON_DIR, ...relativeGitDir.split(path.sep));
  return {
    commonDir,
    worktreeGitFile: path.join(controlDir, 'workspace.git'),
    worktreeGitFileContent: `gitdir: ${containerGitDir}\n`
  };
}

export function materializeSandboxGitMetadata(
  worktreeRoot: string,
  controlDir: string
): SandboxGitMetadata {
  const metadata = resolveSandboxGitMetadata(worktreeRoot, controlDir);
  fs.mkdirSync(controlDir, { recursive: true });
  fs.writeFileSync(metadata.worktreeGitFile, metadata.worktreeGitFileContent, 'utf8');
  return metadata;
}
