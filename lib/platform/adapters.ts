import type { PlatformError, PlatformResult } from './types.ts';

type PlatformAdapterContext = {
  cwd: string;
  gitRemote?: (cwd: string) => string | null;
  client?: unknown;
};

type PlatformChangeRequestSnapshot = {
  repository: string;
  number: number;
  nodeId: string;
  url: string;
  state: 'open' | 'closed';
  title: string;
  body: string;
  draft: boolean;
  head: { repository: string; ref: string; sha: string };
  base: { repository: string; ref: string; sha: string };
  mergedAt: string | null;
  mergeCommitSha: string | null;
  labels: string[];
  assignees: string[];
  milestone: string | null;
};

type PlatformCheckSnapshot = {
  name: string;
  bucket: 'pass' | 'fail' | 'pending' | 'cancel';
  workflow?: string | null;
  conclusion?: string | null;
  detailsUrl?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
};

type PlatformInspectionResult<T> = {
  ok: boolean;
  value?: T;
  error?: PlatformError;
};

type ChangeRequestInspectionContext = PlatformAdapterContext & {
  repository: string;
  number: number;
};

type RequiredChecksInspectionContext = ChangeRequestInspectionContext & {
  headSha: string;
};

type PlatformAdapter = {
  type: string;
  resolveContext(context: PlatformAdapterContext): PlatformResult;
  inspectChangeRequest?(
    context: ChangeRequestInspectionContext
  ): PlatformInspectionResult<PlatformChangeRequestSnapshot>;
  inspectRequiredChecks?(
    context: RequiredChecksInspectionContext
  ): PlatformInspectionResult<PlatformCheckSnapshot[]>;
};

const adapters = new Map<string, PlatformAdapter>();

function registerPlatformAdapter(adapter: PlatformAdapter): void {
  if (!adapter.type.trim()) throw new Error('Platform adapter type is required');
  adapters.set(adapter.type, adapter);
}

function getPlatformAdapter(type: string | null): PlatformAdapter | null {
  return type ? adapters.get(type) ?? null : null;
}

function registerPlatformCapabilities(
  type: string,
  capabilities: Pick<PlatformAdapter, 'inspectChangeRequest' | 'inspectRequiredChecks'>
): void {
  const adapter = adapters.get(type);
  if (!adapter) throw new Error(`Platform adapter '${type}' must be registered before its capabilities`);
  adapters.set(type, { ...adapter, ...capabilities });
}

function hasPlatformCapability(
  type: string | null,
  capability: 'change-request' | 'required-checks'
): boolean {
  const adapter = getPlatformAdapter(type);
  return capability === 'change-request'
    ? typeof adapter?.inspectChangeRequest === 'function'
    : typeof adapter?.inspectRequiredChecks === 'function';
}

function unsupported<T>(type: string | null, capability: string): PlatformInspectionResult<T> {
  return {
    ok: false,
    error: {
      code: 'PLATFORM_CAPABILITY_UNSUPPORTED',
      message: `Platform '${type || 'none'}' does not provide ${capability}`,
      retryable: false
    }
  };
}

function inspectPlatformChangeRequest(
  type: string | null,
  context: ChangeRequestInspectionContext
): PlatformInspectionResult<PlatformChangeRequestSnapshot> {
  const adapter = getPlatformAdapter(type);
  return adapter?.inspectChangeRequest?.(context) ?? unsupported(type, 'change-request inspection');
}

function inspectPlatformRequiredChecks(
  type: string | null,
  context: RequiredChecksInspectionContext
): PlatformInspectionResult<PlatformCheckSnapshot[]> {
  const adapter = getPlatformAdapter(type);
  return adapter?.inspectRequiredChecks?.(context) ?? unsupported(type, 'required-checks inspection');
}

function listPlatformAdapters(): string[] {
  return [...adapters.keys()].sort();
}

export {
  getPlatformAdapter,
  hasPlatformCapability,
  inspectPlatformChangeRequest,
  inspectPlatformRequiredChecks,
  listPlatformAdapters,
  registerPlatformAdapter,
  registerPlatformCapabilities
};
export type {
  ChangeRequestInspectionContext,
  PlatformAdapter,
  PlatformAdapterContext,
  PlatformChangeRequestSnapshot,
  PlatformCheckSnapshot,
  PlatformInspectionResult,
  RequiredChecksInspectionContext
};
