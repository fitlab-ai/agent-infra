import { detectRepoRoot, resolveTaskRef } from '../task/resolve-ref.ts';
import { readPlatformOperationJournal } from '../task/platform-operation-journal.ts';
import { recoverPlatformOperations, resolvePlatformOperation } from '../task/platform-operation-recovery.ts';
import { withTaskExecutionLock } from '../task/task-execution-lock.ts';
import { ensureInternalHandlerRoute, internalHandlerRoute } from './cli-route-inventory.ts';

const USAGE = 'Usage: agent-infra-internal task-platform-recovery <N | TASK-id> <inspect | recover | resolve> [options]\n  resolve requires --operation-id <sha256> --expected-digest <sha256> --expected-state failed --action confirm-applied|retry|supersede --remote-state applied|absent|replaced|cancelled --evidence <details> --agent <agent>\n  retry also requires --replay-safe true; supersede also requires --dependencies-preserved true\n';

function option(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

async function taskPlatformRecovery(args: string[] = []): Promise<void> {
  if (args[0] === '--help' || args[0] === '-h') { process.stdout.write(USAGE); return; }
  if (!ensureInternalHandlerRoute('task-platform-recovery', args)) return;
  const action = args[1];
  const registered = action === 'inspect'
    ? internalHandlerRoute('task-platform-recovery', 'inspect', action)
    : action === 'recover'
      ? internalHandlerRoute('task-platform-recovery', 'recover', action)
      : action === 'resolve'
        ? internalHandlerRoute('task-platform-recovery', 'resolve', action)
        : false;
  if (!registered) return;
  const repoRoot = detectRepoRoot();
  const task = resolveTaskRef(args[0] ?? '', { repoRoot });
  if (!task.ok) {
    process.stdout.write(`${JSON.stringify({ status: 'failed', changed: false, error: { code: task.code, message: task.message } })}\n`);
    process.exitCode = 1;
    return;
  }
  if (action === 'inspect') {
    try {
      const journal = readPlatformOperationJournal(task.taskId, repoRoot);
      process.stdout.write(`${JSON.stringify({ status: 'ready', changed: false, taskId: task.taskId, journal })}\n`);
    } catch (error) {
      const value = error as { code?: string; message?: string };
      process.stdout.write(`${JSON.stringify({ status: 'failed', changed: false, error: { code: value.code || 'PLATFORM_OPERATION_JOURNAL_INVALID', message: value.message || String(error) } })}\n`);
      process.exitCode = 1;
    }
    return;
  }
  const agent = option(args, '--agent');
  const selection = option(args, '--selection') ?? 'all';
  if (!agent || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(agent)
    || !['required', 'deferred', 'all'].includes(selection)) {
    process.stdout.write(`${JSON.stringify({ status: 'failed', changed: false, error: { code: 'PLATFORM_OPERATION_RECOVERY_PAYLOAD_INVALID', message: 'recover requires a valid --agent and --selection' } })}\n`);
    process.stderr.write(USAGE);
    process.exitCode = 1;
    return;
  }
  if (action === 'resolve') {
    const operationId = option(args, '--operation-id');
    const expectedDigest = option(args, '--expected-digest');
    const expectedState = option(args, '--expected-state');
    const resolutionAction = option(args, '--action');
    const remoteState = option(args, '--remote-state');
    const evidence = option(args, '--evidence');
    const replaySafe = option(args, '--replay-safe') === 'true';
    const dependenciesPreserved = option(args, '--dependencies-preserved') === 'true';
    if (!operationId || !expectedDigest || expectedState !== 'failed'
      || !['confirm-applied', 'retry', 'supersede'].includes(resolutionAction ?? '')
      || !['applied', 'absent', 'replaced', 'cancelled'].includes(remoteState ?? '')
      || !evidence || (option(args, '--replay-safe') !== undefined && option(args, '--replay-safe') !== 'true')
      || (option(args, '--dependencies-preserved') !== undefined && option(args, '--dependencies-preserved') !== 'true')) {
      process.stdout.write(`${JSON.stringify({ status: 'failed', changed: false, error: { code: 'PLATFORM_OPERATION_RESOLUTION_PAYLOAD_INVALID', message: 'resolve requires a full failed-operation identity and action-specific evidence' } })}\n`);
      process.stderr.write(USAGE);
      process.exitCode = 1;
      return;
    }
    const result = await withTaskExecutionLock(repoRoot, task.taskId, 'task-platform-recovery.resolve', () => resolvePlatformOperation(task.taskId, {
      taskRef: task.taskId, operationId, expectedDigest, expectedState: 'failed',
      action: resolutionAction as 'confirm-applied' | 'retry' | 'supersede', agent, evidence,
      remoteState: remoteState as 'applied' | 'absent' | 'replaced' | 'cancelled', replaySafe, dependenciesPreserved, cwd: repoRoot
    }, { agent, cwd: repoRoot }));
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode = result.status === 'applied' || result.status === 'no-op' ? 0 : result.status === 'blocked' ? 2 : 1;
    return;
  }
  const result = await recoverPlatformOperations(task.taskId, selection as 'required' | 'deferred' | 'all', { agent, cwd: repoRoot });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.status === 'applied' || result.status === 'no-op' ? 0 : result.status === 'blocked' ? 2 : 1;
}

export { taskPlatformRecovery };
