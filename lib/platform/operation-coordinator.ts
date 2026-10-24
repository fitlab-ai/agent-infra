import { createHash, randomUUID } from 'node:crypto';
import { recoverPlatformOperations } from '../task/platform-operation-recovery.ts';
import { readPlatformOperationJournal, recordPlatformOperation } from '../task/platform-operation-journal.ts';
import type { RecordOperationInput } from '../task/platform-operation-journal.ts';
import type { PlatformError, PlatformStatus } from './types.ts';
import { platformResult } from './types.ts';
import type { PlatformClient } from './context.ts';
import { executeManagedSummary } from './managed-summary-core.ts';
import type { ManagedSummaryOutput, ManagedSummaryPolicy } from './managed-summary-core.ts';

type OperationResult = Readonly<{
  status: PlatformStatus;
  error?: PlatformError | null;
  warnings?: readonly { code: string }[];
}>;

type CoordinateInput<T extends OperationResult> = Readonly<{
  operation: Omit<RecordOperationInput, 'state' | 'lastCode'>;
  agent: string;
  client?: PlatformClient;
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

  const selection = input.operation.kind === 'issue-metadata' && input.operation.issueMetadata?.state === 'closed'
    ? 'all' : input.operation.dependency;
  const drained = input.drain
    ? await input.drain(input.operation.taskRef, operationId, input.agent, input.operation.cwd)
    : await recoverPlatformOperations(input.operation.taskRef, selection, {
      agent: input.agent,
      client: input.client,
      cwd: input.operation.cwd,
      excludeId: operationId
    });
  if (drained.status !== 'applied' && drained.status !== 'no-op') {
    return input.block(drained.error ? { ...drained.error, retryable: true } : {
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

type ManagedSummaryCoordinateInput = Readonly<{
  operation: Omit<RecordOperationInput, 'state' | 'lastCode' | 'stableId' | 'managedSummary'>;
  policy: ManagedSummaryPolicy;
  agent: string;
  client?: PlatformClient;
  drain?: CoordinateInput<OperationResult>['drain'];
}>;

async function coordinateManagedSummary(input: ManagedSummaryCoordinateInput): Promise<ManagedSummaryOutput> {
  const stableId = createHash('sha256').update(randomUUID()).digest('hex');
  const requestDigest = input.policy.requestDigest;
  const queued = queueManagedSummary(input, stableId, requestDigest);
  if (!queued.ok) return queued.output;
  const drained = await drainManagedSummary(input, stableId);
  if (drained.status !== 'applied' && drained.status !== 'no-op') return queueBlockedResult(drained.error);
  const output = await executeQueuedManagedSummary(input, queued.operation);
  return persistManagedSummaryOutcome(input, stableId, requestDigest, output);
}

function queueManagedSummary(input: ManagedSummaryCoordinateInput, stableId: string, requestDigest: string) {
  try {
    return { ok: true as const, operation: recordPlatformOperation({
      ...input.operation, stableId, managedSummary: { requestDigest }, state: 'queued'
    }) };
  } catch (error) {
    const value = error as { code?: string; message?: string };
    return { ok: false as const, output: { action: 'no-op' as const, result: platformResult('failed', { error: {
      code: value.code || 'PLATFORM_OPERATION_JOURNAL_WRITE_FAILED',
      message: value.message || 'Unable to queue managed summary', retryable: true
    } }) } };
  }
}

async function drainManagedSummary(input: ManagedSummaryCoordinateInput, stableId: string) {
  if (input.drain) return input.drain(input.operation.taskRef, stableId, input.agent, input.operation.cwd);
  return recoverPlatformOperations(input.operation.taskRef, input.operation.dependency, {
    agent: input.agent, client: input.client, cwd: input.operation.cwd, excludeId: stableId
  });
}

function queueBlockedResult(error: { code: string; message: string; retryable?: boolean } | null): ManagedSummaryOutput {
  return { action: 'no-op', result: platformResult('blocked', { error: error ? { ...error, retryable: true } : {
    code: 'PLATFORM_OPERATION_QUEUE_BLOCKED', message: 'A previous platform operation is unresolved; managed summary remains queued', retryable: true
  } }) };
}

async function executeQueuedManagedSummary(input: ManagedSummaryCoordinateInput, operation: Awaited<ReturnType<typeof recordPlatformOperation>>): Promise<ManagedSummaryOutput> {
  try { return await executeManagedSummary(input.policy, operation); }
  catch (error) {
    const value = error as { code?: string; message?: string };
    return { action: 'no-op', result: platformResult('blocked', { error: {
      code: value.code || 'MANAGED_SUMMARY_FAILED', message: value.message || String(error), retryable: true
    } }) };
  }
}

function managedSummaryOutcomeState(output: ManagedSummaryOutput, persistedState?: string): 'succeeded' | 'failed' | 'unknown' {
  if ((output.result.status === 'applied' || output.result.status === 'no-op') && !output.result.error) return 'succeeded';
  if (persistedState === 'failed' || (output.result.status === 'failed' && output.result.error?.retryable === false)) return 'failed';
  return 'unknown';
}

function persistManagedSummaryOutcome(input: ManagedSummaryCoordinateInput, stableId: string, requestDigest: string, output: ManagedSummaryOutput): ManagedSummaryOutput {
  const terminal = readPlatformOperationJournal(input.operation.taskRef, input.operation.cwd).operations.find((item) => item.id === stableId);
  try {
    recordPlatformOperation({
      ...input.operation, stableId, managedSummary: terminal?.managedSummary ?? { requestDigest },
      state: managedSummaryOutcomeState(output, terminal?.state),
      lastCode: output.result.error?.code ?? null
    });
  } catch (error) {
    const value = error as { code?: string; message?: string };
    return { action: output.action, result: { ...output.result, status: 'blocked', changed: false, error: {
      code: value.code || 'PLATFORM_OPERATION_JOURNAL_WRITE_FAILED', message: value.message || 'Unable to persist managed summary outcome', retryable: true
    } } };
  }
  return output;
}

export { coordinateManagedSummary, coordinatePlatformWrite, executeManagedSummary };
