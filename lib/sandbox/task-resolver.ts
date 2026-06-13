import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const TASK_ID_RE = /^TASK-\d{8}-\d{6}$/;
const SHORT_ID_RE = /^#?\d+$/;
const WORKSPACE_DIRS = ['active', 'completed', 'blocked', 'archive'];

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

function readTaskContent(repoRoot: string, taskId: string): string {
  for (const dir of WORKSPACE_DIRS) {
    const taskPath = path.join(repoRoot, '.agents', 'workspace', dir, taskId, 'task.md');
    if (fs.existsSync(taskPath)) {
      return fs.readFileSync(taskPath, 'utf8');
    }
  }
  throw new Error(`Task not found: ${taskId}`);
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
  if (SHORT_ID_RE.test(arg)) {
    const taskId = resolveShortIdStrict(arg, repoRoot);
    const content = readTaskContent(repoRoot, taskId);
    return resolveBranchFromTaskContent(content, taskId);
  }
  if (!TASK_ID_RE.test(arg)) {
    return arg;
  }
  const content = readTaskContent(repoRoot, arg);
  return resolveBranchFromTaskContent(content, arg);
}
