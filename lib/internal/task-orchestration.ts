import { createDirectHostExecutionContext, dispatchTaskControlOperation, parseTaskControlOperation } from '../task/control-authority.ts';
import { OrchestrationStateError } from '../task/orchestration.ts';
import { detectRepoRoot } from '../task/resolve-ref.ts';
import { ensureInternalHandlerRoute, internalHandlerRoute } from './cli-route-inventory.ts';

const USAGE = 'Usage: agent-infra-internal task-orchestration <task-ref|auto> <begin-or-resume|route|prepare|dispatch|await-activation|recover-prepared|hook-start|hook-stop|advance|pause|status> [options]\n';

function usageFailure(message: string): void {
  process.stdout.write(`${JSON.stringify({
    status: 'failed', changed: false,
    error: { code: 'ORCHESTRATION_PAYLOAD_INVALID', message }
  })}\n`);
  process.stderr.write(USAGE);
  process.exitCode = 2;
}

function parseFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^TASK_CONTROL_OPERATION_INVALID: /u, '');
}

async function taskOrchestration(args: string[] = []): Promise<void> {
  if (!ensureInternalHandlerRoute('task-orchestration', args)) return;
  if (args[0] === '--help' || args[0] === '-h') {
    process.stdout.write(USAGE);
    return;
  }

  const route = internalHandlerRoute('task-orchestration', 'status', args[1] ?? '')
    ? 'status'
    : internalHandlerRoute('task-orchestration', 'progress', args[1] ? 'progress' : '')
      ? 'progress'
      : '';
  if (!route) {
    usageFailure('orchestration operation is required');
    return;
  }

  let operation;
  try {
    operation = parseTaskControlOperation('task-orchestration', args);
  } catch (error) {
    usageFailure(parseFailure(error));
    return;
  }
  if (operation.family !== 'task-orchestration') {
    usageFailure('orchestration operation is invalid');
    return;
  }

  let repoRoot = process.cwd();
  try { repoRoot = detectRepoRoot(); } catch { /* domain resolution reports the repository error */ }

  try {
    const result = await dispatchTaskControlOperation(
      createDirectHostExecutionContext({
        repoRoot,
        ...(process.env.AGENT_INFRA_RUNTIME_DIR ? { runtimeDir: process.env.AGENT_INFRA_RUNTIME_DIR } : {})
      }),
      operation
    );
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.status === 'failed') process.exitCode = 1;
  } catch (error) {
    if (!(error instanceof OrchestrationStateError)) throw error;
    process.stdout.write(`${JSON.stringify({
      status: 'failed', changed: false, taskId: error.taskId, run: null, next: null,
      error: { code: error.code, message: error.message }
    })}\n`);
    process.exitCode = 1;
  }
}

export { taskOrchestration };
