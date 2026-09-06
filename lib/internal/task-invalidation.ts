import { reconcileTaskInvalidation } from '../task/invalidation-command.ts';
import { resolveTaskRef } from '../task/resolve-ref.ts';
import { TaskExecutionLockError, withTaskExecutionLock } from '../task/task-execution-lock.ts';
import { ensureInternalHandlerRoute } from './cli-route-inventory.ts';

const USAGE = 'Usage: agent-infra-internal task-invalidation <task-ref> reconcile [--max-targets <n>] [--dry-run]\n';

function taskInvalidation(args: string[] = []): void {
  if (!ensureInternalHandlerRoute('task-invalidation', args)) return;
  if (args[0] === '--help' || args[0] === '-h') { process.stdout.write(USAGE); return; }
  const taskRef = args[0];
  if (!taskRef || args[1] !== 'reconcile') {
    process.stdout.write(`${JSON.stringify({ status: 'failed', changed: false, error: { code: 'INVALIDATION_PAYLOAD_INVALID', message: 'task ref and reconcile are required' } })}\n`);
    process.stderr.write(USAGE);
    process.exitCode = 1;
    return;
  }
  let maxTargets: number | undefined;
  let dryRun = false;
  for (let index = 2; index < args.length; index += 1) {
    const flag = args[index]!;
    if (flag === '--dry-run') { if (dryRun) { process.exitCode = 1; return; } dryRun = true; continue; }
    if (flag !== '--max-targets') { process.exitCode = 1; return; }
    const value = Number(args[++index]);
    if (!Number.isInteger(value) || value < 1 || maxTargets !== undefined) { process.exitCode = 1; return; }
    maxTargets = value;
  }
  const resolved = resolveTaskRef(taskRef);
  if (!resolved.ok) { process.stdout.write(`${JSON.stringify({ status: 'failed', changed: false, error: { code: resolved.code, message: resolved.message } })}\n`); process.exitCode = 1; return; }
  try {
    const result = withTaskExecutionLock(resolved.repoRoot, resolved.taskId, 'task-invalidation.reconcile', () => reconcileTaskInvalidation(taskRef, { ...(maxTargets === undefined ? {} : { maxTargets }), dryRun }));
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.status === 'failed') process.exitCode = 1;
  } catch (error) {
    if (!(error instanceof TaskExecutionLockError)) throw error;
    process.stdout.write(`${JSON.stringify({ status: 'failed', changed: false, error: { code: error.code, message: error.message } })}\n`);
    process.exitCode = 1;
  }
}

export { taskInvalidation };
