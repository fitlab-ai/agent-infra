import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { getProcessIdentityState, type ProcessIdentity } from '../../../server/process-state.ts';
import type { CodexControllerLeaseProofV1, CodexControllerLeaseV1 } from '../../../sandbox/control/controller-registration.ts';
import { computeLifecycleBuildIdentity, type LifecycleBuildIdentity } from './build-identity.ts';

const HEX_256 = /^[a-f0-9]{64}$/u;

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
}>;

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

function digestProfiles(repoRoot: string): string {
  const files = [
    path.join(repoRoot, '.codex', 'agents', 'agent-infra-lifecycle-executor.toml'),
    path.join(repoRoot, '.codex', 'agents', 'agent-infra-lifecycle-reviewer.toml')
  ];
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
  if (!exactKeys(context, [
    'buildIdentity', 'controlGeneration', 'controllerInstanceDigest', 'controllerLease',
    'controllerProcess', 'expiresAt', 'hookDefinitionHash', 'issuedAt',
    'lifecycleProfilesHash', 'taskId', 'version'
  ])
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
    || typeof context.lifecycleProfilesHash !== 'string' || !HEX_256.test(context.lifecycleProfilesHash)) {
    throw new Error('CODEX_SANDBOX_CONTROLLER_CONTEXT_INVALID');
  }
  return context as unknown as CodexSandboxControllerContextV2;
}

export function contextFromControllerLease(
  lease: CodexControllerLeaseV1,
  hashes: Readonly<{ hookDefinitionHash: string; lifecycleProfilesHash: string }>
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
    lifecycleProfilesHash: hashes.lifecycleProfilesHash
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

export function verifyCodexSandboxControllerContext(
  contextPath: string,
  taskId: string,
  options: Readonly<{
    repoRoot?: string;
    now?: number;
    generation?: string;
    probeProcess?: (identity: ProcessIdentity) => 'alive' | 'dead' | 'unknown';
  }> = {}
): CodexSandboxControllerContextV2 {
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
  if (context.taskId !== taskId
    || context.controlGeneration !== generation
    || context.expiresAt <= (options.now ?? Date.now())
    || state !== 'alive') {
    throw new Error('CODEX_SANDBOX_CONTROLLER_CONTEXT_INVALID');
  }
  if (JSON.stringify(computeLifecycleBuildIdentity(repoRoot)) !== JSON.stringify(context.buildIdentity)
    || crypto.createHash('sha256').update(fs.readFileSync(path.join(repoRoot, '.codex', 'hooks.json'))).digest('hex') !== context.hookDefinitionHash
    || digestProfiles(repoRoot) !== context.lifecycleProfilesHash) {
    throw new Error('CODEX_SANDBOX_CONTROLLER_BUNDLE_MISMATCH');
  }
  return Object.freeze(context);
}

export function controllerProofFromContext(context: CodexSandboxControllerContextV2): CodexControllerLeaseProofV1 {
  return Object.freeze({
    version: 1,
    leaseId: context.controllerLease.leaseId,
    leaseSecret: context.controllerLease.leaseSecret,
    controllerProcess: context.controllerProcess
  });
}
