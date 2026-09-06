import type { SandboxConfig } from '../config.ts';
import { readSandboxControlStatus } from '../control/state.ts';
import type { SandboxControlStatus } from '../control/protocol.ts';
import { sandboxControlPaths } from '../workspace-view.ts';
import type { SandboxRow } from './list-running.ts';

export function readSandboxControlStatusForRow(
  config: SandboxConfig,
  row: Pick<SandboxRow, 'name' | 'workspaceMode' | 'taskId'>
): SandboxControlStatus | null {
  if (!row.workspaceMode || row.workspaceMode === 'legacy-invalid') return null;
  const identity = row.workspaceMode === 'task-bound' && row.taskId
    ? { mode: 'task-bound' as const, taskId: row.taskId }
    : { mode: 'branch-only' as const };
  const control = sandboxControlPaths({
    base: config.controlBase,
    project: config.project,
    container: row.name,
    identity
  });
  try {
    return readSandboxControlStatus(control.statusDir);
  } catch {
    return null;
  }
}
