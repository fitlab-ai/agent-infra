import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { buildProcessTreeStopCommand } from '../../server/process-control.ts';
import {
  getProcessIdentityState,
  getProcessStartTime
} from '../../server/process-state.ts';
import type { ProcessIdentity, ProcessIdentityProbe, ProcessIdentityState } from '../../server/process-state.ts';
import type {
  SandboxControlExecution,
  SandboxControlManifest,
  SandboxControlStatus,
  SandboxControlTimingPolicy
} from './protocol.ts';
import { DEFAULT_SANDBOX_CONTROL_TIMING } from './protocol.ts';
import { inspectSandboxControlContainer, type ContainerObservation } from './container-identity.ts';
import {
  acquireSandboxResourceLock,
  resolveSandboxLockNamespace,
  type SandboxResourceLock
} from './native-file-lock.ts';
import { isSandboxAuthorityEvidence } from '../engines/authority.ts';
import {
  parseSandboxControlStatus,
  readExecution,
  terminateSandboxControlExecution
} from './state.ts';

type OwnerIdentity = ProcessIdentity & Readonly<{ brokerId?: string }>;
export type BrokerOwner = ProcessIdentity & Readonly<{ version: 3; brokerId: string; token: string; generation: string }>;

const DEFAULT_QUIESCE_TIMEOUT_MS = DEFAULT_SANDBOX_CONTROL_TIMING.quiesceDeadlineMs;
const QUIESCING_FILE = 'quiescing.json';
const BROKER_STARTING_FILE = 'broker-starting.json';
const REPLACEMENT_FILE = 'replacement.json';
const REPLACEMENT_STATE_SUFFIX = '.replacement-state.json';
const REMOVAL_JOURNAL_ROOT = path.join('.agent-infra', 'sandbox-removal-journal');

export const SANDBOX_REMOVAL_JOURNAL_PHASES = [
  'prepared', 'target-committed', 'container-removal', 'container-absent',
  'carrier-finalizing', 'carrier-removed', 'workspace-finalizing', 'workspace-removed',
  'branch-finalizing', 'branch-removed', 'tool-finalizing', 'tool-removed',
  'shell-finalizing', 'shell-removed', 'share-finalizing', 'share-removed', 'completed'
] as const;
export type SandboxRemovalJournalPhase = typeof SANDBOX_REMOVAL_JOURNAL_PHASES[number];
export type SandboxRemovalTargetCommit = Readonly<{
  branch: string;
  project: string;
  controlRoot: string;
  targetDigest: string;
  permitDigest: string;
  removeWorktree: boolean;
  removeBranch: boolean;
  removeShare: boolean;
  worktreePaths: readonly string[];
  workspaceViewPaths: readonly string[];
  toolPaths: readonly string[];
  shellPaths: readonly string[];
  sharePath: string;
  permits: readonly Readonly<{
    path: string;
    mode: 'clean' | 'discard';
    snapshot: Readonly<{
      worktree: string;
      branch: string;
      head: string;
      changes: readonly Readonly<{
        indexStatus: string;
        worktreeStatus: string;
        path: string;
        originalPath?: string;
      }>[];
      identity: string;
      source?: 'registered' | 'recovered';
      recovery?: Readonly<{
        repoRoot: string;
        worktreeBase: string;
        branch: string;
        identitySource: 'branch-only' | 'task-bound';
        taskId: string | null;
      }>;
    }>;
  }>[];
}>;
export type SandboxRemovalJournal = Readonly<{
  version: 2;
  operation: 'sandbox-rm';
  oldOperation: 'sandbox-rm';
  newOperation: 'sandbox-rm';
  handoffId: string;
  transitionId: string;
  engine: string;
  containerId: string;
  generation: string;
  authorityFingerprint: string;
  carrierIdentityDigest: string;
  lockDomain: string;
  owner: ProcessIdentity & Readonly<{ leaseNonce: string }>;
  phase: SandboxRemovalJournalPhase;
  expectedOldJournalRevision: number | null;
  revision: number;
  target: SandboxRemovalTargetCommit;
  recordedAt: number;
}>;

function removalCarrierDigest(engine: string, containerId: string, generation: string): string {
  return createHash('sha256').update(`${engine}\0${containerId}\0${generation}`).digest('hex');
}

function assertPrivateDirectory(directory: string): void {
  const home = path.resolve(os.homedir());
  const resolved = path.resolve(directory);
  const relative = path.relative(home, resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('SANDBOX_CONTROL_REMOVAL_JOURNAL_INVALID');
  }
  let current = home;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error('SANDBOX_CONTROL_REMOVAL_JOURNAL_INVALID');
    }
    if (process.platform !== 'win32' && typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
      throw new Error('SANDBOX_CONTROL_REMOVAL_JOURNAL_INVALID');
    }
  }
}

function removalJournalDomain(lockDomain: string, create = true): string {
  const namespace = resolveSandboxLockNamespace('sandbox-removal-journal', { lockDomain });
  const root = path.join(path.dirname(namespace.lockRoot), REMOVAL_JOURNAL_ROOT.split(path.sep).at(-1)!);
  if (create) fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  assertPrivateDirectory(root);
  const domain = path.join(root, lockDomain);
  if (create) fs.mkdirSync(domain, { recursive: true, mode: 0o700 });
  assertPrivateDirectory(domain);
  return domain;
}

function removalJournalPath(manifest: SandboxControlManifest): string {
  return path.join(
    removalJournalDomain(manifest.authorityEvidence.lockDomain),
    `${removalCarrierDigest(manifest.engine, manifest.containerIdentity.id, manifest.generation)}.json`
  );
}

