import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { buildProcessTreeStopCommand } from '../../server/process-control.ts';
import { processIdentityMatches } from '../../server/process-state.ts';
import type { ProcessIdentity } from '../../server/process-state.ts';
import type {
  SandboxControlExecution,
  SandboxControlManifest,
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

async function waitForStartupTransition(root: string, timeoutMs: number): Promise<void> {
  const transitionPath = path.join(root, BROKER_STARTING_FILE);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const transition = readStartupOwner(transitionPath);
    if (!fs.existsSync(transitionPath)) return;
    if (transition && !ownerLive(transition.owner)) {
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
  timeoutMs = 5_000
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
      if (transition && !ownerLive(transition.owner)) {
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

export function readSandboxControlManifest(manifestPath: string): SandboxControlManifest {
  if (!regularFile(manifestPath)) throw new Error('SANDBOX_CONTROL_MANIFEST_INVALID');
  let manifest: Partial<SandboxControlManifest>;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Partial<SandboxControlManifest>;
  } catch {
    throw new Error('SANDBOX_CONTROL_MANIFEST_INVALID');
  }
  if (manifest.version !== 4) {
    throw new Error('SANDBOX_CONTROL_MANIFEST_VERSION_INVALID: expected version 4; container-only recreation is required');
  }
  if (typeof manifest.engine !== 'string' || manifest.engine.length === 0
    || typeof manifest.repoRoot !== 'string' || typeof manifest.worktreeRoot !== 'string'
    || typeof manifest.project !== 'string' || typeof manifest.container !== 'string'
    || !manifest.containerIdentity || typeof manifest.containerIdentity.id !== 'string'
    || manifest.containerIdentity.id.length === 0 || !manifest.containerIdentity.labels
    || typeof manifest.containerIdentity.labels !== 'object'
    || Array.isArray(manifest.containerIdentity.labels)
    || Object.values(manifest.containerIdentity.labels).some((value) => typeof value !== 'string')
    || typeof manifest.branch !== 'string' || !['task-bound', 'branch-only'].includes(manifest.mode ?? '')
    || (manifest.taskId !== null && typeof manifest.taskId !== 'string')
    || typeof manifest.channelDir !== 'string' || typeof manifest.publicStatusDir !== 'string'
    || typeof manifest.processingDir !== 'string' || typeof manifest.token !== 'string'
    || typeof manifest.generation !== 'string') throw new Error('SANDBOX_CONTROL_MANIFEST_INVALID');
  const root = path.dirname(path.resolve(manifestPath));
  if (path.resolve(manifest.channelDir) !== path.join(root, 'channel')
    || path.resolve(manifest.publicStatusDir) !== path.join(root, 'public')
    || path.resolve(manifest.processingDir) !== path.join(root, 'processing')) {
    throw new Error('SANDBOX_CONTROL_MANIFEST_INVALID');
  }
  return manifest as SandboxControlManifest;
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

function ownerLive(owner: OwnerIdentity): boolean {
  return processIdentityMatches({ pid: owner.pid, startTime: owner.startTime });
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

function processGroupAlive(groupId: number): boolean {
  try {
    const rows = execFileSync('ps', ['-axo', 'pgid=,stat='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return rows.split('\n').some((row) => {
      const match = row.trim().match(/^(\d+)\s+(\S+)/);
      return Number(match?.[1]) === groupId && !match?.[2]?.startsWith('Z');
    });
  } catch {
    try {
      process.kill(-groupId, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
  }
}

function executionAlive(execution: SandboxControlExecution, platform: NodeJS.Platform): boolean {
  if (platform !== 'win32' && execution.child.processGroupId) {
    return processGroupAlive(execution.child.processGroupId);
  }
  return processIdentityMatches({ pid: execution.child.pid, startTime: execution.child.startTime });
}

async function waitForExit(owner: OwnerIdentity, timeoutMs: number, deadlineAt?: number): Promise<boolean> {
  const deadline = deadlineAt ?? (Date.now() + timeoutMs);
  while (Date.now() < deadline) {
    if (!ownerLive(owner)) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return !ownerLive(owner);
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
  options: { platform?: NodeJS.Platform; timeoutMs?: number; timing?: SandboxControlTimingPolicy } = {}
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
  const deadlineAt = Date.now() + timeoutMs;
  const forceAt = forceDeadline(deadlineAt, timeoutMs);
  markSandboxControlRootQuiescing(resolvedRoot);
  await waitForStartupTransition(resolvedRoot, Math.max(0, forceAt - Date.now()));

  const manifestPath = path.join(resolvedRoot, 'manifest.json');
  const manifest = fs.existsSync(manifestPath) ? readSandboxControlManifest(manifestPath) : null;
  const broker = readBrokerOwner(path.join(resolvedRoot, 'broker.json'));
  const status = readStatusOwner(path.join(resolvedRoot, 'public', 'status.json'));
  const statusOwner = status ? status.broker : null;
  const brokerLive = broker ? ownerLive(broker) : false;
  const statusLive = statusOwner ? ownerLive(statusOwner) : false;

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
      terminateSandboxControlExecution(execution, { platform, timeoutMs: 0, allowForce: false });
    }
    const softDeadlineAt = Math.min(forceAt, Date.now() + Math.floor(Math.max(0, forceAt - Date.now()) / 2));
    while (Date.now() < softDeadlineAt) {
      if (!executions.some((execution) => executionAlive(execution, platform))) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (manifest) executions = mergeExecutions(executions, readExecutions(manifest));
    if (Date.now() >= deadlineAt) throw new Error('SANDBOX_CONTROL_QUIESCE_DEADLINE_EXCEEDED');
    for (const execution of executions) {
      if (!terminateSandboxControlExecution(execution, {
        platform, timeoutMs: Math.max(0, deadlineAt - Date.now()), deadlineAt, forceAt: Date.now()
      })) {
        throw new Error(`SANDBOX_CONTROL_EXECUTION_STILL_RUNNING: ${execution.requestId}`);
      }
    }
    if (executions.some((execution) => executionAlive(execution, platform))) {
      throw new Error('SANDBOX_CONTROL_EXECUTION_STILL_RUNNING');
    }
    return broker || status ? 'stale' : 'missing';
  }

  const remaining = (): number => Math.max(0, deadlineAt - Date.now());
  signalOwner(owner, platform, false);
  for (const execution of executions) {
    terminateSandboxControlExecution(execution, { platform, timeoutMs: 0, allowForce: false });
  }
  const softDeadlineAt = Math.min(forceAt, Date.now() + Math.floor(Math.max(0, forceAt - Date.now()) / 2));
  while (Date.now() < softDeadlineAt) {
    if (!ownerLive(owner) && !executions.some((execution) => executionAlive(execution, platform))) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (!ownerLive(owner) && !executions.some((execution) => executionAlive(execution, platform))) {
    return 'stopped';
  }
  if (manifest) executions = mergeExecutions(executions, readExecutions(manifest));
  if (Date.now() >= deadlineAt) throw new Error('SANDBOX_CONTROL_QUIESCE_DEADLINE_EXCEEDED');
  for (const execution of executions) {
    terminateSandboxControlExecution(execution, { platform, timeoutMs: 0, deadlineAt, forceAt: Date.now() });
  }
  signalOwner(owner, platform, true);
  while (Date.now() < deadlineAt) {
    if (!ownerLive(owner) && !executions.some((execution) => executionAlive(execution, platform))) return 'stopped';
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (ownerLive(owner)) throw new Error('SANDBOX_CONTROL_BROKER_STILL_RUNNING');
  if (executions.some((execution) => executionAlive(execution, platform))) throw new Error('SANDBOX_CONTROL_EXECUTION_STILL_RUNNING');
  return 'stopped';
}

export type RemoveSandboxControlOptions = Readonly<{
  platform?: NodeJS.Platform;
  timeoutMs?: number;
  timing?: SandboxControlTimingPolicy;
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
  const manifest = readSandboxControlManifest(manifestPath);
  const inspectContainer = options.inspectContainer
    ?? ((timeoutMs) => inspectSandboxControlContainer(manifest, { timeoutMs }));
  const timeoutMs = options.timeoutMs ?? options.timing?.quiesceDeadlineMs ?? DEFAULT_QUIESCE_TIMEOUT_MS;
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
  await waitForStartupTransition(resolvedRoot, Math.max(0, forceAt - Date.now()));
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
    && (ownerLive(broker) || ownerLive(status.broker))) {
    throw new Error('SANDBOX_CONTROL_OWNER_MISMATCH');
  }
  const platform = options.platform ?? process.platform;
  const owner = broker && ownerLive(broker) ? broker
    : status && ownerLive(status.broker) ? status.broker : null;
  const selfOwner = options.selfOwner;
  const selfOwned = Boolean(selfOwner && broker && sameOwner(broker, selfOwner));
  if (selfOwner && (!broker || !selfOwned || broker.token !== manifest.token || broker.generation !== manifest.generation)) {
    throw new Error('SANDBOX_CONTROL_OWNER_TRANSITION');
  }
  let executions = readExecutions(manifest);
  if (owner && !selfOwned) signalOwner(owner, platform, false);
  for (const execution of executions) {
    terminateSandboxControlExecution(execution, { platform, timeoutMs: 0, allowForce: false });
  }
  const softDeadlineAt = Math.min(forceAt, Date.now() + Math.floor(Math.max(0, forceAt - Date.now()) / 2));
  while (Date.now() < softDeadlineAt) {
    if ((!owner || selfOwned || !ownerLive(owner)) && !executions.some((execution) => executionAlive(execution, platform))) break;
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

  const currentManifest = readSandboxControlManifest(manifestPath);
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
  if (!owner && currentBroker && ownerLive(currentBroker)) {
    throw new Error('SANDBOX_CONTROL_OWNER_REPLACED');
  }
  if (owner && ownerLive(owner) && !currentBroker) {
    throw new Error('SANDBOX_CONTROL_OWNER_EVIDENCE_MISSING');
  }

  executions = mergeExecutions(executions, readExecutions(manifest));
  if (Date.now() >= deadlineAt) throw new Error('SANDBOX_CONTROL_REMOVE_DEADLINE_EXCEEDED');
  for (const execution of executions) {
    if (!terminateSandboxControlExecution(execution, {
      platform, timeoutMs: remaining(), deadlineAt, forceAt: Date.now()
    })) {
      throw new Error(`SANDBOX_CONTROL_EXECUTION_STILL_RUNNING: ${execution.requestId}`);
    }
  }
  if (owner && currentBroker && ownerLive(currentBroker) && !selfOwned) {
    if (remaining() <= 0) throw new Error('SANDBOX_CONTROL_REMOVE_DEADLINE_EXCEEDED');
    signalOwner(currentBroker, platform, true);
    if (remaining() <= 0 || !await waitForExit(currentBroker, remaining(), deadlineAt)) {
      throw new Error('SANDBOX_CONTROL_BROKER_STILL_RUNNING');
    }
  }

  const finalExecutions = mergeExecutions(executions, readExecutions(manifest));
  if (finalExecutions.some((execution) => executionAlive(execution, platform))) {
    throw new Error('SANDBOX_CONTROL_EXECUTION_STILL_RUNNING');
  }

  const finalBrokerRaw = fs.existsSync(brokerPath) ? fs.readFileSync(brokerPath, 'utf8') : null;
  if (finalBrokerRaw !== null) {
    const finalBroker = readBrokerOwner(brokerPath);
    if (!finalBroker) throw new Error('SANDBOX_CONTROL_OWNER_MISMATCH');
    const finalSelfOwner = Boolean(selfOwner && sameOwner(finalBroker, selfOwner)
      && finalBroker.token === manifest.token && finalBroker.generation === manifest.generation);
    if (ownerLive(finalBroker) && !finalSelfOwner) throw new Error('SANDBOX_CONTROL_BROKER_STILL_RUNNING');
    if (fs.readFileSync(brokerPath, 'utf8') !== finalBrokerRaw) {
      throw new Error('SANDBOX_CONTROL_OWNER_TRANSITION');
    }
    fs.unlinkSync(brokerPath);
  }
  const finalStatusRaw = fs.existsSync(statusPath) ? fs.readFileSync(statusPath, 'utf8') : null;
  if (finalStatusRaw !== null) {
    const finalStatus = readStatusOwner(statusPath);
    if (!finalStatus) throw new Error('SANDBOX_CONTROL_OWNER_MISMATCH');
    if (ownerLive(finalStatus.broker) && !(selfOwner && sameOwner(finalStatus.broker, selfOwner))) {
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
