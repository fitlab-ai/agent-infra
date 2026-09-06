import { createHash } from 'node:crypto';
import { validateTaskCreateCandidate, type TaskCreateCandidateV1 } from '../../task/create.ts';
import { normalizeAgentToken } from '../../agent-clients/tokens.ts';
import type { ProcessIdentity } from '../../server/process-state.ts';
import type { CodexControllerLeaseProofV1 } from './controller-registration.ts';
import type { SandboxAuthorityEvidenceV1 } from '../engines/authority.ts';
import type { SandboxTaskView } from './task-view.ts';

export const SANDBOX_CONTROL_MAX_BYTES = 64 * 1024;
export const SANDBOX_CONTROL_MAX_LOGICAL_RECORDS = 1024;
export const SANDBOX_CONTROL_MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
export const SANDBOX_CONTROL_MAX_TERMINAL_RECORD_BYTES = 1024 * 1024;
export const SANDBOX_CONTROL_RESERVATION_BYTES = SANDBOX_CONTROL_MAX_TERMINAL_RECORD_BYTES + 4 * 1024;
export const SANDBOX_CONTROL_ADMISSION_WINDOW_MS = 2_000;
export const SANDBOX_CONTROL_STATUS_INTERVAL_MS = 250;
export const SANDBOX_CONTROL_STATUS_STALE_MS = 1_500;
export const SANDBOX_CONTROL_FUTURE_SKEW_MS = 1_000;
export const SANDBOX_CONTROL_FAMILIES = ['task-lifecycle', 'task-orchestration', 'task-finalization', 'task-create', 'codex-controller'] as const;
export type SandboxControlTimingPolicy = Readonly<{
  controlTickMs: number;
  parkedBindingInitialMs: number;
  slowCheckMs: number;
  containerHeartbeatMs: number;
  quiesceDeadlineMs: number;
}>;
export const DEFAULT_SANDBOX_CONTROL_TIMING: SandboxControlTimingPolicy = Object.freeze({
  controlTickMs: 250,
  parkedBindingInitialMs: 1_000,
  slowCheckMs: 5_000,
  containerHeartbeatMs: 5_000,
  quiesceDeadlineMs: 7_000
} as const);

