import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  verifyLifecycleBuildIdentity,
  type LifecycleBuildIdentity,
  type LifecycleIdentityWarning
} from '../../agent-clients/adapters/codex-lifecycle/build-identity.ts';
import { parseLinuxProcessStat, type ProcessIdentity, type ProcessIdentityState } from '../../server/process-state.ts';
import { commandForEngine, runProbe } from '../shell.ts';
import type { SandboxControlManifest } from './protocol.ts';

const CONTROLLER_TTL_MS = 4 * 60 * 60 * 1_000;
const HEX_256 = /^[a-f0-9]{64}$/u;
const REGISTRATION_KEYS = [
  'buildIdentity', 'containerId', 'controlGeneration', 'controllerInstanceDigest',
  'controllerProcess', 'expiresAt', 'issuedAt', 'leaseId', 'leaseSecretHash',
  'taskId', 'version'
].sort().join(',');

export type CodexControllerLeaseProofV1 = Readonly<{
  version: 1;
  leaseId: string;
  leaseSecret: string;
  controllerProcess: ProcessIdentity;
}>;

export type CodexControllerRegistrationV1 = Readonly<{
  version: 1;
  taskId: string;
  controlGeneration: string;
  containerId: string;
  leaseId: string;
  leaseSecretHash: string;
  controllerInstanceDigest: string;
  controllerProcess: ProcessIdentity;
  buildIdentity: LifecycleBuildIdentity;
  issuedAt: number;
  expiresAt: number;
}>;

export type CodexControllerLeaseV1 = Readonly<{
  version: 1;
  leaseId: string;
  leaseSecret: string;
  taskId: string;
  controlGeneration: string;
  controllerInstanceDigest: string;
  controllerProcess: ProcessIdentity;
  buildIdentity: LifecycleBuildIdentity;
  issuedAt: number;
  expiresAt: number;
}>;

export type CodexControllerOpened = Readonly<{
  version: 1;
  status: 'opened';
  changed: true;
  lease: CodexControllerLeaseV1;
  error: null;
  warnings?: readonly LifecycleIdentityWarning[];
}>;

type RegistrationOptions = Readonly<{
  now?: () => number;
  probeProcess?: (identity: ProcessIdentity) => ProcessIdentityState;
  randomHex?: () => string;
  beforeCommit?: () => void;
}>;

export class CodexControllerRegistrationError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = code;
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new CodexControllerRegistrationError(code, message);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

function validProcess(value: unknown): value is ProcessIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const processValue = value as Record<string, unknown>;
  return exactKeys(processValue, ['pid', 'startTime'])
    && Number.isSafeInteger(processValue.pid) && (processValue.pid as number) > 0
    && Number.isSafeInteger(processValue.startTime) && (processValue.startTime as number) >= 0;
}

function validBuild(value: unknown): value is LifecycleBuildIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const build = value as Record<string, unknown>;
  return exactKeys(build, [
    'internalExecutableBuildHash', 'lifecycleContractHash', 'packageVersion', 'protocolVersion'
  ])
    && build.protocolVersion === 3
    && typeof build.packageVersion === 'string' && build.packageVersion.length > 0
    && typeof build.internalExecutableBuildHash === 'string' && HEX_256.test(build.internalExecutableBuildHash)
    && typeof build.lifecycleContractHash === 'string' && HEX_256.test(build.lifecycleContractHash);
}