function removalJournalPathForRecord(record: SandboxRemovalJournal): string {
  return path.join(
    removalJournalDomain(record.lockDomain, false),
    `${record.carrierIdentityDigest}.json`
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

function isRemovalPermitCommit(value: unknown): boolean {
  if (!isRecord(value) || typeof value.path !== 'string' || !path.isAbsolute(value.path)
    || (value.mode !== 'clean' && value.mode !== 'discard') || !isRecord(value.snapshot)
    || typeof value.snapshot.worktree !== 'string' || !path.isAbsolute(value.snapshot.worktree)
    || typeof value.snapshot.branch !== 'string' || typeof value.snapshot.head !== 'string'
    || typeof value.snapshot.identity !== 'string' || !Array.isArray(value.snapshot.changes)
    || value.snapshot.changes.some((change) => !isRecord(change)
      || typeof change.indexStatus !== 'string' || typeof change.worktreeStatus !== 'string'
      || typeof change.path !== 'string'
      || (change.originalPath !== undefined && typeof change.originalPath !== 'string'))
    || (value.snapshot.source !== undefined
      && value.snapshot.source !== 'registered' && value.snapshot.source !== 'recovered')) return false;
  if (value.snapshot.recovery === undefined) return true;
  const recovery = value.snapshot.recovery;
  return isRecord(recovery)
    && typeof recovery.repoRoot === 'string' && path.isAbsolute(recovery.repoRoot)
    && typeof recovery.worktreeBase === 'string' && path.isAbsolute(recovery.worktreeBase)
    && typeof recovery.branch === 'string'
    && (recovery.identitySource === 'branch-only' || recovery.identitySource === 'task-bound')
    && (recovery.taskId === null || typeof recovery.taskId === 'string');
}

function parseRemovalJournal(raw: string): SandboxRemovalJournal {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('SANDBOX_CONTROL_REMOVAL_JOURNAL_INVALID');
  }
  if (!isRecord(value) || !hasExactKeys(value, [
    'authorityFingerprint', 'carrierIdentityDigest', 'containerId', 'engine', 'expectedOldJournalRevision',
    'generation', 'handoffId', 'lockDomain', 'newOperation', 'oldOperation', 'operation', 'owner', 'phase',
    'recordedAt', 'revision', 'target', 'transitionId', 'version'
  ]) || !isRecord(value.owner) || !hasExactKeys(value.owner, ['leaseNonce', 'pid', 'startTime'])
    || !isRecord(value.target) || !hasExactKeys(value.target, [
      'branch', 'controlRoot', 'permitDigest', 'permits', 'project', 'removeBranch', 'removeShare',
      'removeWorktree', 'sharePath', 'shellPaths', 'targetDigest', 'toolPaths', 'workspaceViewPaths',
      'worktreePaths'
    ]) || value.version !== 2 || value.operation !== 'sandbox-rm'
    || value.oldOperation !== 'sandbox-rm' || value.newOperation !== 'sandbox-rm'
    || typeof value.handoffId !== 'string' || value.handoffId.length === 0
    || typeof value.transitionId !== 'string' || value.transitionId.length === 0
    || typeof value.engine !== 'string' || value.engine.length === 0
    || typeof value.containerId !== 'string' || value.containerId.length === 0
    || typeof value.generation !== 'string' || value.generation.length === 0
    || typeof value.authorityFingerprint !== 'string' || !/^[a-f0-9]{64}$/u.test(value.authorityFingerprint)
    || typeof value.carrierIdentityDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(value.carrierIdentityDigest)
    || typeof value.lockDomain !== 'string' || !/^[a-f0-9]{64}$/u.test(value.lockDomain)
    || !Number.isSafeInteger(value.owner.pid) || (value.owner.pid as number) <= 0
    || !Number.isSafeInteger(value.owner.startTime) || typeof value.owner.leaseNonce !== 'string'
    || value.owner.leaseNonce.length === 0
    || !SANDBOX_REMOVAL_JOURNAL_PHASES.includes(value.phase as SandboxRemovalJournalPhase)
    || !(value.expectedOldJournalRevision === null
      || (Number.isSafeInteger(value.expectedOldJournalRevision) && (value.expectedOldJournalRevision as number) >= 0))
    || !Number.isSafeInteger(value.revision) || (value.revision as number) <= 0
    || typeof value.target.branch !== 'string' || value.target.branch.length === 0
    || typeof value.target.project !== 'string' || value.target.project.length === 0
    || typeof value.target.controlRoot !== 'string' || path.isAbsolute(value.target.controlRoot) === false
    || typeof value.target.targetDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(value.target.targetDigest)
    || typeof value.target.permitDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(value.target.permitDigest)
    || typeof value.target.removeWorktree !== 'boolean'
    || typeof value.target.removeBranch !== 'boolean'
    || typeof value.target.removeShare !== 'boolean'
    || typeof value.target.sharePath !== 'string' || !path.isAbsolute(value.target.sharePath)
    || !Array.isArray(value.target.worktreePaths) || value.target.worktreePaths.some((entry) => typeof entry !== 'string' || !path.isAbsolute(entry))
    || !Array.isArray(value.target.workspaceViewPaths) || value.target.workspaceViewPaths.some((entry) => typeof entry !== 'string' || !path.isAbsolute(entry))
    || !Array.isArray(value.target.toolPaths) || value.target.toolPaths.some((entry) => typeof entry !== 'string' || !path.isAbsolute(entry))
    || !Array.isArray(value.target.shellPaths) || value.target.shellPaths.some((entry) => typeof entry !== 'string' || !path.isAbsolute(entry))
    || !Array.isArray(value.target.permits)
    || value.target.permits.some((permit) => !isRemovalPermitCommit(permit))
    || !Number.isSafeInteger(value.recordedAt)) {
    throw new Error('SANDBOX_CONTROL_REMOVAL_JOURNAL_INVALID');
  }
  const expected = value.expectedOldJournalRevision as number | null;
  const revision = value.revision as number;
  if ((expected === null && revision !== 1) || (expected !== null && revision !== expected + 1)) {
    throw new Error('SANDBOX_CONTROL_REMOVAL_JOURNAL_INVALID');
  }
  return {
    version: 2,
    operation: 'sandbox-rm',
    oldOperation: 'sandbox-rm',
    newOperation: 'sandbox-rm',
    handoffId: value.handoffId as string,
    transitionId: value.transitionId as string,
    engine: value.engine as string,
    containerId: value.containerId as string,
    generation: value.generation as string,
    authorityFingerprint: value.authorityFingerprint as string,
    carrierIdentityDigest: value.carrierIdentityDigest as string,
    lockDomain: value.lockDomain as string,
    owner: {
      pid: value.owner.pid as number,
      startTime: value.owner.startTime as number,
      leaseNonce: value.owner.leaseNonce as string
    },
    phase: value.phase as SandboxRemovalJournalPhase,
    expectedOldJournalRevision: expected,
    revision,
    target: {
      branch: value.target.branch as string,
      project: value.target.project as string,
      controlRoot: value.target.controlRoot as string,
      targetDigest: value.target.targetDigest as string,
      permitDigest: value.target.permitDigest as string,
      removeWorktree: value.target.removeWorktree as boolean,
      removeBranch: value.target.removeBranch as boolean,
      removeShare: value.target.removeShare as boolean,
      worktreePaths: value.target.worktreePaths as string[],
      workspaceViewPaths: value.target.workspaceViewPaths as string[],
      toolPaths: value.target.toolPaths as string[],
      shellPaths: value.target.shellPaths as string[],
      sharePath: value.target.sharePath as string,
      permits: value.target.permits as SandboxRemovalTargetCommit['permits']
    },
    recordedAt: value.recordedAt as number
  };
}

function readRemovalJournalAt(target: string): SandboxRemovalJournal | null {
  if (!fs.existsSync(target)) return null;
  const stat = fs.lstatSync(target);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('SANDBOX_CONTROL_REMOVAL_JOURNAL_INVALID');
  return parseRemovalJournal(fs.readFileSync(target, 'utf8'));
}

export function readSandboxRemovalJournal(manifest: SandboxControlManifest): SandboxRemovalJournal | null {
  return readRemovalJournalAt(removalJournalPath(manifest));
}

export function listSandboxRemovalJournals(
  filter: Readonly<{ branch?: string; project?: string; targetDigest?: string }> = {}
): SandboxRemovalJournal[] {
  const namespace = resolveSandboxLockNamespace('sandbox-removal-journal');
  const root = path.join(path.dirname(namespace.lockRoot), REMOVAL_JOURNAL_ROOT.split(path.sep).at(-1)!);
  if (!fs.existsSync(root)) return [];
  assertPrivateDirectory(root);
  const journals: SandboxRemovalJournal[] = [];
  for (const domainEntry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!domainEntry.isDirectory() || domainEntry.isSymbolicLink()) {
      throw new Error('SANDBOX_CONTROL_REMOVAL_JOURNAL_INVALID');
    }
    const domain = path.join(root, domainEntry.name);
    assertPrivateDirectory(domain);
    for (const entry of fs.readdirSync(domain, { withFileTypes: true })) {
      if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith('.json')) {
        throw new Error('SANDBOX_CONTROL_REMOVAL_JOURNAL_INVALID');
      }
      const record = readRemovalJournalAt(path.join(domain, entry.name));
      if (!record || record.lockDomain !== domainEntry.name
        || `${record.carrierIdentityDigest}.json` !== entry.name) {
        throw new Error('SANDBOX_CONTROL_REMOVAL_JOURNAL_INVALID');
      }
      if ((!filter.branch || record.target.branch === filter.branch)
        && (!filter.project || record.target.project === filter.project)
        && (!filter.targetDigest || record.target.targetDigest === filter.targetDigest)) {
        journals.push(record);
      }
    }
  }
  return journals;
}

export function clearSandboxRemovalJournalRecord(record: SandboxRemovalJournal): void {
  const target = removalJournalPathForRecord(record);
  if (fs.existsSync(target)) {
    const current = readRemovalJournalAt(target);
    if (!current || current.revision !== record.revision || current.handoffId !== record.handoffId) {
      throw new Error('SANDBOX_CONTROL_REMOVAL_JOURNAL_REVISION_MISMATCH');
    }
    fs.rmSync(target, { force: true });
  }
}

export function clearSandboxRemovalJournal(manifest: SandboxControlManifest): void {
  const target = removalJournalPath(manifest);
  if (fs.existsSync(target)) fs.rmSync(target, { force: true });
}

type RemovalJournalCursor = Readonly<{
  record: SandboxRemovalJournal;
  write(phase: SandboxRemovalJournalPhase): SandboxRemovalJournal;
}>;

function defaultRemovalTarget(manifest: SandboxControlManifest): SandboxRemovalTargetCommit {
  const targetDigest = createHash('sha256')
    .update(`${manifest.project}\0${manifest.branch}\0${manifest.container}\0${manifest.channelDir}`)
    .digest('hex');
  return {
    branch: manifest.branch,
    project: manifest.project,
    controlRoot: path.dirname(manifest.channelDir),
    targetDigest,
    permitDigest: createHash('sha256').update('none').digest('hex'),
    removeWorktree: false,
    removeBranch: false,
    removeShare: false,
    worktreePaths: [],
    workspaceViewPaths: [],
    toolPaths: [],
    shellPaths: [],
    sharePath: path.join(path.dirname(manifest.channelDir), 'share'),
    permits: []
  };
}

function sameRemovalTarget(left: SandboxRemovalTargetCommit, right: SandboxRemovalTargetCommit): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function phaseIndex(phase: SandboxRemovalJournalPhase): number {
  return SANDBOX_REMOVAL_JOURNAL_PHASES.indexOf(phase);
}

export function sandboxRemovalPhaseIndex(phase: SandboxRemovalJournalPhase): number {
  return phaseIndex(phase);
}

function assertNextRemovalPhase(current: SandboxRemovalJournalPhase, next: SandboxRemovalJournalPhase): boolean {
  const currentIndex = phaseIndex(current);
  const nextIndex = phaseIndex(next);
  if (nextIndex === currentIndex) return false;
  if (current === 'target-committed' && next === 'container-absent') return true;
  if (nextIndex !== currentIndex + 1) {
    throw new Error('SANDBOX_CONTROL_REMOVAL_PHASE_TRANSITION_INVALID');
  }
  return true;
}

function assertRemovalJournalLock(
  record: SandboxRemovalJournal,
  resourceLock: SandboxResourceLock
): void {
  const namespace = resolveSandboxLockNamespace(`${record.engine}:${record.containerId}`, {
    lockDomain: record.lockDomain
  });
  if (resourceLock.lockDomain !== record.lockDomain || resourceLock.path !== namespace.lockPath) {
    throw new Error('SANDBOX_CONTROL_REMOVAL_LOCK_MISMATCH');
  }
}