export type SandboxControlFamily = typeof SANDBOX_CONTROL_FAMILIES[number];
export type SandboxControlContainerIdentity = Readonly<{
  id: string;
  labels: Readonly<Record<string, string>>;
}>;
export type SandboxControlManifestBase = Readonly<{
  engine: string; repoRoot: string; worktreeRoot: string; project: string; container: string;
  containerIdentity: SandboxControlContainerIdentity;
  authorityEvidence: SandboxAuthorityEvidenceV1;
  branch: string; mode: 'task-bound' | 'branch-only'; taskId: string | null; token: string;
  generation: string; channelDir: string; publicStatusDir: string; processingDir: string;
}>;
export type SandboxControlManifest = SandboxControlManifestBase & Readonly<{ runtimeDir: string }>;
export type SandboxControlBrokerOwner = ProcessIdentity & Readonly<{
  version: 3;
  brokerId: string;
  token: string;
  generation: string;
}>;
type RequestBase = Readonly<{
  version: 3; id: string; token: string; generation: string; issuedAt: number; expiresAt: number;
  controllerProcess: ProcessIdentity | null;
  controllerProof: CodexControllerLeaseProofV1 | null;
}>;
export type SandboxTaskCommandRequest = RequestBase & Readonly<{
  family: 'task-lifecycle' | 'task-orchestration'; args: string[];
}>;
export type SandboxTaskFinalizationRequest = RequestBase & Readonly<{
  family: 'task-finalization'; operation: 'complete'; agent: string; args: [];
}>;
export type SandboxTaskCreateRequest = RequestBase & Readonly<{
  family: 'task-create'; candidate: TaskCreateCandidateV1;
}>;
export type SandboxCodexControllerRequest = RequestBase & Readonly<{
  family: 'codex-controller';
  command: 'open' | 'close' | 'verify';
  args: [];
}>;
export type SandboxControlRequest = SandboxTaskCommandRequest | SandboxTaskFinalizationRequest | SandboxTaskCreateRequest | SandboxCodexControllerRequest;
export type SandboxControlError = Readonly<{ code: string; message: string; retryable: boolean }>;
export type SandboxControlResultEvidence = Readonly<{
  version: 1;
  id: string;
  generation: string;
  exitCode: number;
  stdoutBytes: number;
  stderrBytes: number;
  stdoutSha256: string;
  stderrSha256: string;
  captureState: 'metadata-only';
}>;
export type SandboxControlPayloadReference = Readonly<{
  version: 1;
  id: string;
  generation: string;
  stdoutBytes: number;
  stderrBytes: number;
  stdoutSha256: string;
  stderrSha256: string;
}>;
export type SandboxControlPayload = SandboxControlPayloadReference & Readonly<{
  stdout: string;
  stderr: string;
}>;
export type SandboxControlReservation = Readonly<{
  version: 1;
  id: string;
  generation: string;
  logicalRecords: 1;
  bytes: number;
  createdAt: number;
}>;
export type SandboxControlResponse = Readonly<{
  version: 2; id: string; phase: 'accepted' | 'completed' | 'rejected'; exitCode: number | null;
  stdout: string; stderr: string; error: SandboxControlError | null;
  outputState?: 'available' | 'unavailable';
  payload?: SandboxControlPayloadReference | null;
}>;
export type SandboxControlStatus = Readonly<{
  version: 3; generation: string; broker: ProcessIdentity & { brokerId: string };
  state: 'starting' | 'healthy' | 'busy' | 'parked'; reasonCode: string | null;
  activeRequestId: string | null; updatedAt: number; taskView: SandboxTaskView;
}>;
export type SandboxControlLease = Readonly<{
  version: 2; generation: string; nonce: string; owner: ProcessIdentity;
  issuedAt: number; expiresAt: number; taskId: string | null; branch: string; reason: string;
}>;
export type SandboxControlExecution = Readonly<{
  version: 2; generation: string; requestId: string; nonce: string;
  child: ProcessIdentity & { processGroupId: number | null };
  phase: 'prepared' | 'running' | 'terminating'; updatedAt: number;
}>;

export class SandboxControlProtocolError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  constructor(code: string, message: string, retryable = false) {
    super(`${code}: ${message}`);
    this.name = 'SandboxControlProtocolError';
    this.code = code;
    this.retryable = retryable;
  }
}

function fail(code: string, message: string, retryable = false): never {
  throw new SandboxControlProtocolError(code, message, retryable);
}

export function parseSandboxControlResultEvidence(value: unknown): SandboxControlResultEvidence {
  const evidence = value as Partial<SandboxControlResultEvidence> | null;
  const keys = evidence && typeof evidence === 'object' ? Object.keys(evidence).sort().join(',') : '';
  if (keys !== 'captureState,exitCode,generation,id,stderrBytes,stderrSha256,stdoutBytes,stdoutSha256,version'
    || evidence?.version !== 1
    || typeof evidence.id !== 'string' || !/^[a-f0-9-]{16,64}$/u.test(evidence.id)
    || typeof evidence.generation !== 'string' || evidence.generation.length === 0
    || !Number.isSafeInteger(evidence.exitCode)
    || !Number.isSafeInteger(evidence.stdoutBytes) || (evidence.stdoutBytes as number) < 0
    || !Number.isSafeInteger(evidence.stderrBytes) || (evidence.stderrBytes as number) < 0
    || (evidence.stdoutBytes as number) + (evidence.stderrBytes as number) > SANDBOX_CONTROL_MAX_RESPONSE_BYTES
    || typeof evidence.stdoutSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(evidence.stdoutSha256)
    || typeof evidence.stderrSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(evidence.stderrSha256)
    || evidence.captureState !== 'metadata-only') {
    throw new Error('SANDBOX_CONTROL_RESULT_EVIDENCE_INVALID');
  }
  return evidence as SandboxControlResultEvidence;
}

