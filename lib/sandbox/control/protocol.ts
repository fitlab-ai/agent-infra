import { validateTaskCreateCandidate, type TaskCreateCandidateV1 } from '../../task/create.ts';

export const SANDBOX_CONTROL_MAX_BYTES = 64 * 1024;
export const SANDBOX_CONTROL_ADMISSION_WINDOW_MS = 2_000;
export const SANDBOX_CONTROL_STATUS_INTERVAL_MS = 250;
export const SANDBOX_CONTROL_STATUS_STALE_MS = 1_500;
export const SANDBOX_CONTROL_FUTURE_SKEW_MS = 1_000;
export const SANDBOX_CONTROL_FAMILIES = ['task-lifecycle', 'task-orchestration', 'task-create'] as const;

export type SandboxControlFamily = typeof SANDBOX_CONTROL_FAMILIES[number];
export type SandboxControlManifest = Readonly<{
  version: 3; repoRoot: string; worktreeRoot: string; project: string; container: string;
  branch: string; mode: 'task-bound' | 'branch-only'; taskId: string | null; token: string;
  generation: string; channelDir: string; publicStatusDir: string; processingDir: string;
}>;
type RequestBase = Readonly<{
  version: 2; id: string; token: string; generation: string; issuedAt: number; expiresAt: number;
}>;
export type SandboxTaskCommandRequest = RequestBase & Readonly<{
  family: 'task-lifecycle' | 'task-orchestration'; args: string[];
}>;
export type SandboxTaskCreateRequest = RequestBase & Readonly<{
  family: 'task-create'; candidate: TaskCreateCandidateV1;
}>;
export type SandboxControlRequest = SandboxTaskCommandRequest | SandboxTaskCreateRequest;
export type SandboxControlError = Readonly<{ code: string; message: string; retryable: boolean }>;
export type SandboxControlResponse = Readonly<{
  version: 2; id: string; phase: 'accepted' | 'completed' | 'rejected'; exitCode: number | null;
  stdout: string; stderr: string; error: SandboxControlError | null;
}>;
export type SandboxControlStatus = Readonly<{
  version: 1; generation: string; broker: { pid: number; startTime: string };
  state: 'starting' | 'healthy' | 'busy' | 'parked'; reasonCode: string | null;
  activeRequestId: string | null; updatedAt: number;
}>;
export type SandboxControlLease = Readonly<{
  version: 1; generation: string; nonce: string; owner: { pid: number; startTime: string };
  issuedAt: number; expiresAt: number; taskId: string | null; branch: string; reason: string;
}>;
export type SandboxControlExecution = Readonly<{
  version: 1; generation: string; requestId: string; nonce: string;
  child: { pid: number; startTime: string; processGroupId: number | null };
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
    request.version !== 2 || typeof request.id !== 'string'
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
    const expected = ['candidate', 'expiresAt', 'family', 'generation', 'id', 'issuedAt', 'token', 'version'];
    if (Object.keys(request).sort().join(',') !== expected.sort().join(',')) {
      fail('SANDBOX_CONTROL_REQUEST_INVALID', 'request schema or authorization is invalid');
    }
    return { ...request, candidate: validateTaskCreateCandidate(request.candidate) } as SandboxTaskCreateRequest;
  }
  const expected = ['args', 'expiresAt', 'family', 'generation', 'id', 'issuedAt', 'token', 'version'];
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
  return request as SandboxTaskCommandRequest;
}

export function bindSandboxControlTask(request: SandboxControlRequest, taskId: string): string[] {
  if (request.family === 'task-create') fail('SANDBOX_CONTROL_REQUEST_INVALID', 'task-create requests do not bind a current task');
  if (request.args.length === 0) fail('SANDBOX_CONTROL_REQUEST_INVALID', 'command arguments are required');
  return [taskId, ...request.args.slice(1)];
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