function writeRemovalJournalAt(
  target: string,
  base: Omit<SandboxRemovalJournal, 'phase' | 'expectedOldJournalRevision' | 'revision' | 'recordedAt'>,
  phase: SandboxRemovalJournalPhase,
  expectedOldJournalRevision: number | null
): SandboxRemovalJournal {
  const existing = readRemovalJournalAt(target);
  if (expectedOldJournalRevision === null
    ? existing !== null
    : existing?.revision !== expectedOldJournalRevision) {
    throw new Error('SANDBOX_CONTROL_REMOVAL_JOURNAL_REVISION_MISMATCH');
  }
  const record: SandboxRemovalJournal = {
    ...base,
    phase,
    expectedOldJournalRevision,
    revision: expectedOldJournalRevision === null ? 1 : expectedOldJournalRevision + 1,
    recordedAt: Date.now()
  };
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600, flag: 'wx' });
    if (expectedOldJournalRevision === null && fs.existsSync(target)) {
      throw new Error('SANDBOX_CONTROL_REMOVAL_JOURNAL_REVISION_MISMATCH');
    }
    fs.renameSync(temporary, target);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  return record;
}

function writeRemovalJournal(
  manifest: SandboxControlManifest,
  base: Omit<SandboxRemovalJournal, 'phase' | 'expectedOldJournalRevision' | 'revision' | 'recordedAt'>,
  phase: SandboxRemovalJournalPhase,
  expectedOldJournalRevision: number | null
): SandboxRemovalJournal {
  return writeRemovalJournalAt(removalJournalPath(manifest), base, phase, expectedOldJournalRevision);
}

function startRemovalJournal(
  manifest: SandboxControlManifest,
  options: Readonly<{
    target?: SandboxRemovalTargetCommit;
    identityProbe: ProcessIdentityProbe;
  }>
): RemovalJournalCursor {
  const target = removalJournalPath(manifest);
  const existing = readRemovalJournalAt(target);
  if (existing && (existing.engine !== manifest.engine || existing.containerId !== manifest.containerIdentity.id
    || existing.generation !== manifest.generation
    || existing.authorityFingerprint !== manifest.authorityEvidence.authorityFingerprint
    || existing.lockDomain !== manifest.authorityEvidence.lockDomain)) {
    throw new Error('SANDBOX_CONTROL_REMOVAL_JOURNAL_IDENTITY_MISMATCH');
  }
  const targetCommit = options.target ?? existing?.target ?? defaultRemovalTarget(manifest);
  if (existing && options.target && !sameRemovalTarget(existing.target, options.target)) {
    throw new Error('SANDBOX_CONTROL_REMOVAL_TARGET_MISMATCH');
  }
  if (existing) {
    const state = options.identityProbe(existing.owner);
    if (state === 'alive') throw new Error('SANDBOX_CONTROL_REMOVE_RETRY_IN_PROGRESS');
    if (state === 'unknown') throw new Error('SANDBOX_CONTROL_REMOVE_OWNER_UNKNOWN');
  }
  const startTime = getProcessStartTime(process.pid);
  if (startTime === null) throw new Error('SANDBOX_CONTROL_REMOVE_OWNER_UNAVAILABLE');
  const base = {
    version: 2 as const,
    operation: 'sandbox-rm' as const,
    oldOperation: 'sandbox-rm' as const,
    newOperation: 'sandbox-rm' as const,
    handoffId: randomUUID(),
    transitionId: randomUUID(),
    engine: manifest.engine,
    containerId: manifest.containerIdentity.id,
    generation: manifest.generation,
    authorityFingerprint: manifest.authorityEvidence.authorityFingerprint,
    carrierIdentityDigest: removalCarrierDigest(manifest.engine, manifest.containerIdentity.id, manifest.generation),
    lockDomain: manifest.authorityEvidence.lockDomain,
    owner: { pid: process.pid, startTime, leaseNonce: randomUUID() },
    target: targetCommit
  };
  const initialPhase = existing?.phase ?? 'prepared';
  let record = writeRemovalJournal(manifest, base, initialPhase, existing?.revision ?? null);
  return {
    get record() { return record; },
    write(phase) {
      if (!assertNextRemovalPhase(record.phase, phase)) return record;
      record = writeRemovalJournal(manifest, base, phase, record.revision);
      return record;
    }
  };
}

export function claimSandboxRemovalJournal(
  journal: SandboxRemovalJournal,
  options: Readonly<{ identityProbe?: ProcessIdentityProbe; resourceLock?: SandboxResourceLock }> = {}
): SandboxRemovalJournal {
  const target = removalJournalPathForRecord(journal);
  const resourceLock = options.resourceLock
    ?? acquireSandboxResourceLock(`${journal.engine}:${journal.containerId}`, { lockDomain: journal.lockDomain });
  const ownedLock = options.resourceLock ? null : resourceLock;
  try {
    assertRemovalJournalLock(journal, resourceLock);
    const current = readRemovalJournalAt(target);
    if (!current || current.revision !== journal.revision || current.handoffId !== journal.handoffId) {
      throw new Error('SANDBOX_CONTROL_REMOVAL_JOURNAL_REVISION_MISMATCH');
    }
    const state = (options.identityProbe ?? getProcessIdentityState)(current.owner);
    if (state === 'alive') throw new Error('SANDBOX_CONTROL_REMOVE_RETRY_IN_PROGRESS');
    if (state === 'unknown') throw new Error('SANDBOX_CONTROL_REMOVE_OWNER_UNKNOWN');
    const startTime = getProcessStartTime(process.pid);
    if (startTime === null) throw new Error('SANDBOX_CONTROL_REMOVE_OWNER_UNAVAILABLE');
    const base = {
      ...current,
      handoffId: randomUUID(),
      transitionId: randomUUID(),
      owner: { pid: process.pid, startTime, leaseNonce: randomUUID() }
    };
    return writeRemovalJournalAt(target, base, current.phase, current.revision);
  } finally {
    ownedLock?.release();
  }
}

export function advanceSandboxRemovalJournalPhase(
  journal: SandboxRemovalJournal,
  phase: SandboxRemovalJournalPhase,
  options: Readonly<{ resourceLock?: SandboxResourceLock }> = {}
): SandboxRemovalJournal {
  const target = removalJournalPathForRecord(journal);
  const resourceLock = options.resourceLock
    ?? acquireSandboxResourceLock(`${journal.engine}:${journal.containerId}`, { lockDomain: journal.lockDomain });
  const ownedLock = options.resourceLock ? null : resourceLock;
  try {
    assertRemovalJournalLock(journal, resourceLock);
    const current = readRemovalJournalAt(target);
    if (!current || current.revision !== journal.revision || current.handoffId !== journal.handoffId) {
      throw new Error('SANDBOX_CONTROL_REMOVAL_JOURNAL_REVISION_MISMATCH');
    }
    if (!assertNextRemovalPhase(current.phase, phase)) return current;
    const {
      phase: _phase,
      expectedOldJournalRevision: _expected,
      revision: _revision,
      recordedAt: _recordedAt,
      ...base
    } = current;
    return writeRemovalJournalAt(target, base, phase, current.revision);
  } finally {
    ownedLock?.release();
  }
}

async function awaitWithDeadline<T>(
  operation: () => Promise<T>,
  deadlineAt: number,
  errorCode: string
): Promise<T> {
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) throw new Error(errorCode);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(errorCode)), remaining);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function forceDeadline(deadlineAt: number, timeoutMs: number): number {
  return Math.max(Date.now(), deadlineAt - Math.max(1, Math.floor(timeoutMs / 2)));
}

