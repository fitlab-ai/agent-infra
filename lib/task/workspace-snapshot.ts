import { createHash } from 'node:crypto';
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

type RepositorySnapshot = Readonly<{
  head: string;
  headTree: string;
  worktreeTree: string;
}>;

type WorkspaceSnapshotContext = Readonly<{
  gitRoot: string;
  stateRoot: string;
  taskId: string | null;
}>;

type TaskFileFingerprint = Readonly<{
  path: string;
  mode: number;
  kind: 'file' | 'symlink';
  sha256: string;
}>;

type OrchestrationWorkspaceFingerprint = Readonly<{
  version: 2;
  gitTree: string;
  taskFiles: readonly TaskFileFingerprint[];
}>;

function captureWorktreeTree(repoRoot: string, forcedPath: string | null): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-infra-orchestration-index-'));
  const indexFile = path.join(tempDir, 'index');
  try {
    git(repoRoot, indexFile, ['read-tree', 'HEAD']);
    git(repoRoot, indexFile, ['add', '-A', '--', ':/']);
    if (forcedPath && fs.existsSync(path.join(repoRoot, forcedPath))) {
      git(repoRoot, indexFile, ['add', '-f', '--', forcedPath]);
    }
    return git(repoRoot, indexFile, ['write-tree']).trim();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function captureLegacyWorkspaceSnapshot(repoRoot: string, taskId: string | null): string {
  const workspaceRelative = taskId
    ? `.agents/workspace/active/${taskId}`
    : '.agents/workspace/active';
  return captureWorktreeTree(repoRoot, workspaceRelative);
}

function taskFileFingerprints(stateRoot: string, taskId: string | null): TaskFileFingerprint[] {
  const activeRoot = path.join(stateRoot, '.agents', 'workspace', 'active');
  const roots = taskId ? [path.join(activeRoot, taskId)] : [activeRoot];
  const records: TaskFileFingerprint[] = [];
  const visit = (absolute: string, relative: string): void => {
    const stat = fs.lstatSync(absolute);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(absolute).sort()) {
        visit(path.join(absolute, name), path.posix.join(relative, name));
      }
      return;
    }
    if (!stat.isFile() && !stat.isSymbolicLink()) return;
    const content = stat.isSymbolicLink()
      ? Buffer.from(fs.readlinkSync(absolute))
      : fs.readFileSync(absolute);
    records.push({
      path: relative,
      mode: stat.mode & 0o777,
      kind: stat.isSymbolicLink() ? 'symlink' : 'file',
      sha256: createHash('sha256').update(content).digest('hex')
    });
  };
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    const relative = path.posix.join('.agents/workspace/active', path.relative(activeRoot, root).split(path.sep).join('/'));
    visit(root, relative.replace(/\/$/, ''));
  }
  return records.sort((left, right) => left.path.localeCompare(right.path));
}

function encodeWorkspaceFingerprint(value: OrchestrationWorkspaceFingerprint): string {
  return `ws2:${Buffer.from(JSON.stringify(value)).toString('base64url')}`;
}

function decodeWorkspaceFingerprint(value: string): OrchestrationWorkspaceFingerprint | null {
  if (!value.startsWith('ws2:')) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value.slice(4), 'base64url').toString('utf8')) as OrchestrationWorkspaceFingerprint;
    if (parsed.version !== 2 || !/^[a-f0-9]{40,64}$/.test(parsed.gitTree) || !Array.isArray(parsed.taskFiles)) {
      throw new Error('invalid workspace fingerprint fields');
    }
    return parsed;
  } catch (error) {
    throw new Error(`ORCHESTRATION_SNAPSHOT_FAILED: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function captureWorkspaceSnapshot(context: WorkspaceSnapshotContext): string;
function captureWorkspaceSnapshot(repoRoot: string, taskId: string | null): string;
function captureWorkspaceSnapshot(contextOrRoot: WorkspaceSnapshotContext | string, taskId?: string | null): string {
  if (typeof contextOrRoot === 'string') return captureLegacyWorkspaceSnapshot(contextOrRoot, taskId ?? null);
  return encodeWorkspaceFingerprint({
    version: 2,
    gitTree: captureWorktreeTree(contextOrRoot.gitRoot, null),
    taskFiles: taskFileFingerprints(contextOrRoot.stateRoot, contextOrRoot.taskId)
  });
}

function captureRepositorySnapshot(repoRoot: string): RepositorySnapshot {
  return {
    head: git(repoRoot, null, ['rev-parse', 'HEAD']).trim(),
    headTree: git(repoRoot, null, ['rev-parse', 'HEAD^{tree}']).trim(),
    worktreeTree: captureWorktreeTree(repoRoot, null)
  };
}

function diffWorkspaceSnapshots(repoRoot: string, before: string, after: string): string[] {
  const beforeV2 = decodeWorkspaceFingerprint(before);
  const afterV2 = decodeWorkspaceFingerprint(after);
  if ((beforeV2 === null) !== (afterV2 === null)) {
    throw new Error('ORCHESTRATION_SNAPSHOT_FAILED: workspace fingerprint versions cannot be mixed');
  }
  if (!beforeV2 || !afterV2) {
    const output = git(repoRoot, null, ['diff', '--name-only', '-z', before, after]);
    return output.split('\0').filter(Boolean);
  }
  const output = git(repoRoot, null, ['diff', '--name-only', '-z', beforeV2.gitTree, afterV2.gitTree]);
  const changed = new Set(output.split('\0').filter(Boolean));
  const beforeFiles = new Map(beforeV2.taskFiles.map((record) => [record.path, JSON.stringify(record)]));
  const afterFiles = new Map(afterV2.taskFiles.map((record) => [record.path, JSON.stringify(record)]));
  for (const filePath of new Set([...beforeFiles.keys(), ...afterFiles.keys()])) {
    if (beforeFiles.get(filePath) !== afterFiles.get(filePath)) changed.add(filePath);
  }
  return [...changed].sort();
}

export { captureRepositorySnapshot, captureWorkspaceSnapshot, diffWorkspaceSnapshots };
export type { OrchestrationWorkspaceFingerprint, RepositorySnapshot, WorkspaceSnapshotContext };
