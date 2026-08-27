import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { getProcessIdentityState, type ProcessIdentity } from '../../../server/process-state.ts';
import type { CodexControllerLeaseProofV1, CodexControllerLeaseV1 } from '../../../sandbox/control/controller-registration.ts';
import {
  computeLifecycleBuildIdentity,
  verifyLifecycleBuildIdentity,
  type LifecycleBuildIdentity,
  type LifecycleIdentityWarning
} from './build-identity.ts';

const HEX_256 = /^[a-f0-9]{64}$/u;
const PROFILE_FILES = Object.freeze({
  executor: '.codex/agents/agent-infra-lifecycle-executor.toml',
  reviewer: '.codex/agents/agent-infra-lifecycle-reviewer.toml'
} as const);

export type LifecycleProfileSource = 'project' | 'managed' | 'isolated-user';
export type LifecycleProfileEntry = Readonly<{
  source: LifecycleProfileSource;
  sourcePathDigest: string;
  sourceHash: string;
  version: string;
}>;
export type LifecycleProfileProvenance = Readonly<{
  executor: LifecycleProfileEntry;
  reviewer: LifecycleProfileEntry;
}>;
export type LifecycleContextWarning = Readonly<{
  code: string;
  message: string;
  action: 'rebuild-sandbox';
}>;

export type CodexSandboxControllerContextV2 = Readonly<{
  version: 2;
  taskId: string;
  controlGeneration: string;
  controllerInstanceDigest: string;
  controllerProcess: ProcessIdentity;
  controllerLease: Readonly<{ version: 1; leaseId: string; leaseSecret: string }>;
  issuedAt: number;
  expiresAt: number;
  buildIdentity: LifecycleBuildIdentity;
  hookDefinitionHash: string;
  lifecycleProfilesHash: string;
  profileProvenance?: LifecycleProfileProvenance;
}>;

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

function hasExactKeys(value: unknown, required: readonly string[], optional: readonly string[] = []): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value as Record<string, unknown>);
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => keys.includes(key)) && keys.every((key) => allowed.has(key));
}

function profileFiles(repoRoot: string): Readonly<{ executor: string; reviewer: string }> {
  return {
    executor: path.join(repoRoot, PROFILE_FILES.executor),
    reviewer: path.join(repoRoot, PROFILE_FILES.reviewer)
  };
}

function digestProfiles(repoRoot: string): string {
  const files = Object.values(profileFiles(repoRoot));
  const hash = crypto.createHash('sha256');
  for (const file of files.sort()) {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('CODEX_SANDBOX_CONTROLLER_BUNDLE_MISMATCH');
    hash.update(path.basename(file));
    hash.update('\0');
    hash.update(fs.readFileSync(file));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function digestPath(value: string): string {
  return crypto.createHash('sha256').update(path.resolve(value)).digest('hex');
}

function profileEntry(file: string, version: string, source: LifecycleProfileSource): LifecycleProfileEntry {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('CODEX_LIFECYCLE_PROFILE_PROVENANCE_INVALID');
  }
  const content = fs.readFileSync(file);
  if (content.length === 0 || version.trim() !== version || version.length === 0) {
    throw new Error('CODEX_LIFECYCLE_PROFILE_PROVENANCE_INVALID');
  }
  return Object.freeze({
    source,
    sourcePathDigest: digestPath(file),
    sourceHash: crypto.createHash('sha256').update(content).digest('hex'),
    version
  });
}

export function computeLifecycleProfileProvenance(
  repoRoot: string,
  version: string,
  source: LifecycleProfileSource = 'project'
): LifecycleProfileProvenance {
  const files = profileFiles(repoRoot);
  return computeLifecycleProfileProvenanceFromFiles(files, version, source);
}

export function computeLifecycleProfileProvenanceFromFiles(
  files: Readonly<{ executor: string; reviewer: string }>,
  version: string,
  source: LifecycleProfileSource
): LifecycleProfileProvenance {
  return Object.freeze({
    executor: profileEntry(files.executor, version, source),
    reviewer: profileEntry(files.reviewer, version, source)
  });
}

function validProfileEntry(value: unknown): value is LifecycleProfileEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return exactKeys(entry, ['source', 'sourceHash', 'sourcePathDigest', 'version'])
    && ['project', 'managed', 'isolated-user'].includes(entry.source as string)
    && typeof entry.sourcePathDigest === 'string' && HEX_256.test(entry.sourcePathDigest)
    && typeof entry.sourceHash === 'string' && HEX_256.test(entry.sourceHash)
    && typeof entry.version === 'string' && entry.version.length > 0 && entry.version.trim() === entry.version;
}

export function isLifecycleProfileProvenance(value: unknown): value is LifecycleProfileProvenance {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const provenance = value as Record<string, unknown>;
  return exactKeys(provenance, ['executor', 'reviewer'])
    && validProfileEntry(provenance.executor)
    && validProfileEntry(provenance.reviewer);
}

