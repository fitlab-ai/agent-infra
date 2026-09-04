import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { buildProcessTreeStopCommand } from '../../server/process-control.ts';
import { getProcessIdentityState } from '../../server/process-state.ts';
import type { ProcessIdentity, ProcessIdentityProbe } from '../../server/process-state.ts';
import type {
  SandboxControlExecution,
  SandboxControlLease,
  SandboxControlManifest,
  SandboxControlPayload,
  SandboxControlReservation,
  SandboxControlResultEvidence,
  SandboxControlStatus
} from './protocol.ts';
import {
  parseSandboxControlResultEvidence,
  parseSandboxControlPayload,
  parseSandboxControlReservation,
  SANDBOX_CONTROL_MAX_RESPONSE_BYTES,
  SANDBOX_CONTROL_MAX_LOGICAL_RECORDS,
  SANDBOX_CONTROL_MAX_TERMINAL_RECORD_BYTES,
  SANDBOX_CONTROL_RESERVATION_BYTES
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

export function sandboxControlEncodedJsonBytes(value: unknown): number {
  return Buffer.byteLength(`${JSON.stringify(value)}\n`, 'utf8');
}

export function atomicWriteJsonNoReplace(
  filePath: string,
  value: unknown,
  mode = 0o600,
  createParent = true
): void {
  atomicCreateJson(filePath, value, 'SANDBOX_CONTROL_TERMINAL_ALREADY_EXISTS', mode, createParent);
}

function atomicCreateJson(
  filePath: string,
  value: unknown,
  duplicateCode: string,
  mode = 0o600,
  createParent = true
): void {
  if (createParent) fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode, flag: 'wx' });
    try {
      fs.linkSync(temporary, filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new Error(duplicateCode);
      }
      throw error;
    }
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

