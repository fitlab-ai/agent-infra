import { validateTaskCreateCandidate, type TaskCreateCandidateV1 } from '../../task/create.ts';
import type { ProcessIdentity } from '../../server/process-state.ts';
import type { CodexControllerLeaseProofV1 } from './controller-registration.ts';

export const SANDBOX_CONTROL_MAX_BYTES = 64 * 1024;
export const SANDBOX_CONTROL_ADMISSION_WINDOW_MS = 2_000;
export const SANDBOX_CONTROL_STATUS_INTERVAL_MS = 250;
export const SANDBOX_CONTROL_STATUS_STALE_MS = 1_500;
export const SANDBOX_CONTROL_FUTURE_SKEW_MS = 1_000;
export const SANDBOX_CONTROL_FAMILIES = ['task-lifecycle', 'task-orchestration', 'task-create', 'codex-controller'] as const;
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
  branch: string; mode: 'task-bound' | 'branch-only'; taskId: string | null; token: string;
  generation: string; channelDir: string; publicStatusDir: string; processingDir: string;
}>;
export type SandboxControlLegacyManifest = SandboxControlManifestBase & Readonly<{ version: 4 }>;
export type SandboxControlManifest = SandboxControlManifestBase & Readonly<{ version: 5; runtimeDir: string }>;
export type SandboxControlManifestLike = SandboxControlLegacyManifest | SandboxControlManifest;
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
export type SandboxTaskCreateRequest = RequestBase & Readonly<{
  family: 'task-create'; candidate: TaskCreateCandidateV1;
}>;
export type SandboxCodexControllerRequest = RequestBase & Readonly<{
  family: 'codex-controller';
  command: 'open' | 'close';
  args: [];
}>;
export type SandboxControlRequest = SandboxTaskCommandRequest | SandboxTaskCreateRequest | SandboxCodexControllerRequest;
export type SandboxControlError = Readonly<{ code: string; message: string; retryable: boolean }>;
export type SandboxControlResponse = Readonly<{
  version: 2; id: string; phase: 'accepted' | 'completed' | 'rejected'; exitCode: number | null;
  stdout: string; stderr: string; error: SandboxControlError | null;
}>;
export type SandboxControlStatus = Readonly<{
  version: 2; generation: string; broker: ProcessIdentity & { brokerId: string };
  state: 'starting' | 'healthy' | 'busy' | 'parked'; reasonCode: string | null;
  activeRequestId: string | null; updatedAt: number;
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
      || !['open', 'close'].includes(request.command as string)
      || !validControllerProcess(request.controllerProcess)
      || (request.command === 'open' && request.controllerProof !== null)
      || (request.command === 'close' && !validControllerProof(request.controllerProof))) {
      fail('SANDBOX_CONTROL_REQUEST_INVALID', 'controller request schema is invalid');
    }
    if (manifest.mode !== 'task-bound' || !manifest.taskId) {
      fail('SANDBOX_CONTROL_BRANCH_ONLY', 'branch-only sandboxes cannot register a Codex controller');
    }
    return request as SandboxCodexControllerRequest;
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
  if (request.family === 'task-create' || request.family === 'codex-controller') {
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
