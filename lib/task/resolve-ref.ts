import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { normalizeShortIdInput, resolveShortIdReadOnly } from './short-id.ts';
import { parseTaskFrontmatter } from './frontmatter.ts';

const TASK_ID_RE = /^TASK-\d{8}-\d{6}$/;
// Flat-structured workspace dirs that hold tasks under `{dir}/{taskId}/task.md`.
// Note: `archive` uses a three-level YYYY/MM/DD layout and is handled separately.
const FLAT_WORKSPACE_DIRS = ['active', 'blocked', 'completed'] as const;

type ResolveRefResult =
  | {
      ok: true;
      repoRoot: string;
      taskId: string;
      taskDir: string;
      taskMdPath: string;
      state: TaskWorkspaceState;
    }
  | {
      ok: false;
      code: ResolveTaskRefErrorCode;
      message: string;
      repoRoot: string | null;
      taskId: string | null;
    };

type TaskWorkspaceState = 'active' | 'blocked' | 'completed' | 'archive';

type ResolveTaskRefErrorCode =
  | 'REPO_ROOT_NOT_FOUND'
  | 'INVALID_TASK_REF'
  | 'SHORT_ID_RESERVED'
  | 'SHORT_ID_CAPACITY_EXCEEDED'
  | 'SHORT_ID_REGISTRY_NOT_FOUND'
  | 'SHORT_ID_REGISTRY_READ_FAILED'
  | 'SHORT_ID_REGISTRY_INVALID_JSON'
  | 'SHORT_ID_REGISTRY_INVALID_SCHEMA'
  | 'SHORT_ID_REGISTRY_DUPLICATE_TASK'
  | 'SHORT_ID_NOT_FOUND'
  | 'SHORT_ID_STALE'
  | 'TASK_NOT_FOUND'
  | 'TASK_CONTEXT_DETACHED_HEAD'
  | 'TASK_CONTEXT_NOT_FOUND'
  | 'TASK_CONTEXT_AMBIGUOUS'
  | 'TASK_CONTEXT_UNREADABLE';

type ResolveTaskRefOptions = { repoRoot?: string };

function detectRepoRoot(): string {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    }).trim();
  } catch {
    throw new Error('ai task: current directory is not inside a git repository');
  }
}

function readShortIdLength(repoRoot: string): number {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(repoRoot, '.agents', '.airc.json'), 'utf8'));
    const v = cfg?.task?.shortIdLength;
    if (typeof v === 'number' && Number.isFinite(v) && v >= 1) return v;
  } catch {
    // fall through to default
  }
  return 2;
}

function listSortedNumeric(dir: string, width: number): string[] {
  if (!fs.existsSync(dir)) return [];
  const pattern = new RegExp(`^\\d{${width}}$`);
  return fs
    .readdirSync(dir)
    .filter((entry) => pattern.test(entry))
    .sort()
    .reverse();
}

function findInArchive(repoRoot: string, taskId: string): string | null {
  // archive-tasks SKILL writes to .agents/workspace/archive/YYYY/MM/DD/{taskId}/task.md
  // where YYYY/MM/DD comes from completed_at (or updated_at fallback) — NOT from
  // the task id's creation date. So we cannot derive the path from taskId alone;
  // walk the bounded YYYY/MM/DD tree instead. Newest-first to favor recent archives.
  const archiveDir = path.join(repoRoot, '.agents', 'workspace', 'archive');
  for (const year of listSortedNumeric(archiveDir, 4)) {
    const yearDir = path.join(archiveDir, year);
    for (const month of listSortedNumeric(yearDir, 2)) {
      const monthDir = path.join(yearDir, month);
      for (const day of listSortedNumeric(monthDir, 2)) {
        const candidate = path.join(monthDir, day, taskId, 'task.md');
        if (fs.existsSync(candidate)) return candidate;
      }
    }
  }
  return null;
}

function findTaskMd(
  repoRoot: string,
  taskId: string
): { taskMdPath: string; state: TaskWorkspaceState } | null {
  for (const sub of FLAT_WORKSPACE_DIRS) {
    const candidate = path.join(repoRoot, '.agents', 'workspace', sub, taskId, 'task.md');
    if (fs.existsSync(candidate)) return { taskMdPath: candidate, state: sub };
  }
  const archived = findInArchive(repoRoot, taskId);
  return archived ? { taskMdPath: archived, state: 'archive' } : null;
}

/**
 * Enumerate every task directory under the flat workspace states
 * (active / blocked / completed) — archive is intentionally excluded so a
 * full-tree scan never pulls in cold data. Ordered by state, then task id
 * ascending, giving callers a deterministic traversal.
 */
function enumerateTaskDirs(repoRoot: string): { taskId: string; taskDir: string }[] {
  const out: { taskId: string; taskDir: string }[] = [];
  for (const sub of FLAT_WORKSPACE_DIRS) {
    const base = path.join(repoRoot, '.agents', 'workspace', sub);
    if (!fs.existsSync(base)) continue;
    for (const entry of fs.readdirSync(base).sort()) {
      if (!TASK_ID_RE.test(entry)) continue;
      const taskDir = path.join(base, entry);
      if (!fs.existsSync(path.join(taskDir, 'task.md'))) continue;
      out.push({ taskId: entry, taskDir });
    }
  }
  return out;
}

function locateHotTaskDirs(
  repoRoot: string,
  taskId: string
): { taskId: string; taskDir: string; taskMdPath: string; state: Exclude<TaskWorkspaceState, 'archive'> }[] {
  return FLAT_WORKSPACE_DIRS.flatMap((state) => {
    const taskDir = path.join(repoRoot, '.agents', 'workspace', state, taskId);
    const taskMdPath = path.join(taskDir, 'task.md');
    return fs.existsSync(taskMdPath) ? [{ taskId, taskDir, taskMdPath, state }] : [];
  });
}

