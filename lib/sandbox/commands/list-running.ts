import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { runSafeEngine } from '../shell.ts';

export type SandboxRow = {
  name: string;
  status: string;
  branch: string;
  running: boolean;
  index: number | null;
};

export function containerListFormat(): string {
  return '{{.Names}}\t{{.Status}}\t{{.Labels}}';
}

export function parseLabels(csv: string): Record<string, string> {
  if (!csv) {
    return {};
  }

  const labels: Record<string, string> = {};
  for (const pair of csv.split(',')) {
    if (!pair) {
      continue;
    }
    const eq = pair.indexOf('=');
    if (eq < 0) {
      continue;
    }
    labels[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return labels;
}

export function parseSandboxRows(rawOutput: string, branchKey: string): SandboxRow[] {
  if (!rawOutput) {
    return [];
  }
  return rawOutput.split('\n').map((line) => {
    const [name = '', status = '', labelsCsv = ''] = line.split('\t');
    const branch = parseLabels(labelsCsv)[branchKey] ?? '';
    return {
      name,
      status,
      branch,
      running: status.startsWith('Up '),
      index: null
    };
  });
}

export function sortAndIndexSandboxRows(rows: SandboxRow[]): {
  running: SandboxRow[];
  nonRunning: SandboxRow[];
} {
  const byName = (a: SandboxRow, b: SandboxRow): number => {
    if (a.name < b.name) return -1;
    if (a.name > b.name) return 1;
    return 0;
  };
  const running = rows.filter((row) => row.running).sort(byName).map((row, i) => ({
    ...row,
    index: i + 1
  }));
  const nonRunning = rows.filter((row) => !row.running).sort(byName).map((row) => ({
    ...row,
    index: null
  }));
  return { running, nonRunning };
}

export function fetchSandboxRows(
  engine: string,
  label: string,
  branchKey: string
): { running: SandboxRow[]; nonRunning: SandboxRow[] } {
  const raw = runSafeEngine(engine, 'docker', [
    'ps',
    '-a',
    '--filter',
    `label=${label}`,
    '--format',
    containerListFormat()
  ]);
  return sortAndIndexSandboxRows(parseSandboxRows(raw, branchKey));
}

/**
 * Returns true iff `arg` is a syntactically valid task short reference ('#N').
 * Zero IO. Callers MUST use this as the gate before constructing any context
 * for resolveTaskShortRef — that way non-matching arguments (e.g. '#abc',
 * '#1.5', '#') never trigger sandbox list IO.
 */
export function isTaskShortRef(arg: string): boolean {
  return /^#\d+$/.test(arg);
}

type RegistryLookup =
  | { status: 'miss' }
  | { status: 'hit'; branch: string };

/**
 * Try to resolve a short ref against the global task-short-id registry.
 *
 * Tri-state semantics (review-code Round 1 M-1 fix):
 *   - 'miss'     → script reports no entry (or registry script missing). Caller may fall back.
 *   - 'hit'      → registry resolved to a task id and branch is found in task.md.
 *   - throws     → registry hit but task.md is missing or branch metadata is unparseable;
 *                   surfacing this error is critical — never silently fall back to running index.
 */
function tryResolveFromRegistry(arg: string, repoRoot: string): RegistryLookup {
  const scriptPath = path.join(repoRoot, '.agents', 'scripts', 'task-short-id.js');
  if (!fs.existsSync(scriptPath)) return { status: 'miss' };
  const result = spawnSync('node', [scriptPath, 'resolve', arg], { encoding: 'utf8', cwd: repoRoot });
  if (result.status !== 0) return { status: 'miss' };
  const taskId = (result.stdout || '').trim();
  if (!/^TASK-\d{8}-\d{6}$/.test(taskId)) {
    throw new Error(
      `Registry returned malformed task id for '${arg}': ${JSON.stringify(taskId)}`
    );
  }
  for (const sub of ['active', 'completed', 'blocked', 'archive']) {
    const taskMdPath = path.join(repoRoot, '.agents', 'workspace', sub, taskId, 'task.md');
    if (!fs.existsSync(taskMdPath)) continue;
    const content = fs.readFileSync(taskMdPath, 'utf8');
    const fm = content.match(/^branch:\s*(.+)$/m);
    if (fm?.[1]?.trim()) {
      return { status: 'hit', branch: fm[1].trim().replace(/^(["'])(.*)\1$/, '$2') };
    }
    const ctx = content.match(/^- \*\*(?:分支|Branch)\*\*：[ \t]*`?([^`\n]+)`?$/m);
    if (ctx?.[1]?.trim()) {
      return { status: 'hit', branch: ctx[1].trim().replace(/^(["'])(.*)\1$/, '$2') };
    }
    throw new Error(
      `Short ref '${arg}' resolved to task ${taskId} but task.md has no branch field`
    );
  }
  throw new Error(
    `Short ref '${arg}' resolved to task ${taskId} but task.md was not found under any workspace dir`
  );
}

function resolveByRunningIndex(arg: string, running: SandboxRow[]): string {
  const n = Number(arg.slice(1));
  if (n < 1) {
    throw new Error(`Invalid sandbox index '${arg}': must be >= 1`);
  }
  if (running.length === 0) {
    throw new Error(`No running sandbox to reference with '${arg}'`);
  }
  if (n > running.length) {
    throw new Error(
      `No running sandbox at index '${arg}' (only ${running.length} running)`
    );
  }
  const row = running[n - 1]!;
  if (!row.branch) {
    throw new Error(
      `Cannot resolve branch for sandbox '${arg}' (container '${row.name}' missing branch label)`
    );
  }
  return row.branch;
}

/**
 * Resolve a task short reference ('#N') to a branch name for the sandbox entrypoint.
 *
 * Resolution order (sandbox fallback mode, plan-r7 C2):
 *   1. Try the global task-short-id registry under repoRoot. If hit, look up the
 *      branch from the matching task.md.
 *   2. Fallback to the running-sandbox list index (preserves the #414 ls-index
 *      behaviour; long-term contract per analysis-r5).
 *
 * Precondition: callers MUST gate on isTaskShortRef(arg) === true.
 */
export function resolveTaskShortRef(
  arg: string,
  ctx: { running: SandboxRow[]; repoRoot?: string }
): string {
  if (ctx.repoRoot) {
    const lookup = tryResolveFromRegistry(arg, ctx.repoRoot);
    if (lookup.status === 'hit') return lookup.branch;
    // 'miss' falls through to ls-index fallback (preserves #414 behaviour); 'hit-but-invalid' already threw above.
  }
  return resolveByRunningIndex(arg, ctx.running);
}
