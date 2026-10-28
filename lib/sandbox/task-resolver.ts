import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectTaskWorkspaceRoot } from '../task/workspace-root.ts';

const TASK_ID_RE = /^TASK-\d{8}-\d{6}$/;
export const TASK_WORKSPACE_STATES = ['active', 'completed', 'blocked', 'archive'] as const;
export type TaskWorkspaceState = typeof TASK_WORKSPACE_STATES[number];
export type TaskWorkspace = Readonly<{
  taskId: string;
  branch: string;
  state: TaskWorkspaceState;
  taskMd: string;
}>;

function stripQuotes(value: string): string {
  return value.replace(/^(["'])(.*)\1$/, '$2');
}

function taskWorkspaceCandidates(repoRoot: string, taskId: string): TaskWorkspace[] {
  const taskRoot = resolveProjectTaskWorkspaceRoot(repoRoot);
  const hot = TASK_WORKSPACE_STATES.filter((state) => state !== 'archive').flatMap((state) => {
    const taskMd = path.join(taskRoot, state, taskId, 'task.md');
    if (!fs.existsSync(taskMd)) return [];
    const content = fs.readFileSync(taskMd, 'utf8');
    return [{
      taskId,
      branch: resolveBranchFromTaskContent(content, taskId),
      state,
      taskMd
    }];
  });
  const parts = findArchiveTaskParts(repoRoot, taskId);
  if (parts.length === 0) return hot;
  const taskMd = path.join(taskRoot, 'archive', ...parts, 'local', 'task.md');
  if (!fs.existsSync(taskMd)) return hot;
  const content = fs.readFileSync(taskMd, 'utf8');
  return [...hot, {
    taskId,
    branch: resolveBranchFromTaskContent(content, taskId),
    state: 'archive',
    taskMd
  }];
}

function findArchiveTaskParts(repoRoot: string, taskId: string): string[] {
  const archiveRoot = path.join(resolveProjectTaskWorkspaceRoot(repoRoot), 'archive');
  if (!fs.existsSync(archiveRoot)) return [];
  for (const year of fs.readdirSync(archiveRoot).sort().reverse()) {
    if (!/^\d{4}$/.test(year)) continue;
    for (const month of fs.readdirSync(path.join(archiveRoot, year)).sort().reverse()) {
      if (!/^\d{2}$/.test(month)) continue;
      for (const day of fs.readdirSync(path.join(archiveRoot, year, month)).sort().reverse()) {
        if (/^\d{2}$/.test(day) && fs.existsSync(path.join(archiveRoot, year, month, day, taskId, 'local', 'task.md'))) return [year, month, day, taskId];
      }
    }
  }
  return [];
}

function resolveBranchFromTaskContent(content: string, taskId: string): string {
  const frontmatterBranch = content.match(/^branch:\s*(.+)$/m);
  if (frontmatterBranch?.[1]?.trim()) {
    return stripQuotes(frontmatterBranch[1].trim());
  }

  const contextBranch = content.match(/^- \*\*(?:分支|Branch)\*\*：[ \t]*`?([^`\n]+)`?$/m);
  if (contextBranch?.[1]?.trim()) {
    return stripQuotes(contextBranch[1].trim());
  }

  throw new Error(`Task ${taskId} has no branch field in task.md`);
}

export function resolveTaskWorkspace(taskId: string, repoRoot: string): TaskWorkspace {
  if (!TASK_ID_RE.test(taskId)) throw new Error(`Invalid task id: ${taskId}`);
  const matches = taskWorkspaceCandidates(repoRoot, taskId);
  if (matches.length === 0) throw new Error(`Task not found: ${taskId}`);
  if (matches.length !== 1) {
    throw new Error(
      `SANDBOX_TASK_STATE_AMBIGUOUS: task ${taskId} exists in ${matches.map((match) => match.state).join(', ')}`
    );
  }
  return matches[0]!;
}

export function listTaskWorkspaces(repoRoot: string, state: TaskWorkspaceState): TaskWorkspace[] {
  const stateRoot = path.join(resolveProjectTaskWorkspaceRoot(repoRoot), state);
  if (state === 'archive') {
    if (!fs.existsSync(stateRoot)) return [];
    const rows: TaskWorkspace[] = [];
    for (const year of fs.readdirSync(stateRoot).sort()) {
      if (!/^\d{4}$/.test(year)) continue;
      for (const month of fs.readdirSync(path.join(stateRoot, year)).sort()) {
        if (!/^\d{2}$/.test(month)) continue;
        for (const day of fs.readdirSync(path.join(stateRoot, year, month)).sort()) {
          if (!/^\d{2}$/.test(day)) continue;
          for (const taskId of fs.readdirSync(path.join(stateRoot, year, month, day)).sort()) {
            if (!TASK_ID_RE.test(taskId)) continue;
            const taskMd = path.join(stateRoot, year, month, day, taskId, 'local', 'task.md');
            if (!fs.existsSync(taskMd)) continue;
            const content = fs.readFileSync(taskMd, 'utf8');
            rows.push({ taskId, branch: resolveBranchFromTaskContent(content, taskId), state, taskMd });
          }
        }
      }
    }
    return rows;
  }
  if (!fs.existsSync(stateRoot)) return [];
  return fs.readdirSync(stateRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && TASK_ID_RE.test(entry.name))
    .flatMap((entry) => {
      const taskMd = path.join(stateRoot, entry.name, 'task.md');
      if (!fs.existsSync(taskMd)) return [];
      const content = fs.readFileSync(taskMd, 'utf8');
      return [{
        taskId: entry.name,
        branch: resolveBranchFromTaskContent(content, entry.name),
        state,
        taskMd
      }];
    });
}