function parseRegistration(raw: string): CodexControllerRegistrationV1 {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    fail('CODEX_SANDBOX_CONTROLLER_REGISTRATION_INVALID', 'controller registration is malformed');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('CODEX_SANDBOX_CONTROLLER_REGISTRATION_INVALID', 'controller registration is invalid');
  }
  const registration = value as Record<string, unknown>;
  if (Object.keys(registration).sort().join(',') !== REGISTRATION_KEYS
    || registration.version !== 1
    || typeof registration.taskId !== 'string'
    || typeof registration.controlGeneration !== 'string'
    || typeof registration.containerId !== 'string'
    || typeof registration.leaseId !== 'string' || !HEX_256.test(registration.leaseId)
    || typeof registration.leaseSecretHash !== 'string' || !HEX_256.test(registration.leaseSecretHash)
    || typeof registration.controllerInstanceDigest !== 'string' || !HEX_256.test(registration.controllerInstanceDigest)
    || !validProcess(registration.controllerProcess)
    || !validBuild(registration.buildIdentity)
    || !Number.isSafeInteger(registration.issuedAt)
    || !Number.isSafeInteger(registration.expiresAt)
    || (registration.expiresAt as number) <= (registration.issuedAt as number)) {
    fail('CODEX_SANDBOX_CONTROLLER_REGISTRATION_INVALID', 'controller registration schema is invalid');
  }
  return registration as CodexControllerRegistrationV1;
}

function registrationPath(manifestPath: string): string {
  return path.join(path.dirname(path.resolve(manifestPath)), 'codex-controller.json');
}

function readRaw(file: string): { raw: string; stat: fs.Stats } | null {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()
      || (process.platform !== 'win32' && (stat.mode & 0o777) !== 0o600)) {
      fail('CODEX_SANDBOX_CONTROLLER_REGISTRATION_INVALID', 'controller registration file is unsafe');
    }
    return { raw: fs.readFileSync(file, 'utf8'), stat };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function sameFile(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode
    && left.size === right.size && left.mtimeMs === right.mtimeMs;
}

function secretHash(secret: string): string {
  return crypto.createHash('sha256')
    .update('agent-infra/codex-controller-lease/v1\0')
    .update(secret)
    .digest('hex');
}

function safeEqual(left: string, right: string): boolean {
  if (!HEX_256.test(left) || !HEX_256.test(right)) return false;
  return crypto.timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function defaultProbe(manifest: SandboxControlManifest, identity: ProcessIdentity): ProcessIdentityState {
  const command = commandForEngine(manifest.engine, 'docker', [
    'exec', manifest.containerIdentity.id, 'cat', `/proc/${identity.pid}/stat`
  ]);
  const result = runProbe(command.cmd, command.args, { timeout: 2_000 });
  if (result.status !== 0) {
    const stderr = typeof result.stderr === 'string' ? result.stderr : result.stderr?.toString('utf8') ?? '';
    return /no such (?:file|container)|not found|does not exist/iu.test(stderr) ? 'dead' : 'unknown';
  }
  const stdout = typeof result.stdout === 'string' ? result.stdout : result.stdout?.toString('utf8') ?? '';
  const stat = parseLinuxProcessStat(stdout);
  if (!stat) return 'unknown';
  if (stat.state === 'Z' || stat.startTime !== identity.startTime) return 'dead';
  return 'alive';
}

function assertRegistrationBinding(
  registration: CodexControllerRegistrationV1,
  manifest: SandboxControlManifest,
  buildIdentity: LifecycleBuildIdentity
): readonly LifecycleIdentityWarning[] {
  if (registration.taskId !== manifest.taskId
    || registration.controlGeneration !== manifest.generation
    || registration.containerId !== manifest.containerIdentity.id) {
    fail('CODEX_SANDBOX_CONTROLLER_REGISTRATION_INVALID', 'controller registration binding is invalid');
  }
  const identity = verifyLifecycleBuildIdentity(registration.buildIdentity, buildIdentity);
  if (!identity.ok) fail(identity.code!, identity.message!);
  return identity.warnings;
}

function atomicWrite(file: string, value: CodexControllerRegistrationV1): void {
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: 'wx' });
    fs.chmodSync(temporary, 0o600);
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

export function readCodexControllerRegistration(manifestPath: string): CodexControllerRegistrationV1 {
  const existing = readRaw(registrationPath(manifestPath));
  if (!existing) fail('CODEX_SANDBOX_CONTROLLER_REGISTRATION_MISSING', 'controller registration is missing');
  return parseRegistration(existing.raw);
}

