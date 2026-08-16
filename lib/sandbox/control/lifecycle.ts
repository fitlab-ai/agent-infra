import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { buildProcessTreeStopCommand } from '../../server/process-control.ts';
import { processIdentityMatches } from '../../server/process-state.ts';
import type {
  SandboxControlExecution,
  SandboxControlManifest,
  SandboxControlStatus
} from './protocol.ts';
import {
  parseSandboxControlStatus,
  readExecution,
  terminateSandboxControlExecution
} from './state.ts';

type OwnerIdentity = Readonly<{ pid: number; startTime: string }>;
type BrokerOwner = OwnerIdentity & Readonly<{ version: 2; token: string; generation: string }>;

const DEFAULT_QUIESCE_TIMEOUT_MS = 7_000;

function regularFile(filePath: string): boolean {
  try {
    const stat = fs.lstatSync(filePath);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export function readSandboxControlManifest(manifestPath: string): SandboxControlManifest {
  if (!regularFile(manifestPath)) throw new Error('SANDBOX_CONTROL_MANIFEST_INVALID');
  let manifest: Partial<SandboxControlManifest>;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Partial<SandboxControlManifest>;
  } catch {
    throw new Error('SANDBOX_CONTROL_MANIFEST_INVALID');
  }
  if (manifest.version !== 3) {
    throw new Error('SANDBOX_CONTROL_MANIFEST_VERSION_INVALID: expected version 3; container-only recreation is required');
  }
  if (typeof manifest.repoRoot !== 'string' || typeof manifest.worktreeRoot !== 'string'
    || typeof manifest.project !== 'string' || typeof manifest.container !== 'string'
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
  if (!owner || owner.version !== 2 || !Number.isSafeInteger(owner.pid) || (owner.pid ?? 0) <= 0
    || typeof owner.startTime !== 'string' || typeof owner.token !== 'string'
    || typeof owner.generation !== 'string') throw new Error('SANDBOX_CONTROL_OWNER_MISMATCH');
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
  return left.pid === right.pid && left.startTime === right.startTime;
}

function ownerLive(owner: OwnerIdentity): boolean {
  return processIdentityMatches({ version: 1, pid: owner.pid, startTime: owner.startTime });
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
  return processIdentityMatches({ version: 1, pid: execution.child.pid, startTime: execution.child.startTime });
}

async function waitForExit(owner: OwnerIdentity, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
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
  options: { platform?: NodeJS.Platform; timeoutMs?: number } = {}
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

  const manifestPath = path.join(resolvedRoot, 'manifest.json');
  const manifest = fs.existsSync(manifestPath) ? readSandboxControlManifest(manifestPath) : null;
  const broker = readBrokerOwner(path.join(resolvedRoot, 'broker.json'));
  const status = readStatusOwner(path.join(resolvedRoot, 'public', 'status.json'));
  const statusOwner = status ? { version: 1 as const, ...status.broker } : null;
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

  const owner: OwnerIdentity | null = brokerLive ? broker : statusLive ? statusOwner : null;
  if (!owner) {
    if (manifest && !broker && !status) throw new Error('SANDBOX_CONTROL_OWNER_EVIDENCE_MISSING');
    return broker || status ? 'stale' : 'missing';
  }

  const platform = options.platform ?? process.platform;
  const timeoutMs = options.timeoutMs ?? DEFAULT_QUIESCE_TIMEOUT_MS;
  let executions = manifest ? readExecutions(manifest) : [];
  signalOwner(owner, platform, false);
  if (await waitForExit(owner, timeoutMs)) {
    if (executions.some((execution) => executionAlive(execution, platform))) {
      throw new Error('SANDBOX_CONTROL_EXECUTION_STILL_RUNNING');
    }
    return 'stopped';
  }

  if (manifest) executions = mergeExecutions(executions, readExecutions(manifest));
  for (const execution of executions) {
    if (!terminateSandboxControlExecution(execution, { platform, timeoutMs })) {
      throw new Error(`SANDBOX_CONTROL_EXECUTION_STILL_RUNNING: ${execution.requestId}`);
    }
  }
  signalOwner(owner, platform, true);
  if (!await waitForExit(owner, timeoutMs)) throw new Error('SANDBOX_CONTROL_BROKER_STILL_RUNNING');
  if (executions.some((execution) => executionAlive(execution, platform))) {
    throw new Error('SANDBOX_CONTROL_EXECUTION_STILL_RUNNING');
  }
  return 'stopped';
}
