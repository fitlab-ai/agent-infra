import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import type { LifecycleBuildIdentity } from '../../agent-clients/adapters/codex-lifecycle/build-identity.ts';
import type { ProcessIdentity } from '../../server/process-state.ts';
import type { CodexControllerRegistrationV1 } from './controller-registration.ts';
import { withRecoverableFileLock } from '../../task/recoverable-file-lock.ts';

export const CONTROLLER_AUTHORITY_STATE_FILE = 'controller-authority.json';

type ControllerAuthorityBase = Readonly<{
  version: 1;
  taskId: string;
  generation: string;
  controlRootId: string;
  revision: number;
  transitionId: string;
  updatedAt: number;
}>;

export type ControllerAuthorityInactive = ControllerAuthorityBase & Readonly<{
  state: 'inactive';
  registration: null;
}>;

export type ControllerAuthorityTransition = ControllerAuthorityBase & Readonly<{
  state: 'opening' | 'closing' | 'faulted';
  registration: null;
}>;

export type ControllerAuthorityActive = ControllerAuthorityBase & Readonly<{
  state: 'active';
  registration: Readonly<{
    containerId: string;
    leaseId: string;
    leaseSecretHash: string;
    controllerInstanceDigest: string;
    controllerProcess: ProcessIdentity;
    buildIdentity: LifecycleBuildIdentity;
    issuedAt: number;
    expiresAt: number;
  }>;
}>;

export type ControllerAuthorityState =
  | ControllerAuthorityInactive
  | ControllerAuthorityTransition
  | ControllerAuthorityActive;

const HEX_256 = /^[a-f0-9]{64}$/u;
const STATES = ['inactive', 'opening', 'active', 'closing', 'faulted'] as const;

function fail(code: string): never {
  throw new Error(code);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

function validProcess(value: unknown): value is ProcessIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return exactKeys(candidate, ['pid', 'startTime'])
    && Number.isSafeInteger(candidate.pid) && (candidate.pid as number) > 0
    && Number.isSafeInteger(candidate.startTime) && (candidate.startTime as number) >= 0;
}

function validBuild(value: unknown): value is LifecycleBuildIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return exactKeys(candidate, ['internalExecutableBuildHash', 'lifecycleContractHash', 'packageVersion', 'protocolVersion'])
    && candidate.protocolVersion === 3
    && typeof candidate.packageVersion === 'string' && candidate.packageVersion.length > 0
    && typeof candidate.internalExecutableBuildHash === 'string' && HEX_256.test(candidate.internalExecutableBuildHash)
    && typeof candidate.lifecycleContractHash === 'string' && HEX_256.test(candidate.lifecycleContractHash);
}

export function parseControllerAuthorityState(value: unknown): ControllerAuthorityState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('CONTROLLER_AUTHORITY_STATE_INVALID');
  const candidate = value as Record<string, unknown>;
  if (!exactKeys(candidate, [
    'controlRootId', 'generation', 'registration', 'revision', 'state', 'taskId',
    'transitionId', 'updatedAt', 'version'
  ])
    || candidate.version !== 1
    || typeof candidate.taskId !== 'string' || !candidate.taskId
    || typeof candidate.generation !== 'string' || !candidate.generation
    || typeof candidate.controlRootId !== 'string' || !/^[a-f0-9]{64,128}$/u.test(candidate.controlRootId)
    || !Number.isSafeInteger(candidate.revision) || (candidate.revision as number) < 1
    || typeof candidate.transitionId !== 'string' || !HEX_256.test(candidate.transitionId)
    || !Number.isSafeInteger(candidate.updatedAt)
    || !STATES.includes(candidate.state as typeof STATES[number])) {
    fail('CONTROLLER_AUTHORITY_STATE_INVALID');
  }
  if (candidate.state !== 'active') {
    if (candidate.registration !== null) fail('CONTROLLER_AUTHORITY_STATE_INVALID');
    return candidate as unknown as ControllerAuthorityInactive | ControllerAuthorityTransition;
  }
  if (!candidate.registration || typeof candidate.registration !== 'object' || Array.isArray(candidate.registration)) {
    fail('CONTROLLER_AUTHORITY_STATE_INVALID');
  }
  const registration = candidate.registration as Record<string, unknown>;
  if (!exactKeys(registration, [
    'buildIdentity', 'containerId', 'controllerInstanceDigest', 'controllerProcess',
    'expiresAt', 'issuedAt', 'leaseId', 'leaseSecretHash'
  ])
    || typeof registration.containerId !== 'string' || !registration.containerId
    || typeof registration.leaseId !== 'string' || !HEX_256.test(registration.leaseId)
    || typeof registration.leaseSecretHash !== 'string' || !HEX_256.test(registration.leaseSecretHash)
    || typeof registration.controllerInstanceDigest !== 'string' || !HEX_256.test(registration.controllerInstanceDigest)
    || !validProcess(registration.controllerProcess)
    || !validBuild(registration.buildIdentity)
    || !Number.isSafeInteger(registration.issuedAt)
    || !Number.isSafeInteger(registration.expiresAt)
    || (registration.expiresAt as number) <= (registration.issuedAt as number)) {
    fail('CONTROLLER_AUTHORITY_STATE_INVALID');
  }
  return candidate as unknown as ControllerAuthorityActive;
}

