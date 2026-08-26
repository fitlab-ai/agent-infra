import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { isRemovedHashShortIdInput } from '../task/short-id.ts';

const TASK_ID_RE = /^TASK-\d{8}-\d{6}$/;
const SHORT_ID_RE = /^\d+$/;
export const TASK_WORKSPACE_STATES = ['active', 'completed', 'blocked', 'archive'] as const;
export type TaskWorkspaceState = typeof TASK_WORKSPACE_STATES[number];
export type TaskWorkspace = Readonly<{
  taskId: string;
  branch: string;
  state: TaskWorkspaceState;
  taskMd: string;
}>;

function resolveShortIdStrict(arg: string, repoRoot: string): string {
  const scriptPath = path.join(repoRoot, '.agents', 'scripts', 'task-short-id.js');
  if (!fs.existsSync(scriptPath)) {
    throw new Error(
      `Short id '${arg}' provided but task-short-id.js script is missing at ${scriptPath}`
    );
  }
  const result = spawnSync('node', [scriptPath, 'resolve', arg], { encoding: 'utf8', cwd: repoRoot });
  if (result.status !== 0) {
    throw new Error(
      `Short id '${arg}' not found in active task registry: ${(result.stderr || '').trim()}`
    );
  }
  return result.stdout.trim();
}

function stripQuotes(value: string): string {
  return value.replace(/^(["'])(.*)\1$/, '$2');
}

function readTaskContent(repoRoot: string, taskId: string): { content: string; state: TaskWorkspaceState; taskMd: string } {
  for (const state of TASK_WORKSPACE_STATES) {
    const taskPath = path.join(repoRoot, '.agents', 'workspace', state, taskId, 'task.md');
    if (fs.existsSync(taskPath)) {
      return { content: fs.readFileSync(taskPath, 'utf8'), state, taskMd: taskPath };
    }
  }
  throw new Error(`Task not found: ${taskId}`);
}

function taskWorkspaceCandidates(repoRoot: string, taskId: string): TaskWorkspace[] {
  return TASK_WORKSPACE_STATES.flatMap((state) => {
    const taskMd = path.join(repoRoot, '.agents', 'workspace', state, taskId, 'task.md');
    if (!fs.existsSync(taskMd)) return [];
    const content = fs.readFileSync(taskMd, 'utf8');
    return [{
      taskId,
      branch: resolveBranchFromTaskContent(content, taskId),
      state,
      taskMd
    }];
  });
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

export function resolveTaskBranch(arg: string, repoRoot: string): string {
  if (isRemovedHashShortIdInput(arg)) {
    throw new Error(`Invalid task short id '${arg}': task short ids must use bare digits`);
  }
  if (SHORT_ID_RE.test(arg)) {
    const taskId = resolveShortIdStrict(arg, repoRoot);
    const { content } = readTaskContent(repoRoot, taskId);
    return resolveBranchFromTaskContent(content, taskId);
  }
  if (!TASK_ID_RE.test(arg)) {
    return arg;
  }
  const { content } = readTaskContent(repoRoot, arg);
  return resolveBranchFromTaskContent(content, arg);
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
  const stateRoot = path.join(repoRoot, '.agents', 'workspace', state);
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