function validPayloadReference(value: unknown, id: string, generation: string): value is SandboxControlPayloadReference {
  const payload = value as Partial<SandboxControlPayloadReference> | null;
  const keys = payload && typeof payload === 'object' ? Object.keys(payload).sort().join(',') : '';
  return keys === 'generation,id,stderrBytes,stderrSha256,stdoutBytes,stdoutSha256,version'
    && payload?.version === 1
    && payload.id === id
    && payload.generation === generation
    && Number.isSafeInteger(payload.stdoutBytes) && (payload.stdoutBytes as number) >= 0
    && Number.isSafeInteger(payload.stderrBytes) && (payload.stderrBytes as number) >= 0
    && (payload.stdoutBytes as number) + (payload.stderrBytes as number) <= SANDBOX_CONTROL_MAX_RESPONSE_BYTES
    && typeof payload.stdoutSha256 === 'string' && /^[a-f0-9]{64}$/u.test(payload.stdoutSha256)
    && typeof payload.stderrSha256 === 'string' && /^[a-f0-9]{64}$/u.test(payload.stderrSha256);
}

export function parseSandboxControlPayload(value: unknown): SandboxControlPayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('SANDBOX_CONTROL_PAYLOAD_INVALID');
  const payload = value as Partial<SandboxControlPayload>;
  const reference: Partial<SandboxControlPayloadReference> = {
    version: payload.version,
    id: payload.id,
    generation: payload.generation,
    stdoutBytes: payload.stdoutBytes,
    stderrBytes: payload.stderrBytes,
    stdoutSha256: payload.stdoutSha256,
    stderrSha256: payload.stderrSha256
  };
  const keys = Object.keys(payload).sort().join(',');
  if (keys !== 'generation,id,stderr,stderrBytes,stderrSha256,stdout,stdoutBytes,stdoutSha256,version'
    || !validPayloadReference(reference, reference.id as string, reference.generation as string)
    || typeof payload.stdout !== 'string' || typeof payload.stderr !== 'string'
    || Buffer.byteLength(payload.stdout, 'utf8') !== payload.stdoutBytes
    || Buffer.byteLength(payload.stderr, 'utf8') !== payload.stderrBytes
    || createHash('sha256').update(payload.stdout, 'utf8').digest('hex') !== payload.stdoutSha256
    || createHash('sha256').update(payload.stderr, 'utf8').digest('hex') !== payload.stderrSha256) {
    throw new Error('SANDBOX_CONTROL_PAYLOAD_INVALID');
  }
  return payload as SandboxControlPayload;
}

export function parseSandboxControlReservation(value: unknown): SandboxControlReservation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('SANDBOX_CONTROL_RESERVATION_INVALID');
  const reservation = value as Partial<SandboxControlReservation>;
  const keys = Object.keys(reservation).sort().join(',');
  if (keys !== 'bytes,createdAt,generation,id,logicalRecords,version'
    || reservation.version !== 1
    || typeof reservation.id !== 'string' || !/^[a-f0-9-]{16,64}$/u.test(reservation.id)
    || typeof reservation.generation !== 'string' || reservation.generation.length === 0
    || reservation.logicalRecords !== 1
    || !Number.isSafeInteger(reservation.bytes) || (reservation.bytes as number) < SANDBOX_CONTROL_RESERVATION_BYTES
    || !Number.isSafeInteger(reservation.createdAt)) {
    throw new Error('SANDBOX_CONTROL_RESERVATION_INVALID');
  }
  return reservation as SandboxControlReservation;
}

export function isSandboxControlFamily(value: string): value is SandboxControlFamily {
  return SANDBOX_CONTROL_FAMILIES.includes(value as SandboxControlFamily);
}

