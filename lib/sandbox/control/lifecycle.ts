import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildProcessTreeStopCommand } from '../../server/process-control.ts';
import {
  getProcessIdentityState,
  getProcessStartTime
} from '../../server/process-state.ts';
import type { ProcessIdentity, ProcessIdentityProbe, ProcessIdentityState } from '../../server/process-state.ts';
import type {
  SandboxControlExecution,
  SandboxControlManifestLike,
  SandboxControlManifest,
  SandboxControlLegacyManifest,
  SandboxControlStatus,
  SandboxControlTimingPolicy
} from './protocol.ts';
import { DEFAULT_SANDBOX_CONTROL_TIMING } from './protocol.ts';
import { inspectSandboxControlContainer, type ContainerObservation } from './container-identity.ts';
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
  while (Date.now() < deadline) {
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
  if (fs.existsSync(manifestPath)) readSandboxControlManifestForTransition(manifestPath);
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

function readSandboxControlManifestValue(
  manifestPath: string,
  allowLegacy: boolean
): SandboxControlManifestLike {
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
  const candidate = manifest as Partial<SandboxControlManifest> & Partial<SandboxControlLegacyManifest>;
  if (candidate.version !== 4 && candidate.version !== 5) {
    throw new Error('SANDBOX_CONTROL_MANIFEST_VERSION_INVALID: expected version 5; container-only recreation is required');
  }
  if (typeof candidate.containerIdentity !== 'object' || candidate.containerIdentity === null
    || Array.isArray(candidate.containerIdentity)) throw new Error('SANDBOX_CONTROL_MANIFEST_INVALID');
  const containerIdentity = candidate.containerIdentity as Record<string, unknown>;
  if (typeof candidate.engine !== 'string' || candidate.engine.length === 0
    || typeof candidate.repoRoot !== 'string' || typeof candidate.worktreeRoot !== 'string'
    || typeof candidate.project !== 'string' || typeof candidate.container !== 'string'
    || typeof containerIdentity.id !== 'string' || containerIdentity.id.length === 0
    || typeof containerIdentity.labels !== 'object' || containerIdentity.labels === null
    || Array.isArray(containerIdentity.labels)
    || Object.values(containerIdentity.labels).some((value) => typeof value !== 'string')
    || typeof candidate.branch !== 'string' || !['task-bound', 'branch-only'].includes(candidate.mode ?? '')
    || (candidate.taskId !== null && typeof candidate.taskId !== 'string')
    || typeof candidate.channelDir !== 'string' || typeof candidate.publicStatusDir !== 'string'
    || typeof candidate.processingDir !== 'string' || typeof candidate.token !== 'string'
    || typeof candidate.generation !== 'string') throw new Error('SANDBOX_CONTROL_MANIFEST_INVALID');
  const root = path.dirname(path.resolve(manifestPath));
  if (path.resolve(candidate.channelDir) !== path.join(root, 'channel')
    || path.resolve(candidate.publicStatusDir) !== path.join(root, 'public')
    || path.resolve(candidate.processingDir) !== path.join(root, 'processing')) {
    throw new Error('SANDBOX_CONTROL_MANIFEST_INVALID');
  }
  if (candidate.version === 4) {
    if (!allowLegacy) {
      throw new Error('SANDBOX_CONTROL_MANIFEST_VERSION_INVALID: expected version 5; container-only recreation is required');
    }
    return candidate as unknown as SandboxControlLegacyManifest;
  }
  if (typeof candidate.runtimeDir !== 'string' || path.resolve(candidate.runtimeDir) !== path.join(root, 'runtime')) {
    throw new Error('SANDBOX_CONTROL_MANIFEST_INVALID');
  }
  return candidate as unknown as SandboxControlManifest;
}

export function readSandboxControlManifest(manifestPath: string): SandboxControlManifest {
  return readSandboxControlManifestValue(manifestPath, false) as SandboxControlManifest;
}

export function readSandboxControlManifestForTransition(manifestPath: string): SandboxControlManifestLike {
  return readSandboxControlManifestValue(manifestPath, true);
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

function readExecutions(manifest: SandboxControlManifestLike): SandboxControlExecution[] {
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
  const manifest = fs.existsSync(manifestPath) ? readSandboxControlManifestForTransition(manifestPath) : null;
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
  const manifest = readSandboxControlManifestForTransition(manifestPath);
  const inspectContainer = options.inspectContainer
    ?? ((timeoutMs) => inspectSandboxControlContainer(manifest, { timeoutMs }));
  const timeoutMs = options.timeoutMs ?? options.timing?.quiesceDeadlineMs ?? DEFAULT_QUIESCE_TIMEOUT_MS;
  const identityProbe = options.identityProbe ?? getProcessIdentityState;
  const deadlineAt = Date.now() + timeoutMs;
  const forceAt = forceDeadline(deadlineAt, timeoutMs);
  const remaining = (): number => Math.max(0, deadlineAt - Date.now());
  const observation = await awaitWithDeadline(
    () => inspectContainer(remaining()), deadlineAt, 'SANDBOX_CONTROL_REMOVE_DEADLINE_EXCEEDED'
  );
  if (observation.state === 'unknown') throw new Error(`SANDBOX_CONTROL_CONTAINER_UNKNOWN: ${observation.reason}`);
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
    if (Date.now() >= deadlineAt) throw new Error('SANDBOX_CONTROL_REMOVE_DEADLINE_EXCEEDED');
    await awaitWithDeadline(
      () => options.removeContainer(remaining()),
      deadlineAt,
      'SANDBOX_CONTROL_REMOVE_DEADLINE_EXCEEDED'
    );
    const afterRemoval = await awaitWithDeadline(
      () => inspectContainer(remaining()),
      deadlineAt,
      'SANDBOX_CONTROL_REMOVE_DEADLINE_EXCEEDED'
    );
    if (afterRemoval.state !== 'absent') {
      throw new Error(afterRemoval.state === 'unknown'
        ? `SANDBOX_CONTROL_CONTAINER_UNKNOWN: ${afterRemoval.reason}`
        : 'SANDBOX_CONTROL_CONTAINER_STILL_EXISTS');
    }
  }

  const currentManifest = readSandboxControlManifestForTransition(manifestPath);
  if (currentManifest.token !== manifest.token || currentManifest.generation !== manifest.generation
    || !isSandboxControlRootQuiescing(resolvedRoot)) {
    throw new Error('SANDBOX_CONTROL_OWNER_TRANSITION');
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
  fs.rmSync(resolvedRoot, { recursive: true, force: true });
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
