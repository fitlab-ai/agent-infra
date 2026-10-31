import { runSafeEngine, runVerboseEngine } from '../shell.ts';
import { parseSandboxWorkspaceIdentity } from '../workspace-identity.ts';

export type SandboxRow = {
  name: string;
  status: string;
  branch: string;
  running: boolean;
  index: number | null;
  workspaceMode?: 'task-bound' | 'branch-only' | 'legacy-invalid';
  taskId?: string | null;
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

export function parseSandboxRows(
  rawOutput: string,
  branchKey: string,
  workspaceKeys?: Readonly<{ mode: string; taskId: string }>
): SandboxRow[] {
  if (!rawOutput) {
    return [];
  }
  return rawOutput.split('\n').map((line) => {
    const [name = '', status = '', labelsCsv = ''] = line.split('\t');
    const labels = parseLabels(labelsCsv);
    const workspace = workspaceKeys
      ? parseSandboxWorkspaceIdentity(labels, workspaceKeys)
      : null;
    return {
      name,
      status,
      branch: labels[branchKey] ?? '',
      running: status.startsWith('Up '),
      index: null,
      ...(workspace
        ? {
          workspaceMode: workspace.mode,
          taskId: workspace.mode === 'task-bound' ? workspace.taskId : null
        }
        : {})
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
  branchKey: string,
  workspaceKeys?: Readonly<{ mode: string; taskId: string }>
): { running: SandboxRow[]; nonRunning: SandboxRow[] } {
  const raw = runSafeEngine(engine, 'docker', [
    'ps',
    '-a',
    '--filter',
    `label=${label}`,
    '--format',
    containerListFormat()
  ]);
  return sortAndIndexSandboxRows(parseSandboxRows(raw, branchKey, workspaceKeys));
}

/**
 * Pick the sandbox container row whose name matches one of the candidate
 * container names (covers both the '..' and legacy '-' branch sanitizations).
 * Pure: no IO. Returns null when no row matches.
 */
export function selectSandboxContainer(
  rows: SandboxRow[],
  candidates: string[]
): SandboxRow | null {
  return rows.find((row) => candidates.includes(row.name)) ?? null;
}

/**
 * Start an existing (stopped) sandbox container by name. Throws a distinct,
 * actionable error when `docker start` fails, so callers can tell "start failed"
 * apart from "container not found".
 */
export function startSandboxContainer(engine: string, name: string): void {
  try {
    runVerboseEngine(engine, 'docker', ['start', name]);
  } catch (error) {
    throw new Error(
      `Failed to start sandbox container '${name}': ${error instanceof Error ? error.message : 'unknown error'}`
    );
  }
}