export function validateSandboxControlRequest(
  value: unknown,
  manifest: SandboxControlManifest,
  options: { now?: number } = {}
): SandboxControlRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('SANDBOX_CONTROL_REQUEST_INVALID', 'request must be an object');
  }
  const request = value as Record<string, unknown>;
  if (
    request.version !== 3 || typeof request.id !== 'string'
    || !/^[a-f0-9-]{16,64}$/.test(request.id) || request.token !== manifest.token
    || typeof request.family !== 'string' || !isSandboxControlFamily(request.family)
    || !Number.isSafeInteger(request.issuedAt) || !Number.isSafeInteger(request.expiresAt)
  ) fail('SANDBOX_CONTROL_REQUEST_INVALID', 'request schema or authorization is invalid');
  if (request.generation !== manifest.generation) {
    fail('SANDBOX_CONTROL_GENERATION_INVALID', 'request generation does not match the broker');
  }
  const issuedAt = request.issuedAt as number;
  const expiresAt = request.expiresAt as number;
  const now = options.now ?? Date.now();
  if (expiresAt <= issuedAt || expiresAt - issuedAt > SANDBOX_CONTROL_ADMISSION_WINDOW_MS || issuedAt > now + SANDBOX_CONTROL_FUTURE_SKEW_MS) {
    fail('SANDBOX_CONTROL_REQUEST_DEADLINE_INVALID', 'request admission deadline is invalid');
  }
  if (now > expiresAt) fail('SANDBOX_CONTROL_REQUEST_EXPIRED', 'request admission deadline has passed', true);
  if (Buffer.byteLength(JSON.stringify(request), 'utf8') > SANDBOX_CONTROL_MAX_BYTES) {
    fail('SANDBOX_CONTROL_REQUEST_TOO_LARGE', 'request exceeds the control limit');
  }
  if (request.family === 'task-create') {
    const expected = ['candidate', 'controllerProcess', 'controllerProof', 'expiresAt', 'family', 'generation', 'id', 'issuedAt', 'token', 'version'];
    if (Object.keys(request).sort().join(',') !== expected.sort().join(',')) {
      fail('SANDBOX_CONTROL_REQUEST_INVALID', 'request schema or authorization is invalid');
    }
    if (request.controllerProcess !== null || request.controllerProof !== null) {
      fail('SANDBOX_CONTROL_REQUEST_INVALID', 'task-create cannot carry controller authority');
    }
    return { ...request, candidate: validateTaskCreateCandidate(request.candidate) } as SandboxTaskCreateRequest;
  }
  if (request.family === 'codex-controller') {
    const expected = ['args', 'command', 'controllerProcess', 'controllerProof', 'expiresAt', 'family', 'generation', 'id', 'issuedAt', 'token', 'version'];
    if (Object.keys(request).sort().join(',') !== expected.sort().join(',')
      || !Array.isArray(request.args) || request.args.length !== 0
      || !['open', 'close', 'verify'].includes(request.command as string)
      || !validControllerProcess(request.controllerProcess)
      || (request.command === 'open' && request.controllerProof !== null)
      || (request.command !== 'open' && !validControllerProof(request.controllerProof))
      || (request.command === 'verify'
        && JSON.stringify(request.controllerProcess) !== JSON.stringify((request.controllerProof as CodexControllerLeaseProofV1).controllerProcess))) {
      fail('SANDBOX_CONTROL_REQUEST_INVALID', 'controller request schema is invalid');
    }
    if (manifest.mode !== 'task-bound' || !manifest.taskId) {
      fail('SANDBOX_CONTROL_BRANCH_ONLY', 'branch-only sandboxes cannot register a Codex controller');
    }
    return request as SandboxCodexControllerRequest;
  }
  if (request.family === 'task-finalization') {
    const expected = ['agent', 'args', 'controllerProcess', 'controllerProof', 'expiresAt', 'family', 'generation', 'id', 'issuedAt', 'operation', 'token', 'version'];
    if (Object.keys(request).sort().join(',') !== expected.sort().join(',')
      || request.operation !== 'complete'
      || !Array.isArray(request.args) || request.args.length !== 0
      || typeof request.agent !== 'string' || normalizeAgentToken(request.agent) !== request.agent
      || request.controllerProcess !== null || request.controllerProof !== null) {
      fail('SANDBOX_CONTROL_REQUEST_INVALID', 'task-finalization request schema or authorization is invalid');
    }
    if (manifest.mode !== 'task-bound' || !manifest.taskId) {
      fail('SANDBOX_CONTROL_BRANCH_ONLY', 'branch-only sandboxes cannot finalize tasks');
    }
    return request as SandboxTaskFinalizationRequest;
  }
  const expected = ['args', 'controllerProcess', 'controllerProof', 'expiresAt', 'family', 'generation', 'id', 'issuedAt', 'token', 'version'];
  if (Object.keys(request).sort().join(',') !== expected.sort().join(',')
    || !Array.isArray(request.args) || !request.args.every((arg) => typeof arg === 'string')) {
    fail('SANDBOX_CONTROL_REQUEST_INVALID', 'request schema or authorization is invalid');
  }
  if (manifest.mode !== 'task-bound' || !manifest.taskId) {
    fail(
      'SANDBOX_CONTROL_BRANCH_ONLY',
      "branch-only sandboxes cannot coordinate tasks; return to the host and run 'ai sandbox start --recreate <task-ref-or-correct-branch>'"
    );
  }
  if (request.family === 'task-orchestration'
    && request.args.some((arg) => arg === '--git-worktree-root' || arg.startsWith('--git-worktree-root='))) {
    fail('SANDBOX_CONTROL_REQUEST_INVALID', 'worktree binding is reserved for the control broker');
  }
  if (request.controllerProcess !== null
    || (request.controllerProof !== null && !validControllerProof(request.controllerProof))) {
    fail('SANDBOX_CONTROL_REQUEST_INVALID', 'controller authority is invalid');
  }
  if (request.family !== 'task-orchestration' && request.controllerProof !== null) {
    fail('SANDBOX_CONTROL_REQUEST_INVALID', 'controller proof is not allowed for this family');
  }
  return request as SandboxTaskCommandRequest;
}

