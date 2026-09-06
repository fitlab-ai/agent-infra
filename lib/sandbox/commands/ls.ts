import * as p from '@clack/prompts';
import pc from 'picocolors';
import { loadConfig } from '../config.ts';
import {
  sandboxBranchLabel,
  sandboxLabel,
  sandboxTaskIdLabel,
  sandboxWorkspaceModeLabel
} from '../constants.ts';
import { detectEngine } from '../engine.ts';
import { formatTable } from '../../table.ts';
import { loadShortIdByTaskId } from '../../task/short-id.ts';
import { fetchSandboxRows } from './list-running.ts';
import { readSandboxControlStatusForRow } from './control-status.ts';

export { containerListFormat, parseLabels } from './list-running.ts';

const USAGE = `Usage: ai sandbox ls

Lists all containers for the current project. The '#' column is a
display-only row number; the 'SHORT' column shows the active task short
id bound to each container's branch (via
.agents/workspace/active/.short-ids.json), or '-' if no active task is
bound. Pass the SHORT value to "ai sandbox exec" (e.g. 'ai sandbox exec 11').
A '-' means no active task is bound to that branch, so the sandbox is free
to remove with "ai sandbox rm <branch>".

Use "ai sandbox show <ref>" for a single sandbox's worktree and per-tool
state paths.`;

const CONTAINER_TABLE_HEADERS = ['#', 'SHORT', 'NAMES', 'STATUS', 'WORKSPACE', 'TASK', 'BRANCH'] as const;

type ContainerTableRow = {
  row: string;
  shortId: string;
  name: string;
  status: string;
  workspace: string;
  taskId: string;
  branch: string;
};

export function formatContainerTable(rows: ContainerTableRow[], zebra = false): string[] {
  return formatTable(
    CONTAINER_TABLE_HEADERS,
    rows.map((r) => [r.row, r.shortId, r.name, r.status, r.workspace, r.taskId, r.branch]),
    { zebra }
  );
}

export function ls(args: string[] = []): void {
  if (args.length > 0 && (args[0] === '--help' || args[0] === '-h')) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }

  const config = loadConfig();
  const engine = detectEngine(config);
  const label = sandboxLabel(config);
  const { running, nonRunning } = fetchSandboxRows(
    engine,
    label,
    sandboxBranchLabel(config),
    { mode: sandboxWorkspaceModeLabel(config), taskId: sandboxTaskIdLabel(config) }
  );

  p.intro(pc.cyan(`Sandbox status for ${config.project}`));

  p.log.step('Containers');
  const ordered = [...running, ...nonRunning];
  if (ordered.length === 0) {
    p.log.warn('  No sandbox containers');
  } else {
    const tableRows: ContainerTableRow[] = ordered.map((container, i) => {
      const shortId = container.taskId
        ? loadShortIdByTaskId(config.repoRoot).get(container.taskId) ?? null
        : null;
      return {
        row: String(i + 1),
        shortId: shortId ?? '-',
        name: container.name,
        status: container.status,
        workspace: container.workspaceMode ?? 'legacy-invalid',
        taskId: container.taskId ?? '-',
        branch: container.branch
      };
    });
    for (const line of formatContainerTable(tableRows, Boolean(process.stdout.isTTY))) {
      process.stdout.write(`  ${line}\n`);
    }
    process.stdout.write(`  Total: ${ordered.length} containers\n`);
    for (const row of ordered) {
      const controlStatus = readSandboxControlStatusForRow(config, row);
      process.stdout.write(
        `  ${row.name}: health=${controlStatus?.state ?? 'unavailable'} task-view=${controlStatus?.taskView.state ?? 'unavailable'}\n`
      );
    }
    if (tableRows.some((r) => r.shortId === '-')) {
      process.stdout.write(
        `  SHORT '-' = no active task bound; that sandbox is free to remove with 'ai sandbox rm <branch>'.\n`
      );
    }
  }
}