export function openCodexControllerRegistration(params: Readonly<{
  manifest: SandboxControlManifest;
  manifestPath: string;
  controllerProcess: ProcessIdentity;
  buildIdentity: LifecycleBuildIdentity;
}>, options: RegistrationOptions = {}): CodexControllerOpened {
  if (params.manifest.mode !== 'task-bound' || !params.manifest.taskId) {
    fail('SANDBOX_CONTROL_BRANCH_ONLY', 'branch-only sandboxes cannot register a Codex controller');
  }
  if (!validProcess(params.controllerProcess)) {
    fail('CODEX_SANDBOX_CONTROLLER_PROCESS_INACTIVE', 'requested controller process is invalid');
  }
  const file = registrationPath(params.manifestPath);
  const now = (options.now ?? Date.now)();
  const initial = readRaw(file);
  let warnings: readonly LifecycleIdentityWarning[] = [];
  if (initial) {
    const existing = parseRegistration(initial.raw);
    warnings = assertRegistrationBinding(existing, params.manifest, params.buildIdentity);
    if (existing.expiresAt > now) {
      const oldState = (options.probeProcess ?? ((identity) => defaultProbe(params.manifest, identity)))(existing.controllerProcess);
      if (oldState === 'alive') fail('CODEX_SANDBOX_CONTROLLER_BUSY', 'an active controller registration already exists');
      if (oldState === 'unknown') fail('CODEX_SANDBOX_CONTROLLER_PROCESS_UNKNOWN', 'existing controller process state is unknown');
    }
  }
  const requestedState = (options.probeProcess ?? ((identity) => defaultProbe(params.manifest, identity)))(params.controllerProcess);
  if (requestedState === 'dead') fail('CODEX_SANDBOX_CONTROLLER_PROCESS_INACTIVE', 'requested controller process is not alive');
  if (requestedState === 'unknown') fail('CODEX_SANDBOX_CONTROLLER_PROCESS_UNKNOWN', 'requested controller process state is unknown');

  const randomHex = options.randomHex ?? (() => crypto.randomBytes(32).toString('hex'));
  const leaseId = randomHex();
  const leaseSecret = randomHex();
  const controllerInstanceDigest = randomHex();
  if (![leaseId, leaseSecret, controllerInstanceDigest].every((value) => HEX_256.test(value))) {
    fail('CODEX_SANDBOX_CONTROLLER_CREDENTIAL_INVALID', 'generated controller credential is invalid');
  }
  const registration: CodexControllerRegistrationV1 = Object.freeze({
    version: 1,
    taskId: params.manifest.taskId!,
    controlGeneration: params.manifest.generation,
    containerId: params.manifest.containerIdentity.id,
    leaseId,
    leaseSecretHash: secretHash(leaseSecret),
    controllerInstanceDigest,
    controllerProcess: params.controllerProcess,
    buildIdentity: params.buildIdentity,
    issuedAt: now,
    expiresAt: now + CONTROLLER_TTL_MS
  });
  options.beforeCommit?.();
  const current = readRaw(file);
  if ((!initial && current)
    || (initial && (!current || current.raw !== initial.raw || !sameFile(current.stat, initial.stat)))) {
    fail('CODEX_SANDBOX_CONTROLLER_OWNERSHIP_LOST', 'controller registration changed before commit');
  }
  atomicWrite(file, registration);
  return Object.freeze({
    version: 1,
    status: 'opened',
    changed: true,
    lease: Object.freeze({
      version: 1,
      leaseId,
      leaseSecret,
      taskId: registration.taskId,
      controlGeneration: registration.controlGeneration,
      controllerInstanceDigest,
      controllerProcess: registration.controllerProcess,
      buildIdentity: registration.buildIdentity,
      issuedAt: registration.issuedAt,
      expiresAt: registration.expiresAt
    }),
    error: null,
    ...(warnings.length > 0 ? { warnings } : {})
  });
}

