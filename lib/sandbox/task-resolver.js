import fs from 'node:fs';
import path from 'node:path';

const TASK_ID_RE = /^TASK-\d{8}-\d{6}$/;

function readTaskContent(repoRoot, taskId) {
  const taskPath = path.join(repoRoot, '.agents', 'workspace', 'active', taskId, 'task.md');
  if (!fs.existsSync(taskPath)) {
    throw new Error(`Task not found: ${taskId}`);
  }
  return fs.readFileSync(taskPath, 'utf8');
}

function resolveBranchFromTaskContent(content, taskId) {
  const frontmatterBranch = content.match(/^branch:\s*(.+)$/m);
  if (frontmatterBranch && frontmatterBranch[1].trim()) {
    return frontmatterBranch[1].trim();
  }

  const contextBranch = content.match(/^- \*\*(?:分支|Branch)\*\*：[ \t]*`?([^`\n]+)`?$/m);
  if (contextBranch && contextBranch[1].trim()) {
    return contextBranch[1].trim();
  }

  throw new Error(`Task ${taskId} has no branch field in task.md`);
}

export function resolveTaskBranch(arg, repoRoot) {
  if (!TASK_ID_RE.test(arg)) {
    return arg;
  }

  const content = readTaskContent(repoRoot, arg);
  return resolveBranchFromTaskContent(content, arg);
}