export function readJsonFile(filePath: string): unknown {
  assertRegularFile(filePath);
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

export function resultEvidencePath(manifest: SandboxControlManifest, requestId: string): string {
  if (!/^[a-f0-9-]{16,64}$/u.test(requestId)) throw new Error('SANDBOX_CONTROL_RESULT_EVIDENCE_INVALID');
  return path.join(manifest.processingDir, requestId, 'result.json');
}

export function payloadPath(manifest: SandboxControlManifest, requestId: string): string {
  if (!/^[a-f0-9-]{16,64}$/u.test(requestId)) throw new Error('SANDBOX_CONTROL_PAYLOAD_INVALID');
  return path.join(manifest.channelDir, 'responses', `${requestId}.payload.json`);
}

export function reservationPath(manifest: SandboxControlManifest, requestId: string): string {
  if (!/^[a-f0-9-]{16,64}$/u.test(requestId)) throw new Error('SANDBOX_CONTROL_RESERVATION_INVALID');
  return path.join(manifest.processingDir, requestId, 'reservation.json');
}

export function readSandboxControlResultEvidence(filePath: string): SandboxControlResultEvidence {
  assertRegularFile(filePath);
  const raw = fs.readFileSync(filePath, 'utf8');
  if (Buffer.byteLength(raw, 'utf8') > SANDBOX_CONTROL_MAX_TERMINAL_RECORD_BYTES) {
    throw new Error('SANDBOX_CONTROL_RESULT_EVIDENCE_TOO_LARGE');
  }
  try {
    return parseSandboxControlResultEvidence(JSON.parse(raw));
  } catch (error) {
    if (error instanceof Error && error.message === 'SANDBOX_CONTROL_RESULT_EVIDENCE_INVALID') throw error;
    throw new Error('SANDBOX_CONTROL_RESULT_EVIDENCE_INVALID');
  }
}

export function sanitizeSandboxControlOutput(manifest: SandboxControlManifest, output: string): string {
  return manifest.token.length === 0 ? output : output.split(manifest.token).join('[REDACTED]');
}

export function sanitizeSandboxControlResult(
  manifest: SandboxControlManifest,
  result: Readonly<{ exitCode: number; stdout: string; stderr: string }>
): { exitCode: number; stdout: string; stderr: string } {
  return {
    exitCode: result.exitCode,
    stdout: sanitizeSandboxControlOutput(manifest, result.stdout),
    stderr: sanitizeSandboxControlOutput(manifest, result.stderr)
  };
}

export function writeSandboxControlResultEvidence(
  manifest: SandboxControlManifest,
  requestId: string,
  result: Readonly<{ exitCode: number; stdout: string; stderr: string }>
): SandboxControlResultEvidence {
  const normalized = sanitizeSandboxControlResult(manifest, result);
  const stdout = normalized.stdout;
  const stderr = normalized.stderr;
  if (!/^[a-f0-9-]{16,64}$/u.test(requestId)
    || !Number.isSafeInteger(result.exitCode)
    || Buffer.byteLength(stdout, 'utf8') + Buffer.byteLength(stderr, 'utf8') > SANDBOX_CONTROL_MAX_RESPONSE_BYTES) {
    throw new Error('SANDBOX_CONTROL_RESULT_EVIDENCE_INVALID');
  }
  const evidence: SandboxControlResultEvidence = {
    version: 1,
    id: requestId,
    generation: manifest.generation,
    exitCode: result.exitCode,
    stdoutBytes: Buffer.byteLength(stdout, 'utf8'),
    stderrBytes: Buffer.byteLength(stderr, 'utf8'),
    stdoutSha256: createHash('sha256').update(stdout, 'utf8').digest('hex'),
    stderrSha256: createHash('sha256').update(stderr, 'utf8').digest('hex'),
    captureState: 'metadata-only'
  };
  if (sandboxControlEncodedJsonBytes(evidence) > SANDBOX_CONTROL_MAX_TERMINAL_RECORD_BYTES) {
    throw new Error('SANDBOX_CONTROL_RESULT_EVIDENCE_TOO_LARGE');
  }
  atomicCreateJson(
    resultEvidencePath(manifest, requestId), evidence,
    'SANDBOX_CONTROL_RESULT_EVIDENCE_ALREADY_EXISTS'
  );
  return readSandboxControlResultEvidence(resultEvidencePath(manifest, requestId));
}

export function writeSandboxControlPayload(
  manifest: SandboxControlManifest,
  requestId: string,
  result: Readonly<{ stdout: string; stderr: string }>
): SandboxControlPayload {
  const payload = createSandboxControlPayload(manifest, requestId, result);
  atomicCreateJson(payloadPath(manifest, requestId), payload, 'SANDBOX_CONTROL_PAYLOAD_ALREADY_EXISTS');
  return readSandboxControlPayload(payloadPath(manifest, requestId));
}

export function createSandboxControlPayload(
  manifest: SandboxControlManifest,
  requestId: string,
  result: Readonly<{ stdout: string; stderr: string }>
): SandboxControlPayload {
  const stdout = sanitizeSandboxControlOutput(manifest, result.stdout);
  const stderr = sanitizeSandboxControlOutput(manifest, result.stderr);
  const payload: SandboxControlPayload = {
    version: 1,
    id: requestId,
    generation: manifest.generation,
    stdout,
    stderr,
    stdoutBytes: Buffer.byteLength(stdout, 'utf8'),
    stderrBytes: Buffer.byteLength(stderr, 'utf8'),
    stdoutSha256: createHash('sha256').update(stdout, 'utf8').digest('hex'),
    stderrSha256: createHash('sha256').update(stderr, 'utf8').digest('hex')
  };
  if (payload.stdoutBytes + payload.stderrBytes > SANDBOX_CONTROL_MAX_RESPONSE_BYTES) {
    throw new Error('SANDBOX_CONTROL_PAYLOAD_TOO_LARGE');
  }
  if (sandboxControlEncodedJsonBytes(payload) > SANDBOX_CONTROL_MAX_RESPONSE_BYTES) {
    throw new Error('SANDBOX_CONTROL_PAYLOAD_TOO_LARGE');
  }
  return payload;
}

export function readSandboxControlPayload(filePath: string): SandboxControlPayload {
  assertRegularFile(filePath);
  const raw = fs.readFileSync(filePath, 'utf8');
  if (Buffer.byteLength(raw, 'utf8') > SANDBOX_CONTROL_MAX_RESPONSE_BYTES) {
    throw new Error('SANDBOX_CONTROL_PAYLOAD_TOO_LARGE');
  }
  try {
    return parseSandboxControlPayload(JSON.parse(raw));
  } catch {
    throw new Error('SANDBOX_CONTROL_PAYLOAD_INVALID');
  }
}

export function writeSandboxControlReservation(
  manifest: SandboxControlManifest,
  requestId: string,
  usage: Readonly<{ logicalRecords: number; bytes: number }>,
  now = Date.now()
): SandboxControlReservation {
  if (usage.logicalRecords >= SANDBOX_CONTROL_MAX_LOGICAL_RECORDS
    || usage.bytes + SANDBOX_CONTROL_RESERVATION_BYTES > SANDBOX_CONTROL_MAX_RESPONSE_BYTES) {
    throw new Error('SANDBOX_CONTROL_CAPACITY_EXHAUSTED');
  }
  const reservation: SandboxControlReservation = {
    version: 1,
    id: requestId,
    generation: manifest.generation,
    logicalRecords: 1,
    bytes: SANDBOX_CONTROL_RESERVATION_BYTES,
    createdAt: now
  };
  atomicCreateJson(reservationPath(manifest, requestId), reservation, 'SANDBOX_CONTROL_RESERVATION_ALREADY_EXISTS');
  return parseSandboxControlReservation(readJsonFile(reservationPath(manifest, requestId)));
}

export function readSandboxControlReservation(filePath: string): SandboxControlReservation {
  return parseSandboxControlReservation(readJsonFile(filePath));
}

export function sandboxControlGenerationUsage(manifest: SandboxControlManifest): { logicalRecords: number; bytes: number } {
  const records = new Map<string, { baseBytes: number; payloadBytes: number; logical: boolean }>();
  const responsesDir = path.join(manifest.channelDir, 'responses');
  if (fs.existsSync(responsesDir)) {
    for (const entry of fs.readdirSync(responsesDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const terminal = entry.name.match(/^([a-f0-9-]{16,64})\.json$/u);
      const accepted = entry.name.match(/^([a-f0-9-]{16,64})\.accepted\.json$/u);
      const payload = entry.name.match(/^([a-f0-9-]{16,64})\.payload\.json$/u);
      if (!terminal && !accepted && !payload) continue;
      const id = (terminal ?? accepted ?? payload)![1]!;
      const previous = records.get(id) ?? { baseBytes: 0, payloadBytes: 0, logical: false };
      const fileBytes = fs.statSync(path.join(responsesDir, entry.name)).size;
      if (payload) previous.payloadBytes += fileBytes;
      else previous.baseBytes += fileBytes;
      previous.logical ||= Boolean(terminal || accepted);
      records.set(id, previous);
    }
  }
  if (fs.existsSync(manifest.processingDir)) {
    for (const entry of fs.readdirSync(manifest.processingDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[a-f0-9-]{16,64}$/u.test(entry.name)) continue;
      const resultPath = resultEvidencePath(manifest, entry.name);
      const filePath = reservationPath(manifest, entry.name);
      const previous = records.get(entry.name) ?? { baseBytes: 0, payloadBytes: 0, logical: false };
      if (fs.existsSync(resultPath)) {
        const result = readSandboxControlResultEvidence(resultPath);
        if (result.id !== entry.name || result.generation !== manifest.generation) {
          throw new Error('SANDBOX_CONTROL_RESULT_EVIDENCE_INVALID');
        }
        previous.baseBytes += fs.statSync(resultPath).size;
        previous.logical = true;
      }
      if (fs.existsSync(filePath)) {
        const reservation = readSandboxControlReservation(filePath);
        previous.baseBytes = Math.max(previous.baseBytes, reservation.bytes);
        previous.logical = true;
      }
      records.set(entry.name, previous);
    }
  }
  return {
    logicalRecords: [...records.values()].filter((record) => record.logical).length,
    bytes: [...records.values()].reduce((total, record) => total + record.baseBytes + record.payloadBytes, 0)
  };
}

export function statusPath(manifest: SandboxControlManifest): string {
  return path.join(manifest.publicStatusDir, 'status.json');
}

export function writeSandboxControlStatus(
  manifest: SandboxControlManifest,
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

export function readActiveLease(manifest: SandboxControlManifest, now = Date.now()): SandboxControlLease | null {
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
  manifest: SandboxControlManifest,
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
  manifest: SandboxControlManifest,
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

export function executionPath(manifest: SandboxControlManifest, requestId: string): string {
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
