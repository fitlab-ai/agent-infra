import path from 'node:path';

import type {
  PlatformError,
  ProviderOperationContext,
  PlatformProvider,
  ProviderResult,
  ResourceIdentity
} from './provider-contract.ts';
import type { LoadedContext } from './context.ts';
import type { PlatformResult } from './types.ts';

function providerOperationContext(
  loaded: LoadedContext,
  workingDirectory = loaded.workingDirectory,
  scopeId = loaded.snapshot.scope.id
): ProviderOperationContext {
  return {
    repositoryRoot: loaded.repositoryRoot,
    workingDirectory: path.resolve(workingDirectory),
    scopeId,
    ...(loaded.snapshot.scope.label ? { scopeLabel: loaded.snapshot.scope.label } : {})
  };
}

function providerError(error: PlatformError, fallbackCode: string): PlatformError {
  return {
    code: error.code || fallbackCode,
    message: error.message || 'Platform provider operation failed',
    retryable: error.retryable
  };
}

function providerStatus(error: PlatformError): PlatformResult['status'] {
  return error.retryable ? 'blocked' : 'failed';
}

function unsupportedProviderOperation(
  provider: PlatformProvider,
  operation: string
): ProviderResult<never> {
  return {
    ok: false,
    error: {
      code: 'PLATFORM_CAPABILITY_UNSUPPORTED',
      message: `Platform '${provider.type}' does not provide ${operation}`,
      retryable: false,
      providerType: provider.type,
      phase: 'operation'
    }
  };
}

function resourceIdentity(number: number): ResourceIdentity {
  return { number };
}

export {
  providerError,
  providerOperationContext,
  providerStatus,
  resourceIdentity,
  unsupportedProviderOperation
};