export function profileProvenanceEqual(
  left: LifecycleProfileProvenance | null | undefined,
  right: LifecycleProfileProvenance | null | undefined
): boolean {
  if (!left || !right) return left === right;
  return JSON.stringify(left) === JSON.stringify(right);
}

function validProcess(value: unknown): value is ProcessIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const identity = value as Record<string, unknown>;
  return exactKeys(identity, ['pid', 'startTime'])
    && Number.isSafeInteger(identity.pid) && (identity.pid as number) > 0
    && Number.isSafeInteger(identity.startTime) && (identity.startTime as number) >= 0;
}

function validBuildIdentity(value: unknown): value is LifecycleBuildIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const identity = value as Record<string, unknown>;
  return exactKeys(identity, [
    'internalExecutableBuildHash', 'lifecycleContractHash', 'packageVersion', 'protocolVersion'
  ])
    && identity.protocolVersion === 3
    && typeof identity.packageVersion === 'string' && identity.packageVersion.length > 0
    && typeof identity.internalExecutableBuildHash === 'string' && HEX_256.test(identity.internalExecutableBuildHash)
    && typeof identity.lifecycleContractHash === 'string' && HEX_256.test(identity.lifecycleContractHash);
}

function validateContext(value: unknown): CodexSandboxControllerContextV2 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('CODEX_SANDBOX_CONTROLLER_CONTEXT_INVALID');
  }
  const context = value as Record<string, unknown>;
  const lease = context.controllerLease as Record<string, unknown> | null;
  if (!hasExactKeys(context, [
    'buildIdentity', 'controlGeneration', 'controllerInstanceDigest', 'controllerLease',
    'controllerProcess', 'expiresAt', 'hookDefinitionHash', 'issuedAt',
    'lifecycleProfilesHash', 'taskId', 'version'
  ], ['profileProvenance'])
    || context.version !== 2
    || typeof context.taskId !== 'string' || context.taskId.length === 0
    || typeof context.controlGeneration !== 'string' || context.controlGeneration.length === 0
    || typeof context.controllerInstanceDigest !== 'string' || !HEX_256.test(context.controllerInstanceDigest)
    || !validProcess(context.controllerProcess)
    || !lease || !exactKeys(lease, ['leaseId', 'leaseSecret', 'version'])
    || lease.version !== 1
    || typeof lease.leaseId !== 'string' || !HEX_256.test(lease.leaseId)
    || typeof lease.leaseSecret !== 'string' || !HEX_256.test(lease.leaseSecret)
    || !Number.isSafeInteger(context.issuedAt)
    || !Number.isSafeInteger(context.expiresAt)
    || (context.expiresAt as number) <= (context.issuedAt as number)
    || !validBuildIdentity(context.buildIdentity)
    || typeof context.hookDefinitionHash !== 'string' || !HEX_256.test(context.hookDefinitionHash)
    || typeof context.lifecycleProfilesHash !== 'string' || !HEX_256.test(context.lifecycleProfilesHash)
    || (context.profileProvenance !== undefined && !isLifecycleProfileProvenance(context.profileProvenance))) {
    throw new Error('CODEX_SANDBOX_CONTROLLER_CONTEXT_INVALID');
  }
  return context as unknown as CodexSandboxControllerContextV2;
}

export function contextFromControllerLease(
  lease: CodexControllerLeaseV1,
  hashes: Readonly<{
    hookDefinitionHash: string;
    lifecycleProfilesHash: string;
    profileProvenance?: LifecycleProfileProvenance;
  }>
): CodexSandboxControllerContextV2 {
  return Object.freeze({
    version: 2,
    taskId: lease.taskId,
    controlGeneration: lease.controlGeneration,
    controllerInstanceDigest: lease.controllerInstanceDigest,
    controllerProcess: lease.controllerProcess,
    controllerLease: Object.freeze({ version: 1, leaseId: lease.leaseId, leaseSecret: lease.leaseSecret }),
    issuedAt: lease.issuedAt,
    expiresAt: lease.expiresAt,
    buildIdentity: lease.buildIdentity,
    hookDefinitionHash: hashes.hookDefinitionHash,
    lifecycleProfilesHash: hashes.lifecycleProfilesHash,
    ...(hashes.profileProvenance ? { profileProvenance: hashes.profileProvenance } : {})
  });
}

