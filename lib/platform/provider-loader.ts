import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

import {
  PLATFORM_PROVIDER_CONTRACT_VERSION,
  isPlatformProviderFactory,
  validatePlatformProvider
} from './provider-contract.ts';
import type {
  JsonValue,
  PlatformError,
  PlatformProvider,
  PlatformProviderFactoryInput
} from './provider-contract.ts';
import { createGitHubProvider } from './github-provider.ts';
import { createNoneProvider } from './none-provider.ts';
import { wrapProviderOperations } from './provider-validation.ts';
import type { PlatformClient } from './context.ts';

type ProviderLoaderOptions = {
  cwd?: string;
  platformType?: string;
  client?: PlatformClient;
};

type LoadedPlatformProvider = {
  provider: PlatformProvider;
  providerType: string;
  repositoryRoot: string;
  workingDirectory: string;
  sourceIdentity: string;
};

type ProviderLoadResult =
  | { ok: true; value: LoadedPlatformProvider }
  | { ok: false; error: PlatformError };

type ResolvedExternalSource = {
  sourceIdentity: string;
  importUrl: string;
};

const sessions = new Map<string, Promise<PlatformProvider>>();

function findRepositoryRoot(cwd: string): string {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe']
    }).trim();
  } catch {
    return cwd;
  }
}

function failure(
  providerType: string,
  phase: string,
  code: string,
  message: string
): ProviderLoadResult {
  return {
    ok: false,
    error: { code, message, retryable: false, providerType, phase }
  };
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (!value || typeof value !== 'object') return false;
  return Object.values(value).every(isJsonValue);
}

function canonicalJson(value: JsonValue): string {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map((key) =>
      JSON.stringify(key) + ':' + canonicalJson(value[key]!)
    ).join(',') + '}';
  }
  return JSON.stringify(value);
}

function configFingerprint(config: Readonly<Record<string, JsonValue>>): string {
  return createHash('sha256').update(canonicalJson(config)).digest('hex');
}

