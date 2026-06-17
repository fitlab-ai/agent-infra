import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { normalizeShortIdInput } from './short-id.ts';

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
    }
  | { ok: false; message: string };

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

function resolveShortIdToTaskId(arg: string, repoRoot: string): string {
  const scriptPath = path.join(repoRoot, '.agents', 'scripts', 'task-short-id.js');
  if (!fs.existsSync(scriptPath)) {
    throw new Error(`task-short-id.js not found at ${scriptPath}`);
  }
  const result = spawnSync('node', [scriptPath, 'resolve', arg], {
    encoding: 'utf8',
    cwd: repoRoot
  });
  if (result.status !== 0) {
    throw new Error((result.stderr || '').trim() || `failed to resolve '${arg}'`);
  }
  return result.stdout.trim();
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

function findTaskMd(repoRoot: string, taskId: string): string | null {
  for (const sub of FLAT_WORKSPACE_DIRS) {
    const candidate = path.join(repoRoot, '.agents', 'workspace', sub, taskId, 'task.md');
    if (fs.existsSync(candidate)) return candidate;
  }
  return findInArchive(repoRoot, taskId);
}

/**
 * Resolve a task ref (bare short id, `#N`, or `TASK-YYYYMMDD-HHMMSS`) to its
 * task directory across active / blocked / completed / archive.
 *
 * The returned `message` on failure is command-agnostic (no `ai task <cmd>:`
 * prefix); callers prepend their own prefix so each command keeps its existing
 * stderr wording byte-for-byte.
 */
function resolveTaskRef(arg: string): ResolveRefResult {
  const repoRoot = detectRepoRoot();
  let taskId: string;
  if (TASK_ID_RE.test(arg)) {
    taskId = arg;
  } else {
    const shortIdLength = readShortIdLength(repoRoot);
    const normalized = normalizeShortIdInput(arg, { shortIdLength });
    if (normalized.kind === 'error') {
      return { ok: false, message: normalized.message };
    }
    if (normalized.kind === 'pass') {
      return {
        ok: false,
        message:
          `'${arg}' is not a valid short id or TASK-id; ` +
          `expected bare digits, '#N', or 'TASK-YYYYMMDD-HHMMSS'`
      };
    }
    try {
      taskId = resolveShortIdToTaskId(normalized.value, repoRoot);
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
  }
  const taskMdPath = findTaskMd(repoRoot, taskId);
  if (!taskMdPath) {
    return {
      ok: false,
      message: `task ${taskId} not found in active / blocked / completed / archive`
    };
  }
  return { ok: true, repoRoot, taskId, taskDir: path.dirname(taskMdPath), taskMdPath };
}

export { resolveTaskRef, TASK_ID_RE };
export type { ResolveRefResult };