/**
 * Resolve a task ref (bare short id, `#N`, or `TASK-YYYYMMDD-HHMMSS`) to its
 * task directory across active / blocked / completed / archive.
 *
 * The returned `message` on failure is command-agnostic (no `ai task <cmd>:`
 * prefix); callers prepend their own prefix so each command keeps its existing
 * stderr wording byte-for-byte.
 */
function resolveTaskRef(arg: string, options: ResolveTaskRefOptions = {}): ResolveRefResult {
  let repoRoot: string;
  try {
    repoRoot = options.repoRoot ? path.resolve(options.repoRoot) : detectRepoRoot();
  } catch (error) {
    return {
      ok: false,
      code: 'REPO_ROOT_NOT_FOUND',
      message: error instanceof Error ? error.message : String(error),
      repoRoot: null,
      taskId: null
    };
  }
  let taskId: string;
  if (TASK_ID_RE.test(arg)) {
    taskId = arg;
  } else {
    const shortIdLength = readShortIdLength(repoRoot);
    const normalized = normalizeShortIdInput(arg, { shortIdLength });
    if (normalized.kind === 'error') {
      return {
        ok: false,
        code: normalized.code,
        message: normalized.message,
        repoRoot,
        taskId: null
      };
    }
    if (normalized.kind === 'pass') {
      return {
        ok: false,
        code: 'INVALID_TASK_REF',
        message:
          `'${arg}' is not a valid short id or TASK-id; ` +
          `expected bare digits, '#N', or 'TASK-YYYYMMDD-HHMMSS'`,
        repoRoot,
        taskId: null
      };
    }
    const shortResult = resolveShortIdReadOnly(normalized.value, repoRoot, { shortIdLength });
    if (!shortResult.ok) {
      return {
        ok: false,
        code: shortResult.code,
        message: shortResult.message,
        repoRoot,
        taskId: shortResult.taskId
      };
    }
    taskId = shortResult.taskId;
  }
  const located = findTaskMd(repoRoot, taskId);
  if (!located) {
    return {
      ok: false,
      code: 'TASK_NOT_FOUND',
      message: `task ${taskId} not found in active / blocked / completed / archive`,
      repoRoot,
      taskId
    };
  }
  return {
    ok: true,
    repoRoot,
    taskId,
    taskDir: path.dirname(located.taskMdPath),
    taskMdPath: located.taskMdPath,
    state: located.state
  };
}

function resolveTaskContext(
  taskRef?: string,
  options: ResolveTaskRefOptions = {}
): ResolveRefResult {
  if (taskRef !== undefined) return resolveTaskRef(taskRef, options);

  let repoRoot: string;
  try {
    repoRoot = options.repoRoot ? path.resolve(options.repoRoot) : detectRepoRoot();
  } catch (error) {
    return {
      ok: false,
      code: 'REPO_ROOT_NOT_FOUND',
      message: error instanceof Error ? error.message : String(error),
      repoRoot: null,
      taskId: null
    };
  }

  let branch: string;
  try {
    branch = execFileSync('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    }).trim();
  } catch {
    return {
      ok: false,
      code: 'TASK_CONTEXT_DETACHED_HEAD',
      message: 'cannot infer the current task from detached HEAD',
      repoRoot,
      taskId: null
    };
  }

  const activeDir = path.join(repoRoot, '.agents', 'workspace', 'active');
  const matches: { taskId: string; taskDir: string; taskMdPath: string }[] = [];
  if (fs.existsSync(activeDir)) {
    for (const entry of fs.readdirSync(activeDir).sort()) {
      if (!TASK_ID_RE.test(entry)) continue;
      const taskDir = path.join(activeDir, entry);
      const taskMdPath = path.join(taskDir, 'task.md');
      if (!fs.existsSync(taskMdPath)) continue;
      try {
        const frontmatter = parseTaskFrontmatter(fs.readFileSync(taskMdPath, 'utf8'));
        if (!frontmatter.id || !frontmatter.branch) {
          return {
            ok: false,
            code: 'TASK_CONTEXT_UNREADABLE',
            message: `cannot prove current task context because ${entry}/task.md has invalid frontmatter`,
            repoRoot,
            taskId: null
          };
        }
        if (frontmatter.branch === branch) matches.push({ taskId: entry, taskDir, taskMdPath });
      } catch (error) {
        return {
          ok: false,
          code: 'TASK_CONTEXT_UNREADABLE',
          message: `cannot read active task candidate ${entry}: ${error instanceof Error ? error.message : String(error)}`,
          repoRoot,
          taskId: null
        };
      }
    }
  }

  if (matches.length === 0) {
    return {
      ok: false,
      code: 'TASK_CONTEXT_NOT_FOUND',
      message: `no active task matches current branch '${branch}'; use --task <ref>`,
      repoRoot,
      taskId: null
    };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      code: 'TASK_CONTEXT_AMBIGUOUS',
      message: `multiple active tasks match current branch '${branch}'; use --task <ref>`,
      repoRoot,
      taskId: null
    };
  }
  const match = matches[0]!;
  return { ok: true, repoRoot, ...match, state: 'active' };
}

export { resolveTaskRef, resolveTaskContext, detectRepoRoot, enumerateTaskDirs, locateHotTaskDirs, TASK_ID_RE };
export type {
  ResolveRefResult,
  ResolveTaskRefErrorCode,
  ResolveTaskRefOptions,
  TaskWorkspaceState
};
