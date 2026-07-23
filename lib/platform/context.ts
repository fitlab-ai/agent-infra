import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import semver from 'semver';

import { getPlatformAdapter, registerPlatformAdapter } from './adapters.ts';
import { createGitHubClient, MINIMUM_GITHUB_CLI_VERSION } from './github-client.ts';
import type { GitHubClient } from './github-client.ts';
import { platformResult } from './types.ts';
import type { PlatformResult } from './types.ts';

type ContextOptions = {
  cwd?: string;
  gitRemote?: (cwd: string) => string | null;
  client?: {
    version(options?: Parameters<GitHubClient['version']>[0]): ReturnType<GitHubClient['version']>;
    json(args: string[], options?: Parameters<GitHubClient['json']>[1]): ReturnType<GitHubClient['json']>;
  };
  platformType?: string;
};

function findRepoRoot(cwd: string): string {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe']
    }).trim();
  } catch {
    return cwd;
  }
}

function parseGitHubRemote(remote: string): string | null {
  const trimmed = remote.trim().replace(/\.git$/, '');
  const match = trimmed.match(/^(?:https?:\/\/github\.com\/|ssh:\/\/(?:git@)?github\.com\/|git@github\.com:)([^/\s]+\/[^/\s]+)$/i);
  return match?.[1] || null;
}

function defaultGitRemote(cwd: string): string | null {
  try {
    return execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe']
    }).trim();
  } catch {
    return null;
  }
}

function readPlatformType(repoRoot: string): string | null {
  try {
    const config = JSON.parse(fs.readFileSync(path.join(repoRoot, '.agents', '.airc.json'), 'utf8'));
    return typeof config?.platform?.type === 'string' ? config.platform.type : null;
  } catch {
    return null;
  }
}

function failure(error: { code: string; message: string; retryable: boolean }, repo: string | null): PlatformResult {
  const blocked = error.retryable || error.code === 'AUTH_REQUIRED' || error.code === 'PLATFORM_DEPENDENCY_MISSING';
  return platformResult(blocked ? 'blocked' : 'failed', {
    platform: { type: 'github', repository: repo, currentUser: null }, error
  });
}

function resolveGitHubContext(options: ContextOptions & { cwd: string }): PlatformResult {
  const { cwd } = options;
  const platform = 'github';
  const client = options.client || createGitHubClient();
  const version = client.version({ cwd });
  if (!version.ok) return failure(version.error, null);
  if (!semver.gte(version.value, MINIMUM_GITHUB_CLI_VERSION)) {
    return failure({
      code: 'GH_CLI_VERSION_UNSUPPORTED',
      message: `GitHub CLI ${version.value} is unsupported; install gh >= ${MINIMUM_GITHUB_CLI_VERSION}`,
      retryable: false
    }, null);
  }
  const remote = (options.gitRemote || defaultGitRemote)(cwd);
  if (!remote) {
    return platformResult('no-op', {
      platform: { type: platform, repository: null, currentUser: null },
      error: { code: 'REMOTE_MISSING', message: 'Git origin remote is not configured', retryable: false }
    });
  }
  const ownerRepo = parseGitHubRemote(remote);
  if (!ownerRepo) {
    const nonGitHub = !/github\.com/i.test(remote);
    return platformResult(nonGitHub ? 'no-op' : 'failed', {
      platform: { type: platform, repository: null, currentUser: null },
      error: {
        code: nonGitHub ? 'PLATFORM_UNSUPPORTED' : 'REMOTE_INVALID',
        message: `Unable to parse GitHub owner/repo from '${remote}'`,
        retryable: false
      }
    });
  }

  const repository = client.json(['api', `repos/${ownerRepo}`], { cwd });
  if (!repository.ok) return failure(repository.error, null);
  const repositoryValue = repository.value as { fork?: boolean; full_name?: string; parent?: { full_name?: string } } | null;
  const upstream = repositoryValue?.fork ? repositoryValue.parent?.full_name : repositoryValue?.full_name;
  if (!upstream) {
    return platformResult('blocked', {
      platform: { type: platform, repository: null, currentUser: null },
      error: { code: 'UPSTREAM_UNRESOLVED', message: 'Unable to resolve the upstream repository', retryable: false }
    });
  }
  const user = client.json(['api', 'user'], { cwd });
  if (!user.ok) return failure(user.error, upstream);
  const userValue = user.value as { login?: string } | null;
  const permissions = client.json(['api', `repos/${upstream}`], { cwd });
  if (!permissions.ok) return failure(permissions.error, upstream);
  const permissionValue = permissions.value as { permissions?: Record<string, boolean> } | null;
  const values = permissionValue?.permissions || {};
  const capabilities = {
    authenticated: Boolean(userValue?.login),
    comment: Boolean(userValue?.login),
    triage: Boolean(values.triage || values.push || values.admin),
    push: Boolean(values.push || values.admin),
    admin: Boolean(values.admin)
  };
  const status = Object.values(capabilities).every(Boolean) ? 'no-op' : 'degraded';
  return platformResult(status, {
    changed: false,
    platform: { type: platform, repository: upstream, currentUser: userValue?.login || null },
    resource: { kind: 'repository', number: null },
    capabilities,
    operations: [{ name: 'resolve', status: 'no-op', reasonCode: null }]
  });
}

registerPlatformAdapter({
  type: 'github',
  resolveContext(options) {
    return resolveGitHubContext(options as ContextOptions & { cwd: string });
  }
});

registerPlatformAdapter({
  type: 'none',
  resolveContext() {
    return platformResult('no-op', {
      platform: { type: 'none', repository: null, currentUser: null },
      operations: [{ name: 'resolve', status: 'no-op', reasonCode: 'PLATFORM_DISABLED' }]
    });
  }
});

function resolvePlatformContext(options: ContextOptions = {}): PlatformResult {
  const cwd = path.resolve(options.cwd || process.cwd());
  const repoRoot = findRepoRoot(cwd);
  const platform = options.platformType ?? readPlatformType(repoRoot);
  const adapter = getPlatformAdapter(platform);
  if (!adapter) {
    return platformResult('no-op', {
      platform: { type: platform, repository: null, currentUser: null },
      error: { code: 'PLATFORM_UNSUPPORTED', message: `Platform '${platform || 'none'}' has no registered adapter`, retryable: false }
    });
  }
  return adapter.resolveContext({ cwd, gitRemote: options.gitRemote, client: options.client });
}

export { parseGitHubRemote, resolvePlatformContext };
export type { ContextOptions };
