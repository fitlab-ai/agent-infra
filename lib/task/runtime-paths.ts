import fs from 'node:fs';
import path from 'node:path';
import { resolveTaskRef } from './resolve-ref.ts';

function taskDirectories(repoRoot: string, taskId: string): string[] {
  const workspace = path.join(repoRoot, '.agents', 'workspace');
  const candidates = ['active', 'blocked', 'completed']
    .map((state) => path.join(workspace, state, taskId))
    .filter((directory) => fs.existsSync(path.join(directory, 'task.md')));
  const archive = path.join(workspace, 'archive');
  if (fs.existsSync(archive)) {
    for (const year of fs.readdirSync(archive).filter((entry) => /^\d{4}$/u.test(entry))) {
      const yearDir = path.join(archive, year);
      for (const month of fs.readdirSync(yearDir).filter((entry) => /^\d{2}$/u.test(entry))) {
        const monthDir = path.join(yearDir, month);
        for (const day of fs.readdirSync(monthDir).filter((entry) => /^\d{2}$/u.test(entry))) {
          const directory = path.join(monthDir, day, taskId, 'local');
          if (fs.existsSync(path.join(directory, 'task.md'))) candidates.push(directory);
        }
      }
    }
  }
  return candidates;
}

export function resolveTaskRuntimeRoot(
  taskRef: string,
  options: Readonly<{ repoRoot?: string }> = {}
): string {
  const resolved = resolveTaskRef(taskRef, options);
  if (!resolved.ok) throw new Error(`${resolved.code}: ${resolved.message}`);

  const candidates = taskDirectories(resolved.repoRoot, resolved.taskId);
  const canonical = candidates.map((directory) => {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`TASK_RUNTIME_DIRECTORY_INVALID: ${directory}`);
    }
    const taskFile = path.join(directory, 'task.md');
    if (fs.lstatSync(taskFile).isSymbolicLink()) {
      throw new Error(`TASK_RUNTIME_TASK_FILE_INVALID: ${taskFile}`);
    }
    const realDirectory = fs.realpathSync.native(directory);
    const workspaceRoot = fs.realpathSync.native(path.join(resolved.repoRoot, '.agents', 'workspace'));
    const relative = path.relative(workspaceRoot, realDirectory);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`TASK_RUNTIME_DIRECTORY_ESCAPE: ${directory}`);
    }
    return realDirectory;
  });
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