export function closeCodexControllerRegistration(params: Readonly<{
  manifest: SandboxControlManifest;
  manifestPath: string;
  proof: CodexControllerLeaseProofV1;
}>): Readonly<{ version: 1; status: 'closed'; changed: boolean; lease: null; error: null }> {
  if (params.manifest.mode !== 'task-bound' || !params.manifest.taskId) {
    fail('SANDBOX_CONTROL_BRANCH_ONLY', 'branch-only sandboxes cannot close a Codex controller registration');
  }
  const file = registrationPath(params.manifestPath);
  const existingRaw = readRaw(file);
  if (!existingRaw) return Object.freeze({ version: 1, status: 'closed', changed: false, lease: null, error: null });
  const existing = parseRegistration(existingRaw.raw);
  if (existing.taskId !== params.manifest.taskId
    || existing.controlGeneration !== params.manifest.generation
    || existing.containerId !== params.manifest.containerIdentity.id
    || params.proof.version !== 1
    || existing.leaseId !== params.proof.leaseId
    || !safeEqual(existing.leaseSecretHash, secretHash(params.proof.leaseSecret))
    || JSON.stringify(existing.controllerProcess) !== JSON.stringify(params.proof.controllerProcess)) {
    fail('CODEX_SANDBOX_CONTROLLER_PROOF_INVALID', 'controller close proof is invalid');
  }
  const current = readRaw(file);
  if (!current || current.raw !== existingRaw.raw || !sameFile(current.stat, existingRaw.stat)) {
    fail('CODEX_SANDBOX_CONTROLLER_OWNERSHIP_LOST', 'controller registration changed before close');
  }
  fs.unlinkSync(file);
  return Object.freeze({ version: 1, status: 'closed', changed: true, lease: null, error: null });
}

export function resolveCodexControllerBinding(params: Readonly<{
  manifest: SandboxControlManifest;
  manifestPath: string;
  proof: CodexControllerLeaseProofV1;
  buildIdentity: LifecycleBuildIdentity;
  now?: number;
  probeProcess?: (identity: ProcessIdentity) => ProcessIdentityState;
}>): Readonly<{
  instanceDigest: string;
  controlGeneration: string;
  warnings?: readonly LifecycleIdentityWarning[];
}> {
  if (params.manifest.mode !== 'task-bound' || !params.manifest.taskId) {
    fail('SANDBOX_CONTROL_BRANCH_ONLY', 'branch-only sandboxes cannot resolve a Codex controller registration');
  }
  const registration = readCodexControllerRegistration(params.manifestPath);
  const warnings = assertRegistrationBinding(registration, params.manifest, params.buildIdentity);
  if (registration.expiresAt <= (params.now ?? Date.now())) {
    fail('CODEX_SANDBOX_CONTROLLER_LEASE_EXPIRED', 'controller lease is expired');
  }
  if (params.proof.version !== 1
    || registration.leaseId !== params.proof.leaseId
    || !safeEqual(registration.leaseSecretHash, secretHash(params.proof.leaseSecret))
    || JSON.stringify(registration.controllerProcess) !== JSON.stringify(params.proof.controllerProcess)) {
    fail('CODEX_SANDBOX_CONTROLLER_PROOF_INVALID', 'controller proof is invalid');
  }
  const state = (params.probeProcess ?? ((identity) => defaultProbe(params.manifest, identity)))(registration.controllerProcess);
  if (state === 'dead') fail('CODEX_SANDBOX_CONTROLLER_PROCESS_INACTIVE', 'controller process is not alive');
  if (state === 'unknown') fail('CODEX_SANDBOX_CONTROLLER_PROCESS_UNKNOWN', 'controller process state is unknown');
  return Object.freeze({
    instanceDigest: registration.controllerInstanceDigest,
    controlGeneration: registration.controlGeneration,
    ...(warnings.length > 0 ? { warnings: Object.freeze([...warnings]) } : {})
  });
}
