import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

function git(repoRoot: string, indexFile: string | null, args: string[]): string {
  const env = indexFile ? { ...process.env, GIT_INDEX_FILE: indexFile } : process.env;
  const result = spawnSync('git', args, { cwd: repoRoot, env, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(String(result.stderr || result.stdout || `git ${args[0]} failed`).trim());
  }
  return result.stdout;
}

function captureWorkspaceSnapshot(repoRoot: string, taskId: string | null): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-infra-orchestration-index-'));
  const indexFile = path.join(tempDir, 'index');
  try {
    git(repoRoot, indexFile, ['read-tree', 'HEAD']);
    git(repoRoot, indexFile, ['add', '-A', '--', ':/']);
    const workspaceRelative = taskId
      ? `.agents/workspace/active/${taskId}`
      : '.agents/workspace/active';
    const workspace = path.join(repoRoot, workspaceRelative);
    if (fs.existsSync(workspace)) {
      git(repoRoot, indexFile, ['add', '-f', '--', workspaceRelative]);
    }
    return git(repoRoot, indexFile, ['write-tree']).trim();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function diffWorkspaceSnapshots(repoRoot: string, before: string, after: string): string[] {
  const output = git(repoRoot, null, ['diff', '--name-only', '-z', before, after]);
  return output.split('\0').filter(Boolean);
}

export { captureWorkspaceSnapshot, diffWorkspaceSnapshots };
