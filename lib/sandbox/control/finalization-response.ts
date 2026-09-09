import type { TaskFinalizationReceipt } from '../../task/finalization.ts';
import type { SandboxControlResponse } from './protocol.ts';

export function finalizationTerminalResponse(taskId: string, requestId: string, receipt: TaskFinalizationReceipt): SandboxControlResponse {
  const pendingSteps = [
    receipt.taskComment === 'pending' ? 'task-comment' : null,
    receipt.verification === 'pending' ? 'verification' : null
  ].filter((step): step is string => step !== null);
  const completedSteps = ['lifecycle', receipt.taskComment === 'pending' ? null : 'task-comment', receipt.verification === 'pending' ? null : 'verification']
    .filter((step): step is string => step !== null);
  const warnings = receipt.warnings
    .filter((warning) => warning.status === 'open')
    .map(({ status: _status, resolvedAt: _resolvedAt, ...warning }) => warning);
  const result = {
    status: 'completed', changed: false, taskId,
    lifecycle: { status: 'no-op', changed: false, error: null },
    taskComment: receipt.taskComment === 'pending' ? null : { status: 'no-op', changed: false, error: null },
    verification: receipt.verification === 'pending' ? null : { status: 'no-op', changed: false, error: null },
    completedSteps, pendingSteps,
    result: pendingSteps.length > 0 || receipt.warningProjection === 'pending' || warnings.length > 0
      ? 'completed_with_warnings' : 'completed',
    warnings, error: null
  };
  return {
    version: 2, id: requestId, phase: 'completed', exitCode: 0,
    stdout: `${JSON.stringify({ version: 1, status: 'completed', changed: false, accepted: true, result, error: null })}\n`,
    stderr: '', error: null
  };
}
