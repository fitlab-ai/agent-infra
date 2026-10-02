import path from 'node:path';

import type {
  ProviderError,
  ProviderOperationContext,
  PlatformProvider,
  ProviderResult,
  ResourceIdentity
} from './provider-contract.ts';
import {
  identityFromRemoteValue,
  parseResourceIdentity,
  parseResourceToken,
  resourceIdentityNumber
} from './resource-identity.ts';
import type { LoadedContext } from './context.ts';
import type { PlatformResult } from './types.ts';
import type { PlatformError } from './types.ts';
import { providerErrorRetryable } from './provider-validation.ts';
import type { NormalizedProviderResult } from './provider-validation.ts';

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

function providerError(error: ProviderError | PlatformError, fallbackCode: string): PlatformError {
  return {
    code: error.code || fallbackCode,
    message: error.message || 'Platform provider operation failed',
    retryable: 'retryable' in error ? error.retryable : providerErrorRetryable(error.code)
  };
}

function providerStatus(error: ProviderError | PlatformError): PlatformResult['status'] {
  return ('retryable' in error ? error.retryable : providerErrorRetryable(error.code)) ? 'blocked' : 'failed';
}

function unsupportedProviderOperation(
  provider: PlatformProvider,
  operation: string
): NormalizedProviderResult<never> {
  return {
    ok: false,
    error: {
      code: 'PLATFORM_CAPABILITY_UNSUPPORTED',
      message: `Platform '${provider.type}' does not provide ${operation}`,
      retryable: false
    }
  };
}

function resourceIdentity(value: number | string | ResourceIdentity): ResourceIdentity {
  if (typeof value === 'object') return parseResourceIdentity(value);
  return parseResourceIdentity(typeof value === 'number' ? { kind: 'number', value } : { kind: 'id', value });
}

function providerResourceToken(provider: PlatformProvider, resourceKind: 'issue' | 'pull-request' | 'comment' | 'release', token: string): ResourceIdentity {
  return parseResourceToken(token, resourceKind, provider.identity);
}

function providerResourceIdentity(provider: PlatformProvider, resourceKind: 'issue' | 'pull-request' | 'comment' | 'release', value: unknown): ResourceIdentity {
  return identityFromRemoteValue(value, resourceKind, provider.identity);
}

export {
  providerError,
  providerOperationContext,
  providerStatus,
  providerResourceIdentity,
  providerResourceToken,
  resourceIdentity,
  resourceIdentityNumber,
  unsupportedProviderOperation
};
