import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { resolveTaskRef } from './resolve-ref.ts';
import type { ResolveTaskRefErrorCode, TaskWorkspaceState } from './resolve-ref.ts';

type SnapshotObservationName = 'git' | 'task-directory' | 'task-tail';
type SnapshotObservation = {
  name: SnapshotObservationName;
  status: 'ready' | 'failed';
  command: string;
  output: string | null;
  error: string | null;
};
type SnapshotErrorCode = ResolveTaskRefErrorCode
  | 'SNAPSHOT_GIT_FAILED'
  | 'SNAPSHOT_DIRECTORY_READ_FAILED'
  | 'SNAPSHOT_TASK_READ_FAILED';
type TaskSnapshotResult = {
  status: 'ready' | 'failed';
  changed: false;
  requestRef: string;
  taskId: string | null;
  taskDir: string | null;
  taskState: TaskWorkspaceState | null;
  observations: readonly SnapshotObservation[];
  evidence: string | null;
  error: { code: SnapshotErrorCode; message: string } | null;
};
type SnapshotOptions = {
  repoRoot?: string;
  gitStatus?: (repoRoot: string) => string;
  readDirectory?: (taskDir: string) => fs.Dirent[];
  lstat?: (entryPath: string) => fs.Stats;
  readTask?: (taskMdPath: string) => string;
};

function relativeDisplay(repoRoot: string, target: string): string {
  return path.relative(repoRoot, target).split(path.sep).join('/');
}

function stripOneTrailingNewline(value: string): string {
  return value.endsWith('\r\n') ? value.slice(0, -2) : value.endsWith('\n') ? value.slice(0, -1) : value;
}

function defaultGitStatus(repoRoot: string): string {
  return execFileSync('git', ['-c', 'core.quotePath=true', 'status', '--short', '--untracked-files=all'], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe']
  });
}

function displayName(name: string): string {
  return /[\t\r\n]/.test(name) ? JSON.stringify(name) : name;
}

function renderDirectory(entries: fs.Dirent[], taskDir: string, lstat: (entryPath: string) => fs.Stats): string {
  return [...entries]
    .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
    .map((entry) => {
      const stat = lstat(path.join(taskDir, entry.name));
      const type = stat.isSymbolicLink() ? 'l' : stat.isDirectory() ? 'd' : stat.isFile() ? 'f' : 'o';
      const bytes = type === 'f' ? String(stat.size) : '-';
      return `${type}\t${bytes}\t${displayName(entry.name)}`;
    })
    .join('\n');
}

function renderTail(content: string): string {
  const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (normalized.length === 0) return '';
  const lines = normalized.endsWith('\n') ? normalized.slice(0, -1).split('\n') : normalized.split('\n');
  return lines.slice(-10).join('\n');
}

function renderTaskSnapshot(observations: readonly SnapshotObservation[]): string {
  return observations.map((observation) => {
    const output = observation.output === '' ? '(empty)' : observation.output;
    return `${observation.command}\n${output}`;
  }).join('\n');
}

function collectTaskSnapshot(taskRef: string, options: SnapshotOptions = {}): TaskSnapshotResult {
  const resolved = resolveTaskRef(taskRef, { repoRoot: options.repoRoot });
  if (!resolved.ok) {
    return {
      status: 'failed', changed: false, requestRef: taskRef, taskId: resolved.taskId,
      taskDir: null, taskState: null, observations: [], evidence: null,
      error: { code: resolved.code, message: resolved.message }
    };
  }

  const taskPath = relativeDisplay(resolved.repoRoot, resolved.taskMdPath);
  const taskDirPath = relativeDisplay(resolved.repoRoot, resolved.taskDir);
  const observations: SnapshotObservation[] = [];
  try {
    const output = stripOneTrailingNewline((options.gitStatus ?? defaultGitStatus)(resolved.repoRoot));
    observations.push({ name: 'git', status: 'ready', command: '$ git status -s', output, error: null });
  } catch (error) {
    return failedSnapshot(resolved, taskRef, observations, 'git', '$ git status -s', 'SNAPSHOT_GIT_FAILED', error);
  }
  try {
    const entries = (options.readDirectory ?? ((dir) => fs.readdirSync(dir, { withFileTypes: true })))(resolved.taskDir);
    const output = renderDirectory(entries, resolved.taskDir, options.lstat ?? fs.lstatSync);
    observations.push({ name: 'task-directory', status: 'ready', command: `$ ls -la ${taskDirPath}/`, output, error: null });
  } catch (error) {
    return failedSnapshot(resolved, taskRef, observations, 'task-directory', `$ ls -la ${taskDirPath}/`, 'SNAPSHOT_DIRECTORY_READ_FAILED', error);
  }
  try {
    const content = (options.readTask ?? ((file) => fs.readFileSync(file, 'utf8')))(resolved.taskMdPath);
    observations.push({ name: 'task-tail', status: 'ready', command: `$ tail ${taskPath}`, output: renderTail(content), error: null });
  } catch (error) {
    return failedSnapshot(resolved, taskRef, observations, 'task-tail', `$ tail ${taskPath}`, 'SNAPSHOT_TASK_READ_FAILED', error);
  }
  return {
    status: 'ready', changed: false, requestRef: taskRef, taskId: resolved.taskId,
    taskDir: resolved.taskDir, taskState: resolved.state, observations,
    evidence: renderTaskSnapshot(observations), error: null
  };
}

function failedSnapshot(
  resolved: Extract<ReturnType<typeof resolveTaskRef>, { ok: true }>,
  taskRef: string,
  observations: SnapshotObservation[],
  name: SnapshotObservationName,
  command: string,
  code: SnapshotErrorCode,
  error: unknown
): TaskSnapshotResult {
  const message = error instanceof Error ? error.message : String(error);
  observations.push({ name, status: 'failed', command, output: null, error: message });
  return {
    status: 'failed', changed: false, requestRef: taskRef, taskId: resolved.taskId,
    taskDir: resolved.taskDir, taskState: resolved.state, observations,
    evidence: null, error: { code, message }
  };
}

export { collectTaskSnapshot, renderTaskSnapshot };
export type { SnapshotErrorCode, SnapshotObservation, SnapshotOptions, TaskSnapshotResult };
