import { recoverPlatformOperations } from '../task/platform-operation-recovery.ts';
import { recordPlatformOperation } from '../task/platform-operation-journal.ts';
import type { RecordOperationInput } from '../task/platform-operation-journal.ts';
import type { PlatformError, PlatformStatus } from './types.ts';

type OperationResult = Readonly<{
  status: PlatformStatus;
  error?: PlatformError | null;
  warnings?: readonly { code: string }[];
}>;

type CoordinateInput<T extends OperationResult> = Readonly<{
  operation: Omit<RecordOperationInput, 'state' | 'lastCode'>;
  agent: string;
  drain?: (taskRef: string, excludeId: string, agent: string, cwd?: string) => Promise<{
    status: 'applied' | 'no-op' | 'blocked' | 'failed';
    error: PlatformError | null;
  }>;
  execute: () => Promise<T>;
  block: (error: PlatformError) => T;
  persistenceFailure: (error: PlatformError) => T;
}>;

async function coordinatePlatformWrite<T extends OperationResult>(input: CoordinateInput<T>): Promise<T> {
  let operationId: string;
  try {
    const queued = recordPlatformOperation({ ...input.operation, state: 'queued' });
    operationId = queued.id;
  } catch (error) {
    const value = error as { code?: string; message?: string };
    return input.persistenceFailure({
      code: value.code || 'PLATFORM_OPERATION_JOURNAL_WRITE_FAILED',
      message: value.message || 'Unable to queue platform operation',
      retryable: true
    });
  }

  const drained = input.drain
    ? await input.drain(input.operation.taskRef, operationId, input.agent, input.operation.cwd)
    : await recoverPlatformOperations(input.operation.taskRef, 'all', {
      agent: input.agent,
      cwd: input.operation.cwd,
      excludeId: operationId
    });
  if (drained.status !== 'applied' && drained.status !== 'no-op') {
    return input.block(drained.error ?? {
      code: 'PLATFORM_OPERATION_QUEUE_BLOCKED',
      message: 'A previous platform operation is still unresolved; the current write remains queued',
      retryable: true
    });
  }

  try {
    recordPlatformOperation({ ...input.operation, state: 'pending' });
  } catch (error) {
    const value = error as { code?: string; message?: string };
    return input.persistenceFailure({
      code: value.code || 'PLATFORM_OPERATION_JOURNAL_WRITE_FAILED',
      message: value.message || 'Unable to mark platform operation as started',
      retryable: true
    });
  }

  let output: T;
  try {
    output = await input.execute();
  } catch (error) {
    const value = error as { code?: string; message?: string };
    output = input.block({ code: value.code || 'PLATFORM_WRITE_FAILED', message: value.message || String(error), retryable: true });
  }
  const succeeded = (output.status === 'applied' || output.status === 'no-op')
    && !output.error && !(output.warnings?.length);
  const state = succeeded ? 'succeeded' : output.status === 'failed' && output.error?.retryable === false ? 'failed' : 'unknown';
  try {
    recordPlatformOperation({
      ...input.operation,
      state,
      lastCode: output.error?.code ?? output.warnings?.[0]?.code ?? null
    });
  } catch (error) {
    const value = error as { code?: string; message?: string };
    return input.persistenceFailure({
      code: value.code || 'PLATFORM_OPERATION_JOURNAL_WRITE_FAILED',
      message: value.message || 'Unable to persist platform operation outcome',
      retryable: true
    });
  }
  return output;
}

export { coordinatePlatformWrite };
