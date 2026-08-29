import { normalizeAgentToken, AGENT_USAGE_HINT } from '../agent-clients/tokens.ts';
import { applyTaskFinalization } from '../task/finalization.ts';
import { detectRepoRoot, resolveTaskRef } from '../task/resolve-ref.ts';
import {
  assertTaskControlOperation,
  createDirectHostExecutionContext,
  dispatchTaskControlOperation
} from '../task/control-authority.ts';

const USAGE = 'Usage: agent-infra-internal task-finalization <N | TASK-id> complete --agent <agent>\n';

type FinalizationError = Readonly<{ code: string; message: string; retryable: boolean }>;

function envelope(
  status: 'completed' | 'failed' | 'blocked' | 'unknown',
  changed: boolean,
  accepted: boolean,
  result: ReturnType<typeof applyTaskFinalization> | null,
  error: FinalizationError | null
): string {
  return `${JSON.stringify({ version: 1, status, changed, accepted, result, error })}\n`;
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

function taskFinalization(args: string[] = []): void {
  if (args[0] === '--help' || args[0] === '-h') { process.stdout.write(USAGE); return; }
  if (args.length !== 4 || !args[0] || args[1] !== 'complete' || args[2] !== '--agent' || !args[3]) {
    fail('task ref, complete intent, and --agent are required');
    return;
  }
  const agent = normalizeAgentToken(args[3]);
  if (!agent) {
    fail(`invalid --agent: ${AGENT_USAGE_HINT}`);
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
  const resolved = resolveTaskRef(args[0], { repoRoot });
  if (!resolved.ok) {
    const detail = { code: resolved.code, message: resolved.message, retryable: false };
    process.stdout.write(envelope('failed', false, true, null, detail));
    process.exitCode = 1;
    return;
  }
  const operation = {
    family: 'task-finalization' as const,
    request: { taskRef: resolved.taskId, intent: 'complete' as const, agent }
  };
  assertTaskControlOperation(operation);
  const result = dispatchTaskControlOperation(
    createDirectHostExecutionContext({ repoRoot }),
    operation
  ) as ReturnType<typeof applyTaskFinalization>;
  process.stdout.write(envelope(result.status, result.changed, true, result, result.error));
  process.exitCode = exitCode(result.status);
}

export { taskFinalization };