function readPlatformConfig(repositoryRoot: string): Record<string, unknown> {
  try {
    const file = path.join(repositoryRoot, '.agents', '.airc.json');
    const value: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function selectedEntry(
  config: Record<string, unknown>,
  providerType: string
): { source?: unknown; config?: unknown } {
  const platform = config.platform && typeof config.platform === 'object'
    ? config.platform as Record<string, unknown>
    : {};
  const providers = platform.providers && typeof platform.providers === 'object' && !Array.isArray(platform.providers)
    ? platform.providers as Record<string, unknown>
    : {};
  const entry = providers[providerType];
  return entry && typeof entry === 'object' && !Array.isArray(entry)
    ? entry as { source?: unknown; config?: unknown }
    : {};
}

function resolveExternalSource(
  repositoryRoot: string,
  source: string,
  providerType: string
): { ok: false; error: PlatformError } | { ok: true; value: ResolvedExternalSource } {
  try {
    const isPath = source.startsWith('.') || path.isAbsolute(source) || /^[A-Za-z]:[\\/]/u.test(source);
    const resolved = isPath
      ? path.resolve(repositoryRoot, source)
      : createRequire(path.join(repositoryRoot, 'package.json')).resolve(source);
    const realPath = fs.realpathSync(resolved);
    const importUrl = pathToFileURL(realPath).href;
    return { ok: true, value: { sourceIdentity: importUrl, importUrl } };
  } catch {
    return {
      ok: false,
      error: {
        code: 'PLATFORM_PROVIDER_SOURCE_RESOLUTION_FAILED',
        message: 'Selected provider source could not be resolved',
        retryable: false,
        providerType,
        phase: 'source-resolution'
      }
    };
  }
}

async function instantiateProvider(
  providerType: string,
  repositoryRoot: string,
  importUrl: string | null,
  config: Readonly<Record<string, JsonValue>>,
  client?: PlatformClient
): Promise<PlatformProvider> {
  const input: PlatformProviderFactoryInput = {
    providerType,
    contractVersion: PLATFORM_PROVIDER_CONTRACT_VERSION,
    repositoryRoot,
    config
  };
  if (providerType === 'github') return createGitHubProvider(input, client as never);
  if (providerType === 'none') return createNoneProvider(input);

  let moduleValue: Record<string, unknown>;
  try {
    moduleValue = await import(importUrl!);
  } catch {
    throw Object.assign(new Error('Selected provider source could not be imported'), {
      code: 'PLATFORM_PROVIDER_IMPORT_FAILED'
    });
  }
  const factory = moduleValue.default;
  if (!isPlatformProviderFactory(factory)) {
    throw Object.assign(new Error('Selected provider must default-export an async factory'), {
      code: 'PLATFORM_PROVIDER_EXPORT_INVALID'
    });
  }
  let provider: unknown;
  try {
    const candidate = factory(input);
    if (!candidate || typeof (candidate as PromiseLike<unknown>).then !== 'function') {
      throw Object.assign(new Error('Provider factory must return a Promise'), {
        code: 'PLATFORM_PROVIDER_EXPORT_INVALID'
      });
    }
    provider = await candidate;
  } catch (cause) {
    if (cause && typeof cause === 'object' && 'code' in cause
      && cause.code === 'PLATFORM_PROVIDER_EXPORT_INVALID') throw cause;
    throw Object.assign(new Error('Provider factory failed'), {
      code: 'PLATFORM_PROVIDER_FACTORY_FAILED'
    });
  }
  if (provider && typeof provider === 'object' && 'type' in provider && provider.type !== providerType) {
    throw Object.assign(new Error('Provider type does not match platform.type'), {
      code: 'PLATFORM_PROVIDER_TYPE_MISMATCH'
    });
  }
  if (provider && typeof provider === 'object' && 'contractVersion' in provider
    && provider.contractVersion !== PLATFORM_PROVIDER_CONTRACT_VERSION) {
    throw Object.assign(new Error('Provider contract version is unsupported'), {
      code: 'PLATFORM_PROVIDER_VERSION_UNSUPPORTED'
    });
  }
  const validated = validatePlatformProvider(provider, providerType);
  if (!validated.ok) {
    throw Object.assign(new Error(validated.error.message), {
      code: validated.error.code
    });
  }
  return wrapProviderOperations(validated.value);
}

async function loadPlatformProvider(options: ProviderLoaderOptions = {}): Promise<ProviderLoadResult> {
  const workingDirectory = path.resolve(options.cwd || process.cwd());
  const repositoryRoot = path.resolve(findRepositoryRoot(workingDirectory));
  const config = readPlatformConfig(repositoryRoot);
  const platform = config.platform && typeof config.platform === 'object'
    ? config.platform as Record<string, unknown>
    : {};
  const providerType = options.platformType
    ?? (typeof platform.type === 'string' ? platform.type : '');
  if (!providerType) return failure('', 'config', 'PLATFORM_PROVIDER_CONFIG_INVALID', 'platform.type must be a non-empty string');

  const entry = selectedEntry(config, providerType);
  const rawConfig = entry.config === undefined ? {} : entry.config;
  if (!rawConfig || typeof rawConfig !== 'object' || Array.isArray(rawConfig) || !isJsonValue(rawConfig)) {
    return failure(providerType, 'config', 'PLATFORM_PROVIDER_CONFIG_INVALID', 'Selected provider config must be a JSON object');
  }
  const providerConfig = rawConfig as Record<string, JsonValue>;
  let sourceIdentity: string;
  let importUrl: string | null = null;
  if (providerType === 'github' || providerType === 'none') {
    sourceIdentity = 'builtin:' + providerType + '@' + PLATFORM_PROVIDER_CONTRACT_VERSION;
  } else {
    if (typeof entry.source !== 'string' || !entry.source.trim()) {
      return failure(providerType, 'config', 'PLATFORM_PROVIDER_SOURCE_MISSING', 'Selected provider source is required');
    }
    const resolved = resolveExternalSource(repositoryRoot, entry.source, providerType);
    if (!resolved.ok) return resolved;
    sourceIdentity = resolved.value.sourceIdentity;
    importUrl = resolved.value.importUrl;
  }

  const key = [
    repositoryRoot,
    providerType,
    sourceIdentity,
    configFingerprint(providerConfig)
  ].join('\u0000');
  const reuseSession = !(providerType === 'github' && options.client);
  let session = reuseSession ? sessions.get(key) : undefined;
  if (!session) {
    session = instantiateProvider(providerType, repositoryRoot, importUrl, providerConfig, options.client);
    if (reuseSession) {
      sessions.set(key, session);
      session.catch(() => {
        if (sessions.get(key) === session) sessions.delete(key);
      });
    }
  }
  try {
    const provider = await session;
    return {
      ok: true,
      value: { provider, providerType, repositoryRoot, workingDirectory, sourceIdentity }
    };
  } catch (cause) {
    const code = cause && typeof cause === 'object' && 'code' in cause && typeof cause.code === 'string'
      ? cause.code
      : 'PLATFORM_PROVIDER_FACTORY_FAILED';
    const phase = code === 'PLATFORM_PROVIDER_IMPORT_FAILED'
      ? 'import'
      : code === 'PLATFORM_PROVIDER_EXPORT_INVALID'
        ? 'export'
        : code === 'PLATFORM_PROVIDER_TYPE_MISMATCH' || code === 'PLATFORM_PROVIDER_VERSION_UNSUPPORTED' || code === 'PLATFORM_PROVIDER_CONTRACT_INVALID'
          ? 'validation'
          : 'factory';
    const messages: Record<string, string> = {
      PLATFORM_PROVIDER_IMPORT_FAILED: 'Selected provider source could not be imported',
      PLATFORM_PROVIDER_EXPORT_INVALID: 'Selected provider must default-export an async factory',
      PLATFORM_PROVIDER_TYPE_MISMATCH: 'Provider type does not match platform.type',
      PLATFORM_PROVIDER_VERSION_UNSUPPORTED: 'Provider contract version is unsupported',
      PLATFORM_PROVIDER_CONTRACT_INVALID: 'Provider does not satisfy the platform provider contract',
      PLATFORM_PROVIDER_FACTORY_FAILED: 'Selected provider factory failed'
    };
    return failure(providerType, phase, code, messages[code] ?? 'Selected provider failed to load');
  }
}

function clearProviderSessions(): void {
  sessions.clear();
}

export {
  canonicalJson,
  clearProviderSessions,
  configFingerprint,
  findRepositoryRoot,
  loadPlatformProvider
};

export type {
  LoadedPlatformProvider,
  ProviderLoadResult,
  ProviderLoaderOptions
};