export function bindSandboxControlTask(request: SandboxControlRequest, taskId: string): string[] {
  if (request.family === 'task-create' || request.family === 'codex-controller' || request.family === 'task-finalization') {
    fail('SANDBOX_CONTROL_REQUEST_INVALID', `${request.family} requests do not bind a current task`);
  }
  if (request.args.length === 0) fail('SANDBOX_CONTROL_REQUEST_INVALID', 'command arguments are required');
  return [taskId, ...request.args.slice(1)];
}

function validControllerProcess(value: unknown): value is ProcessIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const processValue = value as Record<string, unknown>;
  return Object.keys(processValue).sort().join(',') === 'pid,startTime'
    && Number.isSafeInteger(processValue.pid) && (processValue.pid as number) > 0
    && Number.isSafeInteger(processValue.startTime) && (processValue.startTime as number) >= 0;
}

function validControllerProof(value: unknown): value is CodexControllerLeaseProofV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proof = value as Record<string, unknown>;
  return Object.keys(proof).sort().join(',') === 'controllerProcess,leaseId,leaseSecret,version'
    && proof.version === 1
    && typeof proof.leaseId === 'string' && /^[a-f0-9]{64}$/u.test(proof.leaseId)
    && typeof proof.leaseSecret === 'string' && /^[a-f0-9]{64}$/u.test(proof.leaseSecret)
    && validControllerProcess(proof.controllerProcess);
}

export function controlError(error: unknown): SandboxControlError {
  if (error instanceof SandboxControlProtocolError) {
    return { code: error.code, message: error.message, retryable: error.retryable };
  }
  const message = error instanceof Error ? error.message : String(error);
  const code = /^([A-Z][A-Z0-9_]+)/.exec(message)?.[1] ?? 'SANDBOX_CONTROL_INTERNAL_ERROR';
  const retryable = new Set([
    'SANDBOX_CONTROL_BUSY',
    'SANDBOX_CONTROL_HANDOFF_ACTIVE',
    'SANDBOX_CONTROL_REQUEST_EXPIRED',
    'SANDBOX_WORKTREE_BINDING_LOST'
  ]).has(code);
  return { code, message, retryable };
}