export function writeCodexSandboxControllerContext(
  contextPath: string,
  context: CodexSandboxControllerContextV2
): void {
  validateContext(context);
  fs.mkdirSync(path.dirname(contextPath), { recursive: true, mode: 0o700 });
  const temporary = path.join(path.dirname(contextPath), `.${path.basename(contextPath)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(context, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    fs.chmodSync(temporary, 0o600);
    fs.renameSync(temporary, contextPath);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

export function verifyCodexSandboxControllerContextWithWarnings(
  contextPath: string,
  options: Readonly<{
    repoRoot?: string;
    now?: number;
    generation?: string;
    probeProcess?: (identity: ProcessIdentity) => 'alive' | 'dead' | 'unknown';
  }> = {}
): Readonly<{ context: CodexSandboxControllerContextV2; warnings: readonly (LifecycleIdentityWarning | LifecycleContextWarning)[] }> {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(contextPath);
  } catch {
    throw new Error('CODEX_SANDBOX_CONTROLLER_CONTEXT_INVALID');
  }
  if (!stat.isFile() || stat.isSymbolicLink()
    || (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)) {
    throw new Error('CODEX_SANDBOX_CONTROLLER_CONTEXT_INVALID');
  }
  let context: CodexSandboxControllerContextV2;
  try {
    context = validateContext(JSON.parse(fs.readFileSync(contextPath, 'utf8')));
  } catch {
    throw new Error('CODEX_SANDBOX_CONTROLLER_CONTEXT_INVALID');
  }
  const repoRoot = options.repoRoot ?? process.cwd();
  const generation = options.generation ?? process.env.AGENT_INFRA_CONTROL_GENERATION;
  const state = (options.probeProcess ?? getProcessIdentityState)(context.controllerProcess);
  if (context.controlGeneration !== generation
    || context.expiresAt <= (options.now ?? Date.now())
    || state !== 'alive') {
    throw new Error('CODEX_SANDBOX_CONTROLLER_CONTEXT_INVALID');
  }
  const warnings: Array<LifecycleIdentityWarning | LifecycleContextWarning> = [];
  const currentBuildIdentity = computeLifecycleBuildIdentity(repoRoot);
  const identity = verifyLifecycleBuildIdentity(context.buildIdentity, currentBuildIdentity);
  if (!identity.ok) throw new Error(`${identity.code}: ${identity.message}`);
  warnings.push(...identity.warnings);
  if (!context.profileProvenance) {
    warnings.push({
      code: 'CODEX_LIFECYCLE_PROFILE_PROVENANCE_LEGACY',
      message: 'Controller context has no per-profile provenance; rebuild the sandbox to capture a complete audit record',
      action: 'rebuild-sandbox'
    });
  }
  try {
    const hookHash = crypto.createHash('sha256')
      .update(fs.readFileSync(path.join(repoRoot, '.codex', 'hooks.json')))
      .digest('hex');
    if (hookHash !== context.hookDefinitionHash) {
      warnings.push({
        code: 'CODEX_LIFECYCLE_HOOK_DRIFT',
        message: 'Codex lifecycle hook definition differs; rebuild the sandbox if the runtime is stale',
        action: 'rebuild-sandbox'
      });
    }
    const profileHash = digestProfiles(repoRoot);
    if (profileHash !== context.lifecycleProfilesHash) {
      warnings.push({
        code: 'CODEX_LIFECYCLE_PROFILE_DRIFT',
        message: 'Codex lifecycle profile content differs; rebuild the sandbox if the runtime is stale',
        action: 'rebuild-sandbox'
      });
    }
    if (context.profileProvenance
      && (context.profileProvenance.executor.source !== 'isolated-user'
        || context.profileProvenance.reviewer.source !== 'isolated-user')) {
      const actual = computeLifecycleProfileProvenance(repoRoot, currentBuildIdentity.packageVersion);
      if (!profileProvenanceEqual(context.profileProvenance, actual)) {
        warnings.push({
          code: 'CODEX_LIFECYCLE_PROFILE_PROVENANCE_DRIFT',
          message: 'Codex lifecycle profile provenance differs from the current root; rebuild the sandbox if the runtime is stale',
          action: 'rebuild-sandbox'
        });
      }
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('CODEX_SANDBOX_CONTROLLER_')) throw error;
    warnings.push({
      code: 'CODEX_LIFECYCLE_PROFILE_DRIFT',
      message: 'Codex lifecycle profile provenance is unavailable; rebuild the sandbox if the runtime is stale',
      action: 'rebuild-sandbox'
    });
  }
  return Object.freeze({ context: Object.freeze(context), warnings: Object.freeze(warnings) });
}

export function verifyCodexSandboxControllerContext(
  contextPath: string,
  options: Readonly<{
    repoRoot?: string;
    now?: number;
    generation?: string;
    probeProcess?: (identity: ProcessIdentity) => 'alive' | 'dead' | 'unknown';
  }> = {}
): CodexSandboxControllerContextV2 {
  return verifyCodexSandboxControllerContextWithWarnings(contextPath, options).context;
}

export function controllerProofFromContext(context: CodexSandboxControllerContextV2): CodexControllerLeaseProofV1 {
  return Object.freeze({
    version: 1,
    leaseId: context.controllerLease.leaseId,
    leaseSecret: context.controllerLease.leaseSecret,
    controllerProcess: context.controllerProcess
  });
}
