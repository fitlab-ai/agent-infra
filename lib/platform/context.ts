import path from 'node:path';

import { loadPlatformProvider } from './provider-loader.ts';
import { defaultGitRemote, parseGitHubRemote } from './github-provider.ts';
import { platformResult } from './types.ts';
import type { PlatformResult } from './types.ts';
import type { PlatformProvider, PlatformContextSnapshot, PlatformError } from './provider-contract.ts';
import type { GitHubClient } from './github-client.ts';

type ContextOptions = {
  cwd?: string;
  gitRemote?: (cwd: string) => string | null;
  client?: {
    version(options?: Parameters<GitHubClient['version']>[0]): ReturnType<GitHubClient['version']>;
    json(args: string[], options?: Parameters<GitHubClient['json']>[1]): ReturnType<GitHubClient['json']>;
  };
  platformType?: string;
};

type LoadedContext = {
  provider: PlatformProvider;
  providerType: string;
  repositoryRoot: string;
  workingDirectory: string;
  sourceIdentity: string;
  snapshot: PlatformContextSnapshot;
  context: PlatformResult;
};

function errorStatus(error: PlatformError): PlatformResult['status'] {
  if (error.retryable || error.code === 'AUTH_REQUIRED' || error.code === 'PLATFORM_DEPENDENCY_MISSING') return 'blocked';
  if (error.code === 'REMOTE_MISSING' || error.code === 'PLATFORM_UNSUPPORTED') return 'no-op';
  return 'failed';
}

function contextError(
  providerType: string,
  error: PlatformError,
  repository: string | null = null
): PlatformResult {
  return platformResult(errorStatus(error), {
    platform: { type: providerType || null, repository, currentUser: null },
    error: { code: error.code, message: error.message, retryable: error.retryable }
  });
}

function contextFromSnapshot(
  providerType: string,
  snapshot: PlatformContextSnapshot
): PlatformResult {
  if (providerType === 'none') {
    return platformResult('no-op', {
      platform: { type: 'none', repository: null, currentUser: null },
      operations: [{ name: 'resolve', status: 'no-op', reasonCode: 'PLATFORM_DISABLED' }]
    });
  }
  const capabilities = snapshot.capabilities;
  const status = Object.values(capabilities).every(Boolean) ? 'no-op' : 'degraded';
  const repository = snapshot.scope.label || snapshot.scope.id || null;
  return platformResult(status, {
    platform: {
      type: snapshot.type || providerType,
      repository,
      currentUser: snapshot.currentUser?.name || snapshot.currentUser?.id || null
    },
    resource: { kind: 'repository', number: null },
    capabilities,
    operations: [{ name: 'resolve', status: 'no-op', reasonCode: null }]
  });
}

async function resolvePlatformProviderContext(options: ContextOptions = {}): Promise<
  { ok: true; value: LoadedContext } | { ok: false; context: PlatformResult }
> {
  const workingDirectory = path.resolve(options.cwd || process.cwd());
  const loaded = await loadPlatformProvider({
    cwd: workingDirectory,
    platformType: options.platformType,
    client: options.client as GitHubClient | undefined
  });
  if (!loaded.ok) {
    if (!loaded.error.providerType && options.platformType === undefined) {
      return {
        ok: false,
        context: platformResult('no-op', {
          platform: { type: null, repository: null, currentUser: null },
          error: {
            code: 'PLATFORM_UNSUPPORTED',
            message: 'No platform provider is configured',
            retryable: false
          }
        })
      };
    }
    return { ok: false, context: contextError(loaded.error.providerType || options.platformType || '', loaded.error) };
  }

  const gitRemote = options.gitRemote ? options.gitRemote(workingDirectory) : null;
  const resolved = await loaded.value.provider.context.resolve({
    repositoryRoot: loaded.value.repositoryRoot,
    workingDirectory,
    scopeId: loaded.value.repositoryRoot,
    gitRemote
  });
  if (!resolved.ok) return {
    ok: false,
    context: contextError(loaded.value.providerType, resolved.error)
  };
  return {
    ok: true,
    value: {
      ...loaded.value,
      snapshot: resolved.value,
      context: contextFromSnapshot(loaded.value.providerType, resolved.value)
    }
  };
}

async function resolvePlatformContext(options: ContextOptions = {}): Promise<PlatformResult> {
  const resolved = await resolvePlatformProviderContext(options);
  return resolved.ok ? resolved.value.context : resolved.context;
}

export { defaultGitRemote, parseGitHubRemote, resolvePlatformContext, resolvePlatformProviderContext };
export type { ContextOptions, LoadedContext };
