import type { RecordOperationInput } from '../task/platform-operation-journal.ts';
import type { PlatformError, PlatformStatus } from './types.ts';
import type { PlatformClient } from './context.ts';

export type OperationResult = Readonly<{
  status: PlatformStatus;
  error?: PlatformError | null;
  warnings?: readonly { code: string }[];
}>;

export type CoordinateInput<T extends OperationResult> = Readonly<{
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

export type CoordinatePlatformWrite = <T extends OperationResult>(input: CoordinateInput<T>) => Promise<T>;
export type CoordinatedWrite = { coordinate: CoordinatePlatformWrite };
export type DryRunWrite = { dryRun: true };
export type ReplayWrite = { skipQueue: true };
