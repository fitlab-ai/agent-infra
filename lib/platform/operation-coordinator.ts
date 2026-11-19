import { recoverPlatformOperations } from '../task/platform-operation-recovery.ts';
import { recordPlatformOperation } from '../task/platform-operation-journal.ts';
import type { PlatformError } from './types.ts';
import type { CoordinateInput, OperationResult } from './operation-coordination-types.ts';

function persistenceError(error: unknown, fallback: string, message: string): PlatformError {
  const value = error as { code?: string; message?: string };
  return { code: value.code || fallback, message: value.message || message, retryable: true };
}

function queuePlatformWrite<T extends OperationResult>(input: CoordinateInput<T>): string | T {
  try { return recordPlatformOperation({ ...input.operation, state: 'queued' }).id; }
  catch (error) { return input.persistenceFailure(persistenceError(error, 'PLATFORM_OPERATION_JOURNAL_WRITE_FAILED', 'Unable to queue platform operation')); }
}

async function drainPreviousOperations<T extends OperationResult>(input: CoordinateInput<T>, operationId: string) {
  const boundedPr = input.operation.kind === 'pull-request' && input.operation.dependency === 'required';
  const selection = boundedPr || input.operation.kind === 'issue-metadata' && input.operation.issueMetadata?.state === 'closed'
    ? 'all' : input.operation.dependency;
  const drained = input.drain
    ? await input.drain(input.operation.taskRef, operationId, input.agent, input.operation.cwd)
    : await recoverPlatformOperations(input.operation.taskRef, selection, {
      agent: input.agent, client: input.client, cwd: input.operation.cwd, excludeId: operationId,
      ...(boundedPr ? { beforeId: operationId } : {})
    });
  return { drained, boundedPr };
}

function blockedByPrevious<T extends OperationResult>(input: CoordinateInput<T>, error: { code: string; message: string; retryable?: boolean } | null): T {
  return input.block(error ? { ...error, retryable: true } : {
    code: 'PLATFORM_OPERATION_QUEUE_BLOCKED',
    message: 'A previous platform operation is still unresolved; the current write remains queued',
    retryable: true
  });
}

function markPending<T extends OperationResult>(input: CoordinateInput<T>): T | null {
  try { recordPlatformOperation({ ...input.operation, state: 'pending' }); return null; }
  catch (error) { return input.persistenceFailure(persistenceError(error, 'PLATFORM_OPERATION_JOURNAL_WRITE_FAILED', 'Unable to mark platform operation as started')); }
}

async function executePlatformWrite<T extends OperationResult>(input: CoordinateInput<T>): Promise<T> {
  try { return await input.execute(); }
  catch (error) {
    const value = error as { code?: string; message?: string };
    return input.block({ code: value.code || 'PLATFORM_WRITE_FAILED', message: value.message || String(error), retryable: true });
  }
}

function operationTerminalState(output: OperationResult): 'succeeded' | 'failed' | 'unknown' {
  if ((output.status === 'applied' || output.status === 'no-op') && !output.error && !(output.warnings?.length)) return 'succeeded';
  return output.status === 'failed' && output.error?.retryable === false ? 'failed' : 'unknown';
}

function persistOperationOutcome<T extends OperationResult>(input: CoordinateInput<T>, output: T): T | null {
  try {
    recordPlatformOperation({ ...input.operation, state: operationTerminalState(output),
      lastCode: output.error?.code ?? output.warnings?.[0]?.code ?? null });
    return null;
  } catch (error) { return input.persistenceFailure(persistenceError(error, 'PLATFORM_OPERATION_JOURNAL_WRITE_FAILED', 'Unable to persist platform operation outcome')); }
}

async function coordinatePlatformWrite<T extends OperationResult>(input: CoordinateInput<T>): Promise<T> {
  const queued = queuePlatformWrite(input);
  if (typeof queued !== 'string') return queued;
  const { drained } = await drainPreviousOperations(input, queued);
  if (drained.status !== 'applied' && drained.status !== 'no-op') return blockedByPrevious(input, drained.error);
  const pendingFailure = markPending(input);
  if (pendingFailure) return pendingFailure;
  const output = await executePlatformWrite(input);
  return persistOperationOutcome(input, output) ?? output;
}

export { coordinatePlatformWrite };
