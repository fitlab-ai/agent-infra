import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildProcessTreeStopCommand } from '../../server/process-control.ts';
import { getProcessIdentityState } from '../../server/process-state.ts';
import type { ProcessIdentity, ProcessIdentityProbe } from '../../server/process-state.ts';
import type {
  SandboxControlExecution,
  SandboxControlLease,
  SandboxControlManifestLike,
  SandboxControlStatus
} from './protocol.ts';

export const SANDBOX_CONTROL_AUDIT_MAX_BYTES = 1024 * 1024;
export const SANDBOX_CONTROL_EXECUTION_STOP_MS = 2_000;

function assertRegularFile(filePath: string): void {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('SANDBOX_CONTROL_STATE_INVALID');
}

export function atomicWriteJson(filePath: string, value: unknown, mode = 0o600, createParent = true): void {
  if (createParent) fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode, flag: 'wx' });
    fs.renameSync(temporary, filePath);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

export function readJsonFile(filePath: string): unknown {
  assertRegularFile(filePath);
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

export function statusPath(manifest: SandboxControlManifestLike): string {
  return path.join(manifest.publicStatusDir, 'status.json');
}

export function writeSandboxControlStatus(
  manifest: SandboxControlManifestLike,
  broker: ProcessIdentity & { brokerId: string },
  state: SandboxControlStatus['state'],
  reasonCode: string | null,
  activeRequestId: string | null,
  now = Date.now()
): SandboxControlStatus {
  const status: SandboxControlStatus = {
    version: 2, generation: manifest.generation, broker, state, reasonCode, activeRequestId, updatedAt: now
  };
  atomicWriteJson(statusPath(manifest), status, 0o600, false);
  return status;
}

export function parseSandboxControlStatus(value: unknown): SandboxControlStatus {
  const status = value as Partial<SandboxControlStatus> | null;
  if (!status || status.version !== 2 || typeof status.generation !== 'string'
    || !status.broker || !Number.isSafeInteger(status.broker.pid) || typeof status.broker.startTime !== 'number'
    || !Number.isSafeInteger(status.broker.startTime) || typeof status.broker.brokerId !== 'string'
    || status.broker.brokerId.length === 0
    || !['starting', 'healthy', 'busy', 'parked'].includes(status.state ?? '')
    || (status.reasonCode !== null && typeof status.reasonCode !== 'string')
    || (status.activeRequestId !== null && typeof status.activeRequestId !== 'string')
    || !Number.isSafeInteger(status.updatedAt)) throw new Error('SANDBOX_CONTROL_STATUS_INVALID');
  return status as SandboxControlStatus;
}

export function readSandboxControlStatus(directory: string): SandboxControlStatus {
  return parseSandboxControlStatus(readJsonFile(path.join(directory, 'status.json')));
}

export function readActiveLease(manifest: SandboxControlManifestLike, now = Date.now()): SandboxControlLease | null {
  const filePath = path.join(path.dirname(manifest.publicStatusDir), 'lease.json');
  if (!fs.existsSync(filePath)) return null;
  const lease = readJsonFile(filePath) as Partial<SandboxControlLease> | null;
  if (!lease || lease.version !== 2
    || typeof lease.nonce !== 'string' || !lease.owner || !Number.isSafeInteger(lease.owner.pid)
    || typeof lease.owner.startTime !== 'number' || !Number.isSafeInteger(lease.owner.startTime)
    || !Number.isSafeInteger(lease.issuedAt)
    || !Number.isSafeInteger(lease.expiresAt) || typeof lease.generation !== 'string'
    || (lease.taskId !== null && typeof lease.taskId !== 'string')
    || typeof lease.branch !== 'string' || typeof lease.reason !== 'string') {
    throw new Error('SANDBOX_CONTROL_LEASE_INVALID');
  }
  if (lease.generation !== manifest.generation || lease.expiresAt! <= now
    || lease.taskId !== manifest.taskId || lease.branch !== manifest.branch) return null;
  return lease as SandboxControlLease;
}

export function cleanupStaleSandboxControlLease(
  manifest: SandboxControlManifestLike,
  now = Date.now(),
  options: Readonly<{ identityProbe?: ProcessIdentityProbe }> = {}
): boolean {
  const filePath = path.join(path.dirname(manifest.publicStatusDir), 'lease.json');
  if (!fs.existsSync(filePath)) return false;
  const raw = fs.readFileSync(filePath, 'utf8');
  const lease = JSON.parse(raw) as Partial<SandboxControlLease> | null;
  if (!lease || lease.version !== 2
    || typeof lease.nonce !== 'string' || !lease.owner || !Number.isSafeInteger(lease.owner.pid)
    || typeof lease.owner.startTime !== 'number' || !Number.isSafeInteger(lease.owner.startTime)
    || !Number.isSafeInteger(lease.issuedAt)
    || !Number.isSafeInteger(lease.expiresAt) || typeof lease.generation !== 'string'
    || (lease.taskId !== null && typeof lease.taskId !== 'string')
    || typeof lease.branch !== 'string' || typeof lease.reason !== 'string') {
    throw new Error('SANDBOX_CONTROL_LEASE_INVALID');
  }
  const ownerState = (options.identityProbe ?? getProcessIdentityState)({
    pid: lease.owner.pid!, startTime: lease.owner.startTime!
  });
  if (ownerState === 'unknown') throw new Error('SANDBOX_CONTROL_LEASE_OWNER_UNAVAILABLE');
  const stale = lease.generation !== manifest.generation || lease.taskId !== manifest.taskId
    || lease.branch !== manifest.branch || lease.expiresAt! <= now || ownerState === 'dead';
  if (!stale) return false;
  if (fs.readFileSync(filePath, 'utf8') !== raw) throw new Error('SANDBOX_CONTROL_LEASE_OWNERSHIP_LOST');
  fs.unlinkSync(filePath);
  return true;
}

export function appendSandboxControlAudit(
  manifest: SandboxControlManifestLike,
  event: string,
  fields: Record<string, string | number | boolean | null> = {},
  now = Date.now()
): void {
  const auditPath = path.join(path.dirname(manifest.publicStatusDir), 'audit.ndjson');
  if (fs.existsSync(auditPath) && fs.statSync(auditPath).size >= SANDBOX_CONTROL_AUDIT_MAX_BYTES) {
    fs.rmSync(`${auditPath}.1`, { force: true });
    fs.renameSync(auditPath, `${auditPath}.1`);
  }
  fs.appendFileSync(auditPath, `${JSON.stringify({ version: 1, event, generation: manifest.generation, at: now, ...fields })}\n`, {
    encoding: 'utf8', mode: 0o600
  });
}

export function executionPath(manifest: SandboxControlManifestLike, requestId: string): string {
  return path.join(manifest.processingDir, requestId, 'execution.json');
}

export function readExecution(filePath: string): SandboxControlExecution {
  const execution = readJsonFile(filePath) as Partial<SandboxControlExecution> | null;
  if (!execution || execution.version !== 2 || typeof execution.generation !== 'string'
    || typeof execution.requestId !== 'string' || typeof execution.nonce !== 'string'
    || !execution.child || !Number.isSafeInteger(execution.child.pid) || typeof execution.child.startTime !== 'number'
    || !Number.isSafeInteger(execution.child.startTime)
    || !['prepared', 'running', 'terminating'].includes(execution.phase ?? '')
    || !Number.isSafeInteger(execution.updatedAt)) throw new Error('SANDBOX_CONTROL_EXECUTION_INVALID');
  return execution as SandboxControlExecution;
}

export function terminateSandboxControlExecution(
  execution: SandboxControlExecution,
  options: {
    platform?: NodeJS.Platform;
    timeoutMs?: number;
    deadlineAt?: number;
    forceAt?: number;
    allowForce?: boolean;
    identityProbe?: ProcessIdentityProbe;
  } = {}
): boolean {
  const platform = options.platform ?? process.platform;
  const processGroupId = execution.child.processGroupId;
  const processGroupState = (groupId: number): 'alive' | 'dead' | 'unknown' => {
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
  };
  const treeState = (): 'alive' | 'dead' | 'unknown' => {
    if (platform === 'win32' || !processGroupId) {
      return (options.identityProbe ?? getProcessIdentityState)({
        pid: execution.child.pid, startTime: execution.child.startTime
      });
    }
    return processGroupState(processGroupId);
  };
  const treeAlive = (): boolean => {
    const state = treeState();
    if (state === 'unknown') throw new Error('SANDBOX_CONTROL_EXECUTION_OWNER_UNAVAILABLE');
    return state === 'alive';
  };
  if (!treeAlive()) return true;
  const command = buildProcessTreeStopCommand(processGroupId ?? execution.child.pid, platform);
  try {
    if (command.kind === 'exec') execFileSync(command.command, command.args, { stdio: 'ignore' });
    else process.kill(command.pid, command.signal);
  } catch {
    // The identity check below distinguishes an already-exited tree from a failed termination.
  }
  const deadline = options.deadlineAt ?? (Date.now() + (options.timeoutMs ?? SANDBOX_CONTROL_EXECUTION_STOP_MS));
  const forceAt = options.forceAt ?? (options.deadlineAt === undefined
    ? deadline
    : Math.min(deadline, Date.now() + Math.floor(Math.max(0, deadline - Date.now()) / 2)));
  while (Date.now() < forceAt) {
    if (!treeAlive()) return true;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
  if (platform !== 'win32' && options.allowForce !== false
    && (options.deadlineAt === undefined || Date.now() < deadline)) {
    try {
      process.kill(processGroupId ? -processGroupId : execution.child.pid, 'SIGKILL');
    } catch {
      // The final identity check handles an already-exited tree.
    }
    const killDeadline = options.deadlineAt
      ?? (Date.now() + (options.timeoutMs ?? SANDBOX_CONTROL_EXECUTION_STOP_MS));
    while (Date.now() < killDeadline) {
      if (!treeAlive()) return true;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  return !treeAlive();
}
