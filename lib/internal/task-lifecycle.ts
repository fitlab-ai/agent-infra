import {
  createDirectHostExecutionContext,
  dispatchTaskControlOperation,
  parseTaskControlOperation,
  type TaskLifecycleControlRequest
} from '../task/control-authority.ts';
import { lifecycleIntentCatalog } from '../task/lifecycle.ts';
import { detectRepoRoot, resolveTaskRef } from '../task/resolve-ref.ts';
import type { TaskLifecycleResult } from '../task/lifecycle.ts';

const USAGE = `Usage: agent-infra-internal task-lifecycle <N | TASK-id> <intent> --agent <agent> [intent flags] [--dry-run]\n\nIntents: ${lifecycleIntentCatalog.join(', ')}\nOverride: --override-ticket <ticket> --override-target <target> --override-scope <scope>\n`;

function usageFailure(message: string): void {
  process.stdout.write(`${JSON.stringify({ status: 'failed', changed: false, error: { code: 'LIFECYCLE_PAYLOAD_INVALID', message } })}\n`);
  process.stderr.write(USAGE);
  process.exitCode = 1;
}

function parseFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^TASK_CONTROL_OPERATION_INVALID: /u, '');
}

function taskLifecycle(args: string[] = []): void {
  if (args[0] === '--help' || args[0] === '-h') { process.stdout.write(USAGE); return; }

  let operation;
  try {
    operation = parseTaskControlOperation('task-lifecycle', args);
  } catch (error) {
    usageFailure(parseFailure(error));
    return;
  }
  if (operation.family !== 'task-lifecycle') {
    usageFailure('lifecycle operation is invalid');
    return;
  }

  const request = operation.request as TaskLifecycleControlRequest;
  let repoRoot: string;
  if (request.intent === 'restore') {
    try {
      repoRoot = detectRepoRoot();
    } catch (error) {
      process.stdout.write(`${JSON.stringify({ status: 'failed', changed: false, error: { code: 'REPO_ROOT_NOT_FOUND', message: error instanceof Error ? error.message : String(error) } })}\n`);
      process.exitCode = 1;
      return;
    }
  } else {
    const resolved = resolveTaskRef(request.taskRef);
    if (!resolved.ok) {
      process.stdout.write(`${JSON.stringify({ status: 'failed', changed: false, error: { code: resolved.code, message: resolved.message } })}\n`);
      process.exitCode = 1;
      return;
    }
    repoRoot = resolved.repoRoot;
  }

  const result = dispatchTaskControlOperation(
    createDirectHostExecutionContext({ repoRoot }),
    operation
  ) as TaskLifecycleResult & { humanOverride?: unknown };
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.status === 'failed') process.exitCode = 1;
}

export { taskLifecycle };
