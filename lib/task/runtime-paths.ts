import fs from 'node:fs';
import path from 'node:path';
import { resolveTaskRef } from './resolve-ref.ts';

function taskDirectories(repoRoot: string, taskId: string): string[] {
  const workspace = path.join(repoRoot, '.agents', 'workspace');
  const candidates = ['active', 'blocked', 'completed']
    .map((state) => path.join(workspace, state, taskId))
    .filter((directory) => fs.existsSync(path.join(directory, 'task.md')));
  candidates.push(...archivedTaskDirectories(path.join(workspace, 'archive'), taskId));
  return candidates;
}

function archivedTaskDirectories(archive: string, taskId: string): string[] {
  if (!fs.existsSync(archive)) return [];
  const directories: string[] = [];
  const dates = fs.readdirSync(archive)
    .filter((year) => /^\d{4}$/u.test(year))
    .flatMap((year) => {
      const yearDir = path.join(archive, year);
      return fs.readdirSync(yearDir)
        .filter((month) => /^\d{2}$/u.test(month))
        .flatMap((month) => {
          const monthDir = path.join(yearDir, month);
          return fs.readdirSync(monthDir)
            .filter((day) => /^\d{2}$/u.test(day))
            .map((day) => path.join(monthDir, day, taskId, 'local'));
        });
    });
  directories.push(...dates);
  return directories.filter((directory) => fs.existsSync(path.join(directory, 'task.md')));
}

function canonicalTaskDirectory(directory: string, workspaceRoot: string): string {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`TASK_RUNTIME_DIRECTORY_INVALID: ${directory}`);
  }
  const taskFile = path.join(directory, 'task.md');
  if (fs.lstatSync(taskFile).isSymbolicLink()) {
    throw new Error(`TASK_RUNTIME_TASK_FILE_INVALID: ${taskFile}`);
  }
  const realDirectory = fs.realpathSync.native(directory);
  const relative = path.relative(workspaceRoot, realDirectory);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`TASK_RUNTIME_DIRECTORY_ESCAPE: ${directory}`);
  }
  return realDirectory;
}

export function resolveTaskRuntimeRoot(
  taskRef: string,
  options: Readonly<{ repoRoot?: string }> = {}
): string {
  const resolved = resolveTaskRef(taskRef, options);
  if (!resolved.ok) throw new Error(`${resolved.code}: ${resolved.message}`);

  const candidates = taskDirectories(resolved.repoRoot, resolved.taskId);
  const workspaceRoot = fs.realpathSync.native(path.join(resolved.repoRoot, '.agents', 'workspace'));
  const canonical = candidates.map((directory) => canonicalTaskDirectory(directory, workspaceRoot));
  const unique = [...new Set(canonical)];
  if (unique.length !== 1) {
    throw new Error(unique.length === 0
      ? `TASK_RUNTIME_TASK_NOT_FOUND: ${resolved.taskId}`
      : `TASK_RUNTIME_TASK_AMBIGUOUS: ${resolved.taskId}`);
  }

  const runtimeRoot = path.join(unique[0]!, '.runtime');
  if (fs.existsSync(runtimeRoot) && fs.lstatSync(runtimeRoot).isSymbolicLink()) {
    throw new Error(`TASK_RUNTIME_ROOT_INVALID: ${runtimeRoot}`);
  }
  return runtimeRoot;
}
