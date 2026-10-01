import { detectRepoRoot, resolveTaskRef } from '../task/resolve-ref.ts';
import { readPlatformOperationJournal } from '../task/platform-operation-journal.ts';
import { recoverPlatformOperations } from '../task/platform-operation-recovery.ts';
import { ensureInternalHandlerRoute, internalHandlerRoute } from './cli-route-inventory.ts';

const USAGE = 'Usage: agent-infra-internal task-platform-recovery <N | TASK-id> <inspect | recover> [--agent <agent>] [--selection required|deferred|all] [--attempts <positive-integer>]\n';

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
    : action === 'recover' && internalHandlerRoute('task-platform-recovery', 'recover', action);
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
  const attemptsInput = option(args, '--attempts');
  const attempts = attemptsInput === undefined ? undefined : Number(attemptsInput);
  const validAttempts = attemptsInput === undefined
    || (attempts !== undefined && Number.isSafeInteger(attempts) && attempts > 0);
  if (!agent || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(agent)
    || !['required', 'deferred', 'all'].includes(selection)
    || !validAttempts) {
    process.stdout.write(`${JSON.stringify({ status: 'failed', changed: false, error: { code: 'PLATFORM_OPERATION_RECOVERY_PAYLOAD_INVALID', message: 'recover requires a valid --agent, --selection, and positive --attempts when supplied' } })}\n`);
    process.stderr.write(USAGE);
    process.exitCode = 1;
    return;
  }
  const result = await recoverPlatformOperations(task.taskId, selection as 'required' | 'deferred' | 'all', { agent, cwd: repoRoot, ...(attempts === undefined ? {} : { attempts }) });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.status === 'applied' || result.status === 'no-op' ? 0 : result.status === 'blocked' ? 2 : 1;
}

export { taskPlatformRecovery };
