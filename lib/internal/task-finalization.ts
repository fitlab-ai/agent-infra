import {
  createDirectHostExecutionContext,
  dispatchTaskControlOperation,
  parseTaskControlOperation
} from '../task/control-authority.ts';
import { applyTaskFinalization } from '../task/finalization.ts';
import { detectRepoRoot, resolveTaskRef } from '../task/resolve-ref.ts';
import { resolveSandboxControlTransport } from './task-operation-registry.ts';
import { requestSandboxTaskFinalization, SandboxControlClientError } from '../sandbox/control/client.ts';
import { serializeTaskFinalizationEnvelope } from '../task/finalization-envelope.ts';
import { ensureInternalHandlerRoute, internalHandlerRoute } from './cli-route-inventory.ts';

const USAGE = 'Usage: agent-infra-internal task-finalization <N | TASK-id> complete --agent <agent>\n';

type FinalizationError = Readonly<{ code: string; message: string; retryable: boolean }>;

function envelope(
  status: 'completed' | 'failed' | 'blocked' | 'unknown',
  changed: boolean | null,
  accepted: boolean,
  result: Awaited<ReturnType<typeof applyTaskFinalization>> | null,
  error: FinalizationError | null,
  requestId: string | null = null
): string {
  return serializeTaskFinalizationEnvelope({ status, changed, accepted, requestId, result, error });
}

function exitCode(status: 'completed' | 'failed' | 'blocked' | 'unknown'): number {
  return status === 'completed' ? 0 : status === 'blocked' ? 2 : 1;
}

function fail(message: string): void {
  const error = { code: 'TASK_FINALIZATION_PAYLOAD_INVALID', message, retryable: false };
  process.stdout.write(envelope('failed', false, false, null, error));
  process.stderr.write(USAGE);
  process.exitCode = 1;
}

function parseFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^TASK_CONTROL_OPERATION_INVALID: /u, '');
}

async function taskFinalization(args: string[] = []): Promise<void> {
  if (args[0] === '--help' || args[0] === '-h') { process.stdout.write(USAGE); return; }
  if (!ensureInternalHandlerRoute('task-finalization', args)) return;

  let operation;
  try {
    operation = parseTaskControlOperation('task-finalization', args);
  } catch (error) {
    fail(parseFailure(error));
    return;
  }
  if (operation.family !== 'task-finalization' || !internalHandlerRoute('task-finalization', 'complete', args[1] ?? '')) {
    fail('finalization operation is invalid');
    return;
  }

  let repoRoot: string;
  try {
    repoRoot = detectRepoRoot();
  } catch (error) {
    const detail = { code: 'REPO_ROOT_NOT_FOUND', message: error instanceof Error ? error.message : String(error), retryable: false };
    process.stdout.write(envelope('failed', false, true, null, detail));
    process.exitCode = 1;
    return;
  }
  const resolved = resolveTaskRef(operation.request.taskRef, { repoRoot });
  if (!resolved.ok) {
    const detail = { code: resolved.code, message: resolved.message, retryable: false };
    process.stdout.write(envelope('failed', false, true, null, detail));
    process.exitCode = 1;
    return;
  }
  const boundOperation = {
    ...operation,
    request: { ...operation.request, taskRef: resolved.taskId }
  };
  const transport = resolveSandboxControlTransport(process.env, { localWorkflow: true });
  if (transport.kind === 'sandbox-local') {
    try {
      const response = requestSandboxTaskFinalization({
        agent: boundOperation.request.agent
      });
      process.stdout.write(response.stdout);
      process.stderr.write(response.stderr);
      process.exitCode = response.exitCode ?? 1;
      return;
    } catch (error) {
      const clientError = error instanceof SandboxControlClientError ? error : null;
      const detail = clientError
        ? clientError.detail
        : { code: 'SANDBOX_CONTROL_CLIENT_FAILED', message: error instanceof Error ? error.message : String(error), retryable: false };
      const status = detail.code === 'SANDBOX_CONTROL_RESULT_UNKNOWN'
        ? 'unknown'
        : detail.retryable ? 'blocked' : 'failed';
      const changed = status === 'unknown' ? null : false;
      process.stdout.write(envelope(status, changed, clientError?.accepted ?? false, null, detail, clientError?.requestId ?? null));
      process.exitCode = exitCode(status);
      return;
    }
  }
  const result = await dispatchTaskControlOperation(
    createDirectHostExecutionContext({ repoRoot }),
    boundOperation
  );
  if (result.status === 'prepared') {
    const detail = {
      code: 'TASK_FINALIZATION_DIRECT_COMMIT_REQUIRED',
      message: 'direct finalization prepared external work without committing the lifecycle transition',
      retryable: false
    };
    process.stdout.write(envelope('failed', result.changed, true, result, detail));
    process.exitCode = 1;
    return;
  }
  process.stdout.write(envelope(result.status, result.changed, true, result, result.error));
  process.exitCode = exitCode(result.status);
}

export { taskFinalization };