function statePath(publicStatusDir: string): string {
  return path.join(publicStatusDir, CONTROLLER_AUTHORITY_STATE_FILE);
}

export function createInactiveControllerAuthorityState(
  identity: Readonly<{ taskId: string; generation: string; controlRootId: string }>,
  now = Date.now()
): ControllerAuthorityInactive {
  return parseControllerAuthorityState({
    version: 1,
    ...identity,
    revision: 1,
    transitionId: crypto.randomBytes(32).toString('hex'),
    updatedAt: now,
    state: 'inactive',
    registration: null
  }) as ControllerAuthorityInactive;
}

export function readControllerAuthorityState(publicStatusDir: string): ControllerAuthorityState {
  const file = statePath(publicStatusDir);
  let stat: fs.Stats;
  try { stat = fs.lstatSync(file); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') fail('CONTROLLER_AUTHORITY_STATE_MISSING');
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) fail('CONTROLLER_AUTHORITY_STATE_INVALID');
  try { return parseControllerAuthorityState(JSON.parse(fs.readFileSync(file, 'utf8'))); }
  catch (error) {
    if (error instanceof Error && error.message.startsWith('CONTROLLER_AUTHORITY_STATE_')) throw error;
    return fail('CONTROLLER_AUTHORITY_STATE_INVALID');
  }
}

export function writeControllerAuthorityState(
  publicStatusDir: string,
  state: ControllerAuthorityState,
  options: Readonly<{ expected: ControllerAuthorityState | null }>
): ControllerAuthorityState {
  const validated = parseControllerAuthorityState(state);
  fs.mkdirSync(publicStatusDir, { recursive: true, mode: 0o700 });
  const file = statePath(publicStatusDir);
  const lock = `${file}.lock`;
  return withRecoverableFileLock(lock, 'CONTROLLER_AUTHORITY_STATE_CONFLICT', () => {
    let current: ControllerAuthorityState | null = null;
    if (fs.existsSync(file)) current = readControllerAuthorityState(publicStatusDir);
    if (!isDeepStrictEqual(current, options.expected)) fail('CONTROLLER_AUTHORITY_STATE_CONFLICT');
    const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, `${JSON.stringify(validated)}\n`, { mode: 0o400, flag: 'wx' });
      fs.chmodSync(temporary, 0o400);
      fs.renameSync(temporary, file);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
    return validated;
  });
}

export function transitionControllerAuthorityState(
  publicStatusDir: string,
  current: ControllerAuthorityState,
  input: Readonly<{
    state: Exclude<ControllerAuthorityState['state'], 'active'>;
    transitionId: string;
    now?: number;
  }>
): ControllerAuthorityState {
  const next = parseControllerAuthorityState({
    ...current,
    state: input.state,
    registration: null,
    revision: current.revision + 1,
    transitionId: input.transitionId,
    updatedAt: input.now ?? Date.now()
  });
  return writeControllerAuthorityState(publicStatusDir, next, { expected: current });
}

export function activeControllerAuthorityState(
  current: ControllerAuthorityState,
  registration: CodexControllerRegistrationV1,
  transitionId: string,
  now = Date.now()
): ControllerAuthorityActive {
  return parseControllerAuthorityState({
    ...current,
    state: 'active',
    revision: current.revision + 1,
    transitionId,
    updatedAt: now,
    registration: {
      containerId: registration.containerId,
      leaseId: registration.leaseId,
      leaseSecretHash: registration.leaseSecretHash,
      controllerInstanceDigest: registration.controllerInstanceDigest,
      controllerProcess: registration.controllerProcess,
      buildIdentity: registration.buildIdentity,
      issuedAt: registration.issuedAt,
      expiresAt: registration.expiresAt
    }
  }) as ControllerAuthorityActive;
}
