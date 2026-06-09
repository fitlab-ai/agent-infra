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

/**
 * Resolve a task short reference ('#N') to a branch name.
 *
 * Current implementation: treats the digits as a 1-based index into the
 * supplied running-sandbox list (ls view order). This is the *only*
 * resolution path until the global task-short-id registry lands in a
 * follow-up task; do NOT read task.md or scan .agents/workspace/ from this
 * helper here.
 *
 * Precondition: callers MUST gate on isTaskShortRef(arg) === true before
 * constructing ctx and calling this function. Throws when arg is a valid
 * short ref but cannot be resolved (out of range, no running sandboxes,
 * etc.); the caller surfaces the error to the user.
 */
export function resolveTaskShortRef(
  arg: string,
  ctx: { running: SandboxRow[] }
): string {
  const n = Number(arg.slice(1));
  if (n < 1) {
    throw new Error(`Invalid sandbox index '${arg}': must be >= 1`);
  }
  const { running } = ctx;
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