function regularFile(filePath: string): boolean {
  try {
    const stat = fs.lstatSync(filePath);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export function isSandboxControlRootQuiescing(root: string): boolean {
  return fs.existsSync(path.join(path.resolve(root), QUIESCING_FILE));
}

function markSandboxControlRootQuiescing(root: string): void {
  const markerPath = path.join(root, QUIESCING_FILE);
  try {
    fs.writeFileSync(markerPath, `${JSON.stringify({ version: 1, startedAt: Date.now() })}\n`, {
      mode: 0o600,
      flag: 'wx'
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    if (!regularFile(markerPath)) throw new Error('SANDBOX_CONTROL_CHANNEL_INVALID');
  }
}

function recordSandboxRemovalPending(
  root: string,
  manifest: SandboxControlManifest,
  phase: 'container-removal' | 'container-verification',
  journal: RemovalJournalCursor
): void {
  const pendingPath = path.join(root, 'removal-pending.json');
  const temporary = `${pendingPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify({
      version: 1,
      phase,
      containerId: manifest.containerIdentity.id,
      generation: manifest.generation,
      authorityFingerprint: manifest.authorityEvidence.authorityFingerprint,
      recordedAt: Date.now()
    })}\n`, { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, pendingPath);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  journal.write(phase === 'container-verification' ? 'container-absent' : 'container-removal');
}

function readStartupOwner(filePath: string): { raw: string; owner: OwnerIdentity } | null {
  if (!fs.existsSync(filePath)) return null;
  if (!regularFile(filePath)) throw new Error('SANDBOX_CONTROL_BROKER_START_TRANSITION');
  const raw = fs.readFileSync(filePath, 'utf8');
  try {
    const record = JSON.parse(raw) as Partial<OwnerIdentity> & { version?: unknown };
    if (record.version !== 2 || !Number.isSafeInteger(record.pid) || (record.pid ?? 0) <= 0
      || typeof record.startTime !== 'number' || !Number.isSafeInteger(record.startTime)) return null;
    return { raw, owner: { pid: record.pid!, startTime: record.startTime } };
  } catch {
    return null;
  }
}

async function waitForStartupTransition(
  root: string,
  timeoutMs: number,
  identityProbe: ProcessIdentityProbe = getProcessIdentityState
): Promise<void> {
  const transitionPath = path.join(root, BROKER_STARTING_FILE);
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const transition = readStartupOwner(transitionPath);
    if (!fs.existsSync(transitionPath)) return;
    if (transition && !ownerLive(transition.owner, identityProbe)) {
      try {
        if (fs.readFileSync(transitionPath, 'utf8') === transition.raw) fs.unlinkSync(transitionPath);
      } catch {
        // A concurrent startup transition changed or removed the record.
      }
      continue;
    }
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('SANDBOX_CONTROL_BROKER_START_TRANSITION');
}

export async function acquireSandboxControlBrokerStartup(
  root: string,
  owner: OwnerIdentity,
  timeoutMs = 5_000,
  options: Readonly<{ identityProbe?: ProcessIdentityProbe }> = {}
): Promise<() => void> {
  const resolvedRoot = path.resolve(root);
  const transitionPath = path.join(resolvedRoot, BROKER_STARTING_FILE);
  const record = `${JSON.stringify({ version: 2, ...owner })}\n`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (isSandboxControlRootQuiescing(resolvedRoot)) throw new Error('SANDBOX_CONTROL_QUIESCING');
    try {
      fs.writeFileSync(transitionPath, record, { mode: 0o600, flag: 'wx' });
      if (isSandboxControlRootQuiescing(resolvedRoot)) {
        try {
          if (fs.readFileSync(transitionPath, 'utf8') === record) fs.unlinkSync(transitionPath);
        } catch {
          // The deletion side owns the transition now.
        }
        throw new Error('SANDBOX_CONTROL_QUIESCING');
      }
      return () => {
        try {
          if (fs.readFileSync(transitionPath, 'utf8') === record) fs.unlinkSync(transitionPath);
        } catch {
          // A newer transition or deletion owns the path.
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const transition = readStartupOwner(transitionPath);
      if (transition && !ownerLive(transition.owner, options.identityProbe)) {
        try {
          if (fs.readFileSync(transitionPath, 'utf8') === transition.raw) fs.unlinkSync(transitionPath);
        } catch {
          // A concurrent transition changed the record.
        }
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new Error('SANDBOX_CONTROL_BROKER_START_TRANSITION');
}

type ReplacementRecord = Readonly<{
  version: 1;
  transitionId: string;
  pid: number;
  startTime: number;
}>;

type ReplacementStateRecord = Readonly<{
  version: 1;
  phase: 'prepared' | 'committed';
  root: string;
  snapshotRoot: string;
  transitionId: string;
}>;

export type SandboxControlReplacementCutover = Readonly<{
  root: string;
  snapshotRoot: string;
  transitionId: string;
}>;

export type SandboxControlCutoverSnapshot = Readonly<{
  root: string;
  manifestRaw: string | null;
  brokerRaw: string | null;
  statusRaw: string | null;
  processing: ReadonlyArray<Readonly<{ name: string; directory: boolean; executionRaw: string | null }>>;
}>;

export type SandboxControlReplacementLease = Readonly<{
  root: string;
  transitionId: string;
  owner: ProcessIdentity;
  assertOwned(): void;
  clearQuiescing(): void;
  release(): void;
}>;

function replacementPath(root: string): string {
  return path.join(root, REPLACEMENT_FILE);
}

function replacementStatePath(root: string): string {
  const resolvedRoot = path.resolve(root);
  return path.join(path.dirname(resolvedRoot), `.${path.basename(resolvedRoot)}${REPLACEMENT_STATE_SUFFIX}`);
}

function replacementSnapshotPath(root: string, transitionId: string): string {
  const resolvedRoot = path.resolve(root);
  return path.join(path.dirname(resolvedRoot), `.${path.basename(resolvedRoot)}.replacement-${transitionId}.snapshot`);
}

function writeAtomicText(filePath: string, content: string): void {
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, filePath);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function readReplacementState(root: string): ReplacementStateRecord | null {
  const filePath = replacementStatePath(root);
  if (!fs.existsSync(filePath)) return null;
  if (!regularFile(filePath)) throw new Error('SANDBOX_CONTROL_REPLACEMENT_RECOVERY_INVALID');
  try {
    const value = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Partial<ReplacementStateRecord>;
    const resolvedRoot = path.resolve(root);
    if (value.version !== 1 || (value.phase !== 'prepared' && value.phase !== 'committed')
      || value.root !== resolvedRoot || typeof value.transitionId !== 'string' || value.transitionId.length === 0
      || value.snapshotRoot !== replacementSnapshotPath(resolvedRoot, value.transitionId)) {
      throw new Error('invalid replacement state');
    }
    return value as ReplacementStateRecord;
  } catch {
    throw new Error('SANDBOX_CONTROL_REPLACEMENT_RECOVERY_INVALID');
  }
}

function writeReplacementState(state: ReplacementStateRecord): void {
  writeAtomicText(replacementStatePath(state.root), `${JSON.stringify(state)}\n`);
}

function removeReplacementState(root: string): void {
  fs.rmSync(replacementStatePath(root), { force: true });
}

function readReplacementRecord(filePath: string): { raw: string; record: ReplacementRecord } | null {
  if (!fs.existsSync(filePath)) return null;
  if (!regularFile(filePath)) throw new Error('SANDBOX_CONTROL_REPLACEMENT_INVALID');
  const raw = fs.readFileSync(filePath, 'utf8');
  try {
    const value = JSON.parse(raw) as Partial<ReplacementRecord>;
    if (value.version !== 1 || typeof value.transitionId !== 'string' || value.transitionId.length === 0
      || !Number.isSafeInteger(value.pid) || (value.pid ?? 0) <= 0
      || !Number.isSafeInteger(value.startTime)) throw new Error('invalid replacement');
    return { raw, record: value as ReplacementRecord };
  } catch {
    throw new Error('SANDBOX_CONTROL_REPLACEMENT_INVALID');
  }
}

export function acquireSandboxControlReplacement(
  root: string,
  options: Readonly<{
    owner?: ProcessIdentity;
    probeOwner?: (identity: ProcessIdentity) => ProcessIdentityState;
  }> = {}
): SandboxControlReplacementLease {
  const resolvedRoot = path.resolve(root);
  if (fs.existsSync(resolvedRoot)) {
    const stat = fs.lstatSync(resolvedRoot);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('SANDBOX_CONTROL_CHANNEL_INVALID');
  } else {
    fs.mkdirSync(resolvedRoot, { recursive: true, mode: 0o700 });
  }
  const startTime = options.owner?.startTime ?? getProcessStartTime(process.pid);
  if (startTime === null || startTime === undefined) throw new Error('SANDBOX_CONTROL_REPLACEMENT_OWNER_UNAVAILABLE');
  const owner = options.owner ?? { pid: process.pid, startTime };
  const transitionId = randomUUID();
  const record = `${JSON.stringify({ version: 1, transitionId, ...owner })}\n`;
  const filePath = replacementPath(resolvedRoot);
  const existing = readReplacementRecord(filePath);
  if (existing) {
    const ownerState = (options.probeOwner ?? getProcessIdentityState)(existing.record);
    if (ownerState === 'alive') {
      throw new Error('SANDBOX_CONTROL_REPLACEMENT_BUSY');
    }
    if (ownerState === 'unknown') {
      throw new Error('SANDBOX_CONTROL_REPLACEMENT_OWNER_UNAVAILABLE');
    }
    if (fs.readFileSync(filePath, 'utf8') !== existing.raw) {
      throw new Error('SANDBOX_CONTROL_OWNER_TRANSITION');
    }
    fs.unlinkSync(filePath);
  }
  try {
    fs.writeFileSync(filePath, record, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error('SANDBOX_CONTROL_REPLACEMENT_BUSY');
    }
    throw error;
  }
  let released = false;
  const verifyOwnership = (): void => {
    if (released) throw new Error('SANDBOX_CONTROL_REPLACEMENT_RELEASED');
    const current = readReplacementRecord(filePath);
    if (!current || current.raw !== record || current.record.transitionId !== transitionId) {
      throw new Error('SANDBOX_CONTROL_OWNER_TRANSITION');
    }
  };
  return {
    root: resolvedRoot,
    transitionId,
    owner,
    assertOwned: verifyOwnership,
    clearQuiescing(): void {
      verifyOwnership();
      const markerPath = path.join(resolvedRoot, QUIESCING_FILE);
      if (fs.existsSync(markerPath)) {
        if (!regularFile(markerPath)) throw new Error('SANDBOX_CONTROL_CHANNEL_INVALID');
        fs.unlinkSync(markerPath);
      }
    },
    release(): void {
      if (released) return;
      verifyOwnership();
      fs.unlinkSync(filePath);
      released = true;
    }
  };
}

function readReplacementRaw(root: string): string {
  const current = readReplacementRecord(replacementPath(root));
  if (!current) throw new Error('SANDBOX_CONTROL_OWNER_TRANSITION');
  return current.raw;
}

export function beginSandboxControlReplacement(
  root: string,
  lease: Readonly<{ root: string; transitionId: string; assertOwned(): void }>
): SandboxControlReplacementCutover {
  const resolvedRoot = path.resolve(root);
  if (path.resolve(lease.root) !== resolvedRoot) throw new Error('SANDBOX_CONTROL_OWNER_TRANSITION');
  lease.assertOwned();
  if (!fs.existsSync(resolvedRoot)) throw new Error('SANDBOX_CONTROL_CHANNEL_INVALID');
  const rootStat = fs.lstatSync(resolvedRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('SANDBOX_CONTROL_CHANNEL_INVALID');
  if (readReplacementState(resolvedRoot)) throw new Error('SANDBOX_CONTROL_REPLACEMENT_RECOVERY_REQUIRED');
  const snapshotRoot = replacementSnapshotPath(resolvedRoot, lease.transitionId);
  if (fs.existsSync(snapshotRoot)) throw new Error('SANDBOX_CONTROL_REPLACEMENT_RECOVERY_INVALID');
  const replacementRaw = readReplacementRaw(resolvedRoot);
  const state: ReplacementStateRecord = {
    version: 1,
    phase: 'prepared',
    root: resolvedRoot,
    snapshotRoot,
    transitionId: lease.transitionId
  };
  writeReplacementState(state);
  let moved = false;
  try {
    fs.renameSync(resolvedRoot, snapshotRoot);
    moved = true;
    fs.mkdirSync(resolvedRoot, { recursive: true, mode: 0o700 });
    fs.writeFileSync(replacementPath(resolvedRoot), replacementRaw, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    markSandboxControlRootQuiescing(resolvedRoot);
    return { root: resolvedRoot, snapshotRoot, transitionId: lease.transitionId };
  } catch (error) {
    if (moved) {
      fs.rmSync(resolvedRoot, { recursive: true, force: true });
      fs.renameSync(snapshotRoot, resolvedRoot);
    }
    removeReplacementState(resolvedRoot);
    throw error;
  }
}

function isRecoverableCutoverManifestError(error: unknown): boolean {
  return error instanceof Error
    && (error.message.startsWith('SANDBOX_CONTROL_MANIFEST_')
      || error.message === 'SANDBOX_CONTROL_OWNER_EVIDENCE_MISSING');
}

export async function recoverSandboxControlReplacement(
  root: string,
  lease: Readonly<{ root: string; assertOwned(): void }>
): Promise<'none' | 'restored' | 'committed'> {
  const resolvedRoot = path.resolve(root);
  if (path.resolve(lease.root) !== resolvedRoot) throw new Error('SANDBOX_CONTROL_OWNER_TRANSITION');
  const state = readReplacementState(resolvedRoot);
  if (!state) return 'none';
  lease.assertOwned();
  if (state.phase === 'committed') {
    fs.rmSync(state.snapshotRoot, { recursive: true, force: true });
    removeReplacementState(resolvedRoot);
    return 'committed';
  }
  if (!fs.existsSync(state.snapshotRoot)) {
    removeReplacementState(resolvedRoot);
    return 'none';
  }
  if (fs.existsSync(resolvedRoot) && fs.existsSync(path.join(resolvedRoot, 'manifest.json'))) {
    try {
      await quiesceSandboxControlRoot(resolvedRoot);
    } catch (error) {
      if (!isRecoverableCutoverManifestError(error)) throw error;
    }
  }
  lease.assertOwned();
  const replacementRaw = readReplacementRaw(resolvedRoot);
  fs.rmSync(resolvedRoot, { recursive: true, force: true });
  fs.renameSync(state.snapshotRoot, resolvedRoot);
  writeAtomicText(replacementPath(resolvedRoot), replacementRaw);
  removeReplacementState(resolvedRoot);
  return 'restored';
}

export function commitSandboxControlReplacement(
  root: string,
  lease: Readonly<{ root: string; assertOwned(): void }>
): void {
  const resolvedRoot = path.resolve(root);
  if (path.resolve(lease.root) !== resolvedRoot) throw new Error('SANDBOX_CONTROL_OWNER_TRANSITION');
  const state = readReplacementState(resolvedRoot);
  if (!state) return;
  lease.assertOwned();
  writeReplacementState({ ...state, phase: 'committed' });
  fs.rmSync(state.snapshotRoot, { recursive: true, force: true });
  removeReplacementState(resolvedRoot);
}

function readOptionalRaw(filePath: string): string | null {
  if (!fs.existsSync(filePath)) return null;
  if (!regularFile(filePath)) throw new Error('SANDBOX_CONTROL_OWNER_TRANSITION');
  return fs.readFileSync(filePath, 'utf8');
}

function readProcessingSnapshot(root: string): SandboxControlCutoverSnapshot['processing'] {
  const processingDir = path.join(root, 'processing');
  if (!fs.existsSync(processingDir)) return [];
  const stat = fs.lstatSync(processingDir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('SANDBOX_CONTROL_EXECUTION_STILL_RUNNING');
  return fs.readdirSync(processingDir, { withFileTypes: true })
    .map((entry) => ({
      name: entry.name,
      directory: entry.isDirectory() && !entry.isSymbolicLink(),
      executionRaw: entry.isDirectory() && !entry.isSymbolicLink()
        ? readOptionalRaw(path.join(processingDir, entry.name, 'execution.json'))
        : null
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function captureSandboxControlCutoverSnapshot(root: string): SandboxControlCutoverSnapshot {
  const resolvedRoot = path.resolve(root);
  const manifestPath = path.join(resolvedRoot, 'manifest.json');
  return {
    root: resolvedRoot,
    manifestRaw: readOptionalRaw(manifestPath),
    brokerRaw: readOptionalRaw(path.join(resolvedRoot, 'broker.json')),
    statusRaw: readOptionalRaw(path.join(resolvedRoot, 'public', 'status.json')),
    processing: readProcessingSnapshot(resolvedRoot)
  };
}

export function assertSandboxControlCutoverSnapshot(snapshot: SandboxControlCutoverSnapshot): void {
  const current = captureSandboxControlCutoverSnapshot(snapshot.root);
  if (JSON.stringify(current) !== JSON.stringify(snapshot)) {
    throw new Error('SANDBOX_CONTROL_OWNER_TRANSITION');
  }
}

function readSandboxControlManifestValue(manifestPath: string): SandboxControlManifest {
  if (!regularFile(manifestPath)) throw new Error('SANDBOX_CONTROL_MANIFEST_INVALID');
  let manifest: Record<string, unknown>;
  try {
    const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('invalid manifest');
    }
    manifest = parsed as Record<string, unknown>;
  } catch {
    throw new Error('SANDBOX_CONTROL_MANIFEST_INVALID');
  }
  const candidate = manifest as Partial<SandboxControlManifest>;
  const expectedKeys = [
    'branch', 'channelDir', 'container', 'containerIdentity', 'engine', 'generation',
    'mode', 'processingDir', 'project', 'publicStatusDir', 'repoRoot', 'runtimeDir',
    'taskId', 'token', 'worktreeRoot', 'authorityEvidence'
  ];
  const actualKeys = Object.keys(manifest).sort().join(',');
  if (actualKeys !== expectedKeys.sort().join(',')) {
    throw new Error('SANDBOX_CONTROL_MANIFEST_INVALID');
  }
  if (typeof candidate.containerIdentity !== 'object' || candidate.containerIdentity === null
    || Array.isArray(candidate.containerIdentity)) throw new Error('SANDBOX_CONTROL_MANIFEST_INVALID');
  const containerIdentity = candidate.containerIdentity as Record<string, unknown>;
  if (Object.keys(containerIdentity).sort().join(',') !== 'id,labels'
    || typeof candidate.engine !== 'string' || candidate.engine.length === 0
    || typeof candidate.repoRoot !== 'string' || typeof candidate.worktreeRoot !== 'string'
    || typeof candidate.project !== 'string' || typeof candidate.container !== 'string'
    || typeof containerIdentity.id !== 'string' || containerIdentity.id.length === 0
    || typeof containerIdentity.labels !== 'object' || containerIdentity.labels === null
    || Array.isArray(containerIdentity.labels)
    || Object.values(containerIdentity.labels).some((value) => typeof value !== 'string')
    || typeof candidate.branch !== 'string'
    || (candidate.mode !== 'task-bound' && candidate.mode !== 'branch-only')
    || (candidate.taskId !== null && typeof candidate.taskId !== 'string')
    || typeof candidate.channelDir !== 'string' || typeof candidate.publicStatusDir !== 'string'
    || typeof candidate.processingDir !== 'string' || typeof candidate.runtimeDir !== 'string'
    || typeof candidate.token !== 'string'
    || typeof candidate.generation !== 'string'
    || (candidate.mode === 'task-bound' && (typeof candidate.taskId !== 'string' || candidate.taskId.length === 0))
    || (candidate.mode === 'branch-only' && candidate.taskId !== null)
    || !isSandboxAuthorityEvidence(candidate.authorityEvidence)) throw new Error('SANDBOX_CONTROL_MANIFEST_INVALID');
  const root = path.dirname(path.resolve(manifestPath));
  if (path.resolve(candidate.channelDir) !== path.join(root, 'channel')
    || path.resolve(candidate.publicStatusDir) !== path.join(root, 'public')
    || path.resolve(candidate.processingDir) !== path.join(root, 'processing')) {
    throw new Error('SANDBOX_CONTROL_MANIFEST_INVALID');
  }
  if (path.resolve(candidate.runtimeDir) !== path.join(root, 'runtime')) {
    throw new Error('SANDBOX_CONTROL_MANIFEST_INVALID');
  }
  const normalized: SandboxControlManifest = {
    engine: candidate.engine,
    repoRoot: candidate.repoRoot,
    worktreeRoot: candidate.worktreeRoot,
    project: candidate.project,
    container: candidate.container,
    containerIdentity: {
      id: containerIdentity.id as string,
      labels: { ...(containerIdentity.labels as Record<string, string>) }
    },
    authorityEvidence: candidate.authorityEvidence,
    branch: candidate.branch,
    mode: candidate.mode,
    taskId: candidate.taskId,
    token: candidate.token,
    generation: candidate.generation,
    channelDir: candidate.channelDir,
    publicStatusDir: candidate.publicStatusDir,
    processingDir: candidate.processingDir,
    runtimeDir: candidate.runtimeDir
  };
  return normalized;
}

export function readSandboxControlManifest(manifestPath: string): SandboxControlManifest {
  return readSandboxControlManifestValue(manifestPath);
}

function readBrokerOwner(filePath: string): BrokerOwner | null {
  if (!fs.existsSync(filePath)) return null;
  if (!regularFile(filePath)) throw new Error('SANDBOX_CONTROL_OWNER_MISMATCH');
  let owner: Partial<BrokerOwner> | null;
  try {
    owner = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Partial<BrokerOwner> | null;
  } catch {
    throw new Error('SANDBOX_CONTROL_OWNER_MISMATCH');
  }
  if (!owner || owner.version !== 3 || !Number.isSafeInteger(owner.pid) || (owner.pid ?? 0) <= 0
    || typeof owner.startTime !== 'number' || !Number.isSafeInteger(owner.startTime)
    || typeof owner.brokerId !== 'string' || owner.brokerId.length === 0
    || typeof owner.token !== 'string' || typeof owner.generation !== 'string') throw new Error('SANDBOX_CONTROL_OWNER_MISMATCH');
  return owner as BrokerOwner;
}

export function assertSandboxControlBrokerOwner(
  manifest: SandboxControlManifest,
  options: Readonly<{ identityProbe?: ProcessIdentityProbe }> = {}
): BrokerOwner {
  const root = path.dirname(path.resolve(manifest.publicStatusDir));
  const owner = readBrokerOwner(path.join(root, 'broker.json'));
  if (!owner) throw new Error('SANDBOX_CONTROL_OWNER_EVIDENCE_MISSING');
  if (owner.token !== manifest.token || owner.generation !== manifest.generation) {
    throw new Error('SANDBOX_CONTROL_OWNER_MISMATCH');
  }
  if (!ownerLive(owner, options.identityProbe)) throw new Error('SANDBOX_CONTROL_OWNER_LOST');
  return owner;
}

function readStatusOwner(filePath: string): SandboxControlStatus | null {
  if (!fs.existsSync(filePath)) return null;
  if (!regularFile(filePath)) throw new Error('SANDBOX_CONTROL_OWNER_MISMATCH');
  try {
    return parseSandboxControlStatus(JSON.parse(fs.readFileSync(filePath, 'utf8')));
  } catch {
    throw new Error('SANDBOX_CONTROL_OWNER_MISMATCH');
  }
}

function sameOwner(left: OwnerIdentity, right: OwnerIdentity): boolean {
  return left.pid === right.pid && left.startTime === right.startTime
    && (!left.brokerId || !right.brokerId || left.brokerId === right.brokerId);
}

function ownerLive(
  owner: OwnerIdentity,
  identityProbe: ProcessIdentityProbe = getProcessIdentityState
): boolean {
  const state = identityProbe({ pid: owner.pid, startTime: owner.startTime });
  if (state === 'unknown') throw new Error('SANDBOX_CONTROL_OWNER_UNAVAILABLE');
  return state === 'alive';
}

function readExecutions(manifest: SandboxControlManifest): SandboxControlExecution[] {
  if (!fs.existsSync(manifest.processingDir)) return [];
  const stat = fs.lstatSync(manifest.processingDir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('SANDBOX_CONTROL_EXECUTION_STILL_RUNNING');
  const executions: SandboxControlExecution[] = [];
  for (const entry of fs.readdirSync(manifest.processingDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const descriptor = path.join(manifest.processingDir, entry.name, 'execution.json');
    if (!fs.existsSync(descriptor)) continue;
    let execution: SandboxControlExecution;
    try {
      execution = readExecution(descriptor);
    } catch {
      throw new Error(`SANDBOX_CONTROL_EXECUTION_STILL_RUNNING: ${entry.name}`);
    }
    if (execution.generation !== manifest.generation || execution.requestId !== entry.name) {
      throw new Error(`SANDBOX_CONTROL_EXECUTION_STILL_RUNNING: ${entry.name}`);
    }
    if (execution.child.pid <= 0 || (execution.child.processGroupId !== null
      && (!Number.isSafeInteger(execution.child.processGroupId) || execution.child.processGroupId <= 0))) {
      throw new Error(`SANDBOX_CONTROL_EXECUTION_STILL_RUNNING: ${entry.name}`);
    }
    executions.push(execution);
  }
  return executions;
}

function processGroupState(groupId: number): ProcessIdentityState {
  try {
    const rows = execFileSync('ps', ['-axo', 'pgid=,stat='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return rows.split('\n').some((row) => {
      const match = row.trim().match(/^(\d+)\s+(\S+)/);
      return Number(match?.[1]) === groupId && !match?.[2]?.startsWith('Z');
    }) ? 'alive' : 'dead';
  } catch {
    try {
      process.kill(-groupId, 0);
      return 'alive';
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ESRCH') return 'dead';
      if (code === 'EPERM') return 'alive';
      return 'unknown';
    }
  }
}

function executionAlive(
  execution: SandboxControlExecution,
  platform: NodeJS.Platform,
  identityProbe: ProcessIdentityProbe = getProcessIdentityState
): boolean {
  const state = platform !== 'win32' && execution.child.processGroupId
    ? processGroupState(execution.child.processGroupId)
    : identityProbe({ pid: execution.child.pid, startTime: execution.child.startTime });
  if (state === 'unknown') throw new Error('SANDBOX_CONTROL_EXECUTION_OWNER_UNAVAILABLE');
  return state === 'alive';
}

async function waitForExit(
  owner: OwnerIdentity,
  timeoutMs: number,
  deadlineAt?: number,
  identityProbe: ProcessIdentityProbe = getProcessIdentityState
): Promise<boolean> {
  const deadline = deadlineAt ?? (Date.now() + timeoutMs);
  while (Date.now() < deadline) {
    if (!ownerLive(owner, identityProbe)) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return !ownerLive(owner, identityProbe);
}

function signalOwner(owner: OwnerIdentity, platform: NodeJS.Platform, force: boolean): void {
  try {
    if (platform === 'win32') {
      const command = buildProcessTreeStopCommand(owner.pid, platform);
      if (command.kind === 'exec') execFileSync(command.command, command.args, { stdio: 'ignore' });
      return;
    }
    process.kill(owner.pid, force ? 'SIGKILL' : 'SIGTERM');
  } catch {
    // The identity checks decide whether the owner actually exited.
  }
}

function mergeExecutions(...groups: readonly SandboxControlExecution[][]): SandboxControlExecution[] {
  const merged = new Map<string, SandboxControlExecution>();
  for (const execution of groups.flat()) merged.set(`${execution.requestId}:${execution.nonce}`, execution);
  return [...merged.values()];
}

export async function quiesceSandboxControlRoot(
  root: string,
  options: {
    platform?: NodeJS.Platform;
    timeoutMs?: number;
    timing?: SandboxControlTimingPolicy;
    identityProbe?: ProcessIdentityProbe;
  } = {}
): Promise<'missing' | 'stale' | 'stopped'> {
  const resolvedRoot = path.resolve(root);
  if (!fs.existsSync(resolvedRoot)) return 'missing';
  const rootStat = fs.lstatSync(resolvedRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('SANDBOX_CONTROL_CHANNEL_INVALID');

  for (const directory of [path.join(resolvedRoot, 'public'), path.join(resolvedRoot, 'processing')]) {
    if (!fs.existsSync(directory)) continue;
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('SANDBOX_CONTROL_CHANNEL_INVALID');
  }

  const timeoutMs = options.timeoutMs ?? options.timing?.quiesceDeadlineMs ?? DEFAULT_QUIESCE_TIMEOUT_MS;
  const identityProbe = options.identityProbe ?? getProcessIdentityState;
  const deadlineAt = Date.now() + timeoutMs;
  const forceAt = forceDeadline(deadlineAt, timeoutMs);
  markSandboxControlRootQuiescing(resolvedRoot);
  await waitForStartupTransition(resolvedRoot, Math.max(0, forceAt - Date.now()), identityProbe);

  const manifestPath = path.join(resolvedRoot, 'manifest.json');
  const manifest = fs.existsSync(manifestPath) ? readSandboxControlManifest(manifestPath) : null;
  const broker = readBrokerOwner(path.join(resolvedRoot, 'broker.json'));
  const status = readStatusOwner(path.join(resolvedRoot, 'public', 'status.json'));
  const statusOwner = status ? status.broker : null;
  const brokerLive = broker ? ownerLive(broker, identityProbe) : false;
  const statusLive = statusOwner ? ownerLive(statusOwner, identityProbe) : false;

  if (manifest && broker && (broker.token !== manifest.token || broker.generation !== manifest.generation)) {
    throw new Error('SANDBOX_CONTROL_OWNER_MISMATCH');
  }
  if (manifest && status && status.generation !== manifest.generation) {
    throw new Error('SANDBOX_CONTROL_OWNER_MISMATCH');
  }
  if (broker && statusOwner && !sameOwner(broker, statusOwner) && (brokerLive || statusLive)) {
    throw new Error('SANDBOX_CONTROL_OWNER_MISMATCH');
  }
  if (!manifest && brokerLive) throw new Error('SANDBOX_CONTROL_OWNER_MISMATCH');

  const platform = options.platform ?? process.platform;
  let executions = manifest ? readExecutions(manifest) : [];
  const owner: OwnerIdentity | null = brokerLive ? broker : statusLive ? statusOwner : null;
  if (!owner) {
    if (manifest && !broker && !status) throw new Error('SANDBOX_CONTROL_OWNER_EVIDENCE_MISSING');
    for (const execution of executions) {
      terminateSandboxControlExecution(execution, { platform, timeoutMs: 0, allowForce: false, identityProbe });
    }
    const softDeadlineAt = Math.min(forceAt, Date.now() + Math.floor(Math.max(0, forceAt - Date.now()) / 2));
    while (Date.now() < softDeadlineAt) {
      if (!executions.some((execution) => executionAlive(execution, platform, identityProbe))) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (manifest) executions = mergeExecutions(executions, readExecutions(manifest));
    if (Date.now() >= deadlineAt) throw new Error('SANDBOX_CONTROL_QUIESCE_DEADLINE_EXCEEDED');
    for (const execution of executions) {
      if (!terminateSandboxControlExecution(execution, {
        platform, timeoutMs: Math.max(0, deadlineAt - Date.now()), deadlineAt, forceAt: Date.now(), identityProbe
      })) {
        throw new Error(`SANDBOX_CONTROL_EXECUTION_STILL_RUNNING: ${execution.requestId}`);
      }
    }
    if (executions.some((execution) => executionAlive(execution, platform, identityProbe))) {
      throw new Error('SANDBOX_CONTROL_EXECUTION_STILL_RUNNING');
    }
    return broker || status ? 'stale' : 'missing';
  }

  const remaining = (): number => Math.max(0, deadlineAt - Date.now());
  signalOwner(owner, platform, false);
  for (const execution of executions) {
    terminateSandboxControlExecution(execution, { platform, timeoutMs: 0, allowForce: false, identityProbe });
  }
  const softDeadlineAt = Math.min(forceAt, Date.now() + Math.floor(Math.max(0, forceAt - Date.now()) / 2));
  while (Date.now() < softDeadlineAt) {
    if (!ownerLive(owner, identityProbe) && !executions.some((execution) => executionAlive(execution, platform, identityProbe))) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (!ownerLive(owner, identityProbe) && !executions.some((execution) => executionAlive(execution, platform, identityProbe))) {
    return 'stopped';
  }
  if (manifest) executions = mergeExecutions(executions, readExecutions(manifest));
  if (Date.now() >= deadlineAt) throw new Error('SANDBOX_CONTROL_QUIESCE_DEADLINE_EXCEEDED');
  for (const execution of executions) {
    terminateSandboxControlExecution(execution, { platform, timeoutMs: 0, deadlineAt, forceAt: Date.now(), identityProbe });
  }
  signalOwner(owner, platform, true);
  while (Date.now() < deadlineAt) {
    if (!ownerLive(owner, identityProbe) && !executions.some((execution) => executionAlive(execution, platform, identityProbe))) return 'stopped';
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (ownerLive(owner, identityProbe)) throw new Error('SANDBOX_CONTROL_BROKER_STILL_RUNNING');
  if (executions.some((execution) => executionAlive(execution, platform, identityProbe))) throw new Error('SANDBOX_CONTROL_EXECUTION_STILL_RUNNING');
  return 'stopped';
}

export type RemoveSandboxControlOptions = Readonly<{
  platform?: NodeJS.Platform;
  timeoutMs?: number;
  timing?: SandboxControlTimingPolicy;
  identityProbe?: ProcessIdentityProbe;
  inspectContainer?: (timeoutMs: number) => Promise<ContainerObservation>;
  removeContainer: (timeoutMs: number) => Promise<void>;
  requireAbsent?: boolean;
  selfOwner?: BrokerOwner;
  resourceLock?: SandboxResourceLock;
  retainRemovalJournal?: boolean;
  removalTarget?: SandboxRemovalTargetCommit;
}>;

export async function removeSandboxControlRoot(
  root: string,
  options: RemoveSandboxControlOptions
): Promise<void> {
  const resolvedRoot = path.resolve(root);
  if (!fs.existsSync(resolvedRoot)) return;
  const stat = fs.lstatSync(resolvedRoot);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('SANDBOX_CONTROL_CHANNEL_INVALID');
  const manifestPath = path.join(resolvedRoot, 'manifest.json');
  const manifestRawBeforeLock = fs.readFileSync(manifestPath, 'utf8');
  const manifest = readSandboxControlManifest(manifestPath);
  const resourceLock = options.resourceLock ?? acquireSandboxResourceLock(
    `${manifest.engine}:${manifest.containerIdentity.id}`,
    { lockDomain: manifest.authorityEvidence.lockDomain }
  );
  try {
  if (fs.readFileSync(manifestPath, 'utf8') !== manifestRawBeforeLock) {
    throw new Error('SANDBOX_CONTROL_MANIFEST_CHANGED');
  }
  const inspectContainer = options.inspectContainer
    ?? ((timeoutMs) => inspectSandboxControlContainer(manifest, { timeoutMs }));
  const timeoutMs = options.timeoutMs ?? options.timing?.quiesceDeadlineMs ?? DEFAULT_QUIESCE_TIMEOUT_MS;
  const identityProbe = options.identityProbe ?? getProcessIdentityState;
  const deadlineAt = Date.now() + timeoutMs;
  const forceAt = forceDeadline(deadlineAt, timeoutMs);
  const remaining = (): number => Math.max(0, deadlineAt - Date.now());
  const journal = startRemovalJournal(manifest, {
    target: options.removalTarget,
    identityProbe
  });
  if (journal.record.phase === 'carrier-finalizing') {
    if (fs.readFileSync(manifestPath, 'utf8') !== manifestRawBeforeLock
      || !isSandboxControlRootQuiescing(resolvedRoot)) {
      throw new Error('SANDBOX_CONTROL_MANIFEST_CHANGED');
    }
    fs.rmSync(resolvedRoot, { recursive: true, force: true });
    if (fs.existsSync(resolvedRoot)) throw new Error('SANDBOX_CONTROL_TARGET_MISMATCH');
    journal.write('carrier-removed');
    if (!options.retainRemovalJournal) clearSandboxRemovalJournal(manifest);
    return;
  }
  if (sandboxRemovalPhaseIndex(journal.record.phase) >= sandboxRemovalPhaseIndex('carrier-removed')) {
    throw new Error('SANDBOX_CONTROL_TARGET_MISMATCH');
  }
  if (journal.record.phase === 'prepared') journal.write('target-committed');
  const observation = await awaitWithDeadline(
    () => inspectContainer(remaining()), deadlineAt, 'SANDBOX_CONTROL_REMOVE_DEADLINE_EXCEEDED'
  );
  if (observation.state === 'unknown') throw new Error(`SANDBOX_CONTROL_CONTAINER_UNKNOWN: ${observation.reason}`);
  journal.write(observation.state === 'absent' ? 'container-absent' : 'container-removal');
  if (options.requireAbsent && observation.state !== 'absent') {
    throw new Error('SANDBOX_CONTROL_CONTAINER_REAPPEARED');
  }

  markSandboxControlRootQuiescing(resolvedRoot);
  await waitForStartupTransition(resolvedRoot, Math.max(0, forceAt - Date.now()), identityProbe);
  const brokerPath = path.join(resolvedRoot, 'broker.json');
  const statusPath = path.join(resolvedRoot, 'public', 'status.json');
  const broker = readBrokerOwner(brokerPath);
  const status = readStatusOwner(statusPath);
  if (broker && (broker.token !== manifest.token || broker.generation !== manifest.generation)) {
    throw new Error('SANDBOX_CONTROL_OWNER_MISMATCH');
  }
  if (status && status.generation !== manifest.generation) {
    throw new Error('SANDBOX_CONTROL_OWNER_MISMATCH');
  }
  if (broker && status && !sameOwner(broker, status.broker)
    && (ownerLive(broker, identityProbe) || ownerLive(status.broker, identityProbe))) {
    throw new Error('SANDBOX_CONTROL_OWNER_MISMATCH');
  }
  const platform = options.platform ?? process.platform;
  const owner = broker && ownerLive(broker, identityProbe) ? broker
    : status && ownerLive(status.broker, identityProbe) ? status.broker : null;
  const selfOwner = options.selfOwner;
  const selfOwned = Boolean(selfOwner && broker && sameOwner(broker, selfOwner));
  if (selfOwner && (!broker || !selfOwned || broker.token !== manifest.token || broker.generation !== manifest.generation)) {
    throw new Error('SANDBOX_CONTROL_OWNER_TRANSITION');
  }
  let executions = readExecutions(manifest);
  if (owner && !selfOwned) signalOwner(owner, platform, false);
  for (const execution of executions) {
    terminateSandboxControlExecution(execution, { platform, timeoutMs: 0, allowForce: false, identityProbe });
  }
  const softDeadlineAt = Math.min(forceAt, Date.now() + Math.floor(Math.max(0, forceAt - Date.now()) / 2));
  while (Date.now() < softDeadlineAt) {
    if ((!owner || selfOwned || !ownerLive(owner, identityProbe))
      && !executions.some((execution) => executionAlive(execution, platform, identityProbe))) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  if (observation.state === 'found') {
    if (Date.now() >= deadlineAt) {
      recordSandboxRemovalPending(resolvedRoot, manifest, 'container-removal', journal);
      throw new Error('SANDBOX_CONTROL_REMOVE_PENDING');
    }
    let afterRemoval: ContainerObservation;
    try {
      await awaitWithDeadline(
        () => options.removeContainer(remaining()),
        deadlineAt,
        'SANDBOX_CONTROL_REMOVE_DEADLINE_EXCEEDED'
      );
      afterRemoval = await awaitWithDeadline(
        () => inspectContainer(remaining()),
        deadlineAt,
        'SANDBOX_CONTROL_REMOVE_DEADLINE_EXCEEDED'
      );
    } catch (error) {
      if (error instanceof Error && error.message === 'SANDBOX_CONTROL_REMOVE_DEADLINE_EXCEEDED') {
        recordSandboxRemovalPending(resolvedRoot, manifest, 'container-removal', journal);
        throw new Error('SANDBOX_CONTROL_REMOVE_PENDING');
      }
      throw error;
    }
    if (afterRemoval.state !== 'absent') {
      throw new Error(afterRemoval.state === 'unknown'
        ? `SANDBOX_CONTROL_CONTAINER_UNKNOWN: ${afterRemoval.reason}`
        : 'SANDBOX_CONTROL_CONTAINER_STILL_EXISTS');
    }
    journal.write('container-absent');
  }

  const currentManifestRaw = fs.readFileSync(manifestPath, 'utf8');
  const currentManifest = readSandboxControlManifest(manifestPath);
  if (currentManifestRaw !== manifestRawBeforeLock
    || currentManifest.engine !== manifest.engine
    || currentManifest.containerIdentity.id !== manifest.containerIdentity.id
    || currentManifest.authorityEvidence.lockDomain !== manifest.authorityEvidence.lockDomain
    || currentManifest.token !== manifest.token || currentManifest.generation !== manifest.generation
    || !isSandboxControlRootQuiescing(resolvedRoot)) {
    throw new Error('SANDBOX_CONTROL_MANIFEST_CHANGED');
  }
  const currentBroker = readBrokerOwner(brokerPath);
  if (selfOwned && (!currentBroker || !selfOwner || !sameOwner(selfOwner, currentBroker)
    || currentBroker.token !== manifest.token || currentBroker.generation !== manifest.generation)) {
    throw new Error('SANDBOX_CONTROL_OWNER_REPLACED');
  }
  if (owner && currentBroker && !sameOwner(owner, currentBroker)) {
    throw new Error('SANDBOX_CONTROL_OWNER_REPLACED');
  }
  if (!owner && currentBroker && ownerLive(currentBroker, identityProbe)) {
    throw new Error('SANDBOX_CONTROL_OWNER_REPLACED');
  }
  if (owner && ownerLive(owner, identityProbe) && !currentBroker) {
    throw new Error('SANDBOX_CONTROL_OWNER_EVIDENCE_MISSING');
  }

  executions = mergeExecutions(executions, readExecutions(manifest));
  if (Date.now() >= deadlineAt) throw new Error('SANDBOX_CONTROL_REMOVE_DEADLINE_EXCEEDED');
  for (const execution of executions) {
    if (!terminateSandboxControlExecution(execution, {
      platform, timeoutMs: remaining(), deadlineAt, forceAt: Date.now(), identityProbe
    })) {
      throw new Error(`SANDBOX_CONTROL_EXECUTION_STILL_RUNNING: ${execution.requestId}`);
    }
  }
  if (owner && currentBroker && ownerLive(currentBroker, identityProbe) && !selfOwned) {
    if (remaining() <= 0) throw new Error('SANDBOX_CONTROL_REMOVE_DEADLINE_EXCEEDED');
    signalOwner(currentBroker, platform, true);
    if (remaining() <= 0 || !await waitForExit(currentBroker, remaining(), deadlineAt, identityProbe)) {
      throw new Error('SANDBOX_CONTROL_BROKER_STILL_RUNNING');
    }
  }

  const finalExecutions = mergeExecutions(executions, readExecutions(manifest));
  if (finalExecutions.some((execution) => executionAlive(execution, platform, identityProbe))) {
    throw new Error('SANDBOX_CONTROL_EXECUTION_STILL_RUNNING');
  }

  const finalBrokerRaw = fs.existsSync(brokerPath) ? fs.readFileSync(brokerPath, 'utf8') : null;
  if (finalBrokerRaw !== null) {
    const finalBroker = readBrokerOwner(brokerPath);
    if (!finalBroker) throw new Error('SANDBOX_CONTROL_OWNER_MISMATCH');
    const finalSelfOwner = Boolean(selfOwner && sameOwner(finalBroker, selfOwner)
      && finalBroker.token === manifest.token && finalBroker.generation === manifest.generation);
    if (ownerLive(finalBroker, identityProbe) && !finalSelfOwner) {
      throw new Error('SANDBOX_CONTROL_BROKER_STILL_RUNNING');
    }
    if (fs.readFileSync(brokerPath, 'utf8') !== finalBrokerRaw) {
      throw new Error('SANDBOX_CONTROL_OWNER_TRANSITION');
    }
    fs.unlinkSync(brokerPath);
  }
  const finalStatusRaw = fs.existsSync(statusPath) ? fs.readFileSync(statusPath, 'utf8') : null;
  if (finalStatusRaw !== null) {
    const finalStatus = readStatusOwner(statusPath);
    if (!finalStatus) throw new Error('SANDBOX_CONTROL_OWNER_MISMATCH');
    if (ownerLive(finalStatus.broker, identityProbe)
      && !(selfOwner && sameOwner(finalStatus.broker, selfOwner))) {
      throw new Error('SANDBOX_CONTROL_BROKER_STILL_RUNNING');
    }
    if (fs.readFileSync(statusPath, 'utf8') !== finalStatusRaw) {
      throw new Error('SANDBOX_CONTROL_OWNER_TRANSITION');
    }
    fs.unlinkSync(statusPath);
  }
  if (fs.existsSync(brokerPath) || fs.existsSync(statusPath)) {
    throw new Error('SANDBOX_CONTROL_OWNER_EVIDENCE_REMAINS');
  }
  journal.write('carrier-finalizing');
  fs.rmSync(resolvedRoot, { recursive: true, force: true });
  journal.write('carrier-removed');
  if (!options.retainRemovalJournal) clearSandboxRemovalJournal(manifest);
  } finally {
    if (!options.resourceLock) resourceLock.release();
  }
}

export type GarbageCollectSandboxControlOptions = Omit<RemoveSandboxControlOptions, 'removeContainer' | 'requireAbsent'>;

export async function garbageCollectSandboxControlRoot(
  root: string,
  options: GarbageCollectSandboxControlOptions = {}
): Promise<void> {
  await removeSandboxControlRoot(path.resolve(root), {
    ...options,
    requireAbsent: true,
    removeContainer: async () => {
      throw new Error('SANDBOX_CONTROL_CONTAINER_REAPPEARED');
    }
  });
}
