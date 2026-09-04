import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  SANDBOX_CONTROL_ADMISSION_WINDOW_MS,
  SANDBOX_CONTROL_MAX_BYTES,
  SANDBOX_CONTROL_STATUS_STALE_MS,
  isSandboxControlFamily,
  type SandboxControlError,
  type SandboxControlRequest,
  type SandboxControlResponse,
  type SandboxTaskCreateRequest,
  type SandboxTaskCommandRequest,
  type SandboxTaskFinalizationRequest,
  type SandboxCodexControllerRequest
} from './protocol.ts';
import type {
  CodexControllerLeaseProofV1,
  CodexControllerOpened
} from './controller-registration.ts';
import type { ProcessIdentity } from '../../server/process-state.ts';
import { normalizeAgentToken } from '../../agent-clients/tokens.ts';
import { readSandboxControlPayload, readSandboxControlStatus } from './state.ts';
import type { TaskCreateCandidateV1 } from '../../task/create.ts';

const SANDBOX_CONTROL_RESPONSE_SETTLE_MS = 250;

export class SandboxControlClientError extends Error {
  readonly detail: SandboxControlError;
  readonly accepted: boolean;
  readonly requestId: string | null;
  constructor(detail: SandboxControlError, accepted = false, requestId: string | null = null) {
    super(detail.message);
    this.name = 'SandboxControlClientError';
    this.detail = detail;
    this.accepted = accepted;
    this.requestId = requestId;
  }
}

function sleep(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function clientError(
  code: string,
  message: string,
  retryable: boolean,
  accepted = false,
  requestId: string | null = null
): never {
  throw new SandboxControlClientError({ code, message: `${code}: ${message}`, retryable }, accepted, requestId);
}

function preflight(statusDir: string, generation: string, now = Date.now()): void {
  let status;
  try {
    status = readSandboxControlStatus(statusDir);
  } catch {
    clientError('SANDBOX_CONTROL_BROKER_UNAVAILABLE', 'broker status is missing or invalid', true);
  }
  if (status.generation !== generation) {
    clientError('SANDBOX_CONTROL_GENERATION_INVALID', 'broker status generation does not match this sandbox', false);
  }
  if (now - status.updatedAt > SANDBOX_CONTROL_STATUS_STALE_MS || status.updatedAt > now + 1_000) {
    clientError('SANDBOX_CONTROL_BROKER_UNAVAILABLE', 'broker status heartbeat is stale', true);
  }
  if (status.state === 'busy') clientError('SANDBOX_CONTROL_BUSY', 'broker is executing another request', true);
  if (status.state === 'parked') {
    const code = status.reasonCode ?? 'SANDBOX_CONTROL_BROKER_UNAVAILABLE';
    clientError(code, 'broker is parked until the host restores a valid binding', true);
  }
  if (status.state !== 'healthy') clientError('SANDBOX_CONTROL_BROKER_UNAVAILABLE', 'broker is not ready', true);
}

function parseResponse(raw: string, id: string): SandboxControlResponse {
  const response = JSON.parse(raw) as SandboxControlResponse;
  if (response.version !== 2 || response.id !== id
    || !['completed', 'rejected'].includes(response.phase)
    || (response.phase === 'completed' && !Number.isInteger(response.exitCode))
    || (response.outputState !== undefined && response.outputState !== 'available' && response.outputState !== 'unavailable')
    || (response.outputState === 'available' && !response.payload)
    || (response.outputState === 'unavailable' && response.payload !== null && response.payload !== undefined)) {
    clientError('SANDBOX_CONTROL_RESPONSE_INVALID', 'broker response is invalid', false, false, id);
  }
  return response;
}

function readPublishedResponse(raw: string, id: string, channelDir: string): SandboxControlResponse {
  const response = parseResponse(raw, id);
  if (response.outputState !== 'available') return response;
  const filePath = path.join(channelDir, 'responses', `${id}.payload.json`);
  let payload;
  try {
    payload = readSandboxControlPayload(filePath);
  } catch {
    clientError('SANDBOX_CONTROL_RESPONSE_INVALID', 'broker payload is missing or invalid', false, true, id);
  }
  if (!response.payload || response.payload.version !== payload.version
    || response.payload.id !== payload.id || response.payload.generation !== payload.generation
    || response.payload.stdoutBytes !== payload.stdoutBytes || response.payload.stderrBytes !== payload.stderrBytes
    || response.payload.stdoutSha256 !== payload.stdoutSha256 || response.payload.stderrSha256 !== payload.stderrSha256) {
    clientError('SANDBOX_CONTROL_RESPONSE_INVALID', 'broker payload reference is invalid', false, true, id);
  }
  return { ...response, stdout: payload.stdout, stderr: payload.stderr };
}

function cancelPendingRequest(requestPath: string): boolean {
  try {
    fs.unlinkSync(requestPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function exchangeSandboxControl(request: SandboxControlRequest, params: Readonly<{
  channelDir?: string;
  statusDir?: string;
  timeoutMs?: number;
}>): SandboxControlResponse {
  const channelDir = params.channelDir ?? process.env.AGENT_INFRA_CONTROL_DIR ?? '/run/agent-infra/control';
  const statusDir = params.statusDir ?? process.env.AGENT_INFRA_CONTROL_STATUS_DIR ?? '/run/agent-infra/control-status';
  preflight(statusDir, request.generation);
  const encoded = `${JSON.stringify(request)}\n`;
  if (Buffer.byteLength(encoded, 'utf8') > SANDBOX_CONTROL_MAX_BYTES) {
    clientError('SANDBOX_CONTROL_REQUEST_TOO_LARGE', 'request exceeds the control limit', false, false, request.id);
  }
  const requestsDir = path.join(channelDir, 'requests');
  const responsesDir = path.join(channelDir, 'responses');
  const temporary = path.join(requestsDir, `.${request.id}.tmp`);
  const requestPath = path.join(requestsDir, `${request.id}.json`);
  const responsePath = path.join(responsesDir, `${request.id}.json`);
  if (fs.existsSync(responsePath)) {
    clientError('SANDBOX_CONTROL_REQUEST_REPLAYED', 'request id already has a terminal response', false, false, request.id);
  }
  fs.writeFileSync(temporary, encoded, { mode: 0o600, flag: 'wx' });
  fs.renameSync(temporary, requestPath);
  const deadline = Date.now() + (params.timeoutMs ?? 30_000);
  let accepted = false;
  let malformedResponseRaw: string | null = null;
  let malformedResponseObservedAt = 0;
  while (Date.now() < deadline) {
    const acceptedPath = path.join(responsesDir, `${request.id}.accepted.json`);
    if (fs.existsSync(acceptedPath)) accepted = true;
    if (fs.existsSync(responsePath)) {
      let raw: string;
      try {
        raw = fs.readFileSync(responsePath, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      let response: SandboxControlResponse;
      try {
        response = readPublishedResponse(raw, request.id, channelDir);
        malformedResponseRaw = null;
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        const now = Date.now();
        if (malformedResponseRaw !== raw) {
          malformedResponseRaw = raw;
          malformedResponseObservedAt = now;
        } else if (now - malformedResponseObservedAt >= SANDBOX_CONTROL_RESPONSE_SETTLE_MS) {
          clientError('SANDBOX_CONTROL_RESPONSE_INVALID', 'broker response remained malformed', false, accepted, request.id);
        }
        sleep(25);
        continue;
      }
      if (response.phase === 'accepted') {
        accepted = true;
      } else {
        return response;
      }
    }
    if (!accepted) {
      try {
        preflight(statusDir, request.generation);
      } catch (error) {
        if (cancelPendingRequest(requestPath)) throw error;
        clientError(
          'SANDBOX_CONTROL_RESULT_UNKNOWN',
          'request was claimed before broker availability was lost; inspect domain state before retrying',
          false,
          true,
          request.id
        );
      }
    }
    sleep(25);
  }
  if (accepted) {
    clientError(
      'SANDBOX_CONTROL_RESULT_UNKNOWN',
      'accepted request did not produce a final result; inspect domain state before retrying',
      false,
      true,
      request.id
    );
  }
  if (!cancelPendingRequest(requestPath)) {
    clientError(
      'SANDBOX_CONTROL_RESULT_UNKNOWN',
      'request was claimed but no acceptance result was observed; inspect domain state before retrying',
      false,
      true,
      request.id
    );
  }
  clientError('SANDBOX_CONTROL_BROKER_UNAVAILABLE', `broker did not accept the request within ${params.timeoutMs ?? 30_000}ms`, true, false, request.id);
}

export function recoverSandboxControl(requestId: string, params: Readonly<{
  channelDir?: string;
  timeoutMs?: number;
}> = {}): SandboxControlResponse {
  if (!/^[a-f0-9-]{16,64}$/u.test(requestId)) {
    clientError('SANDBOX_CONTROL_REQUEST_INVALID', 'request id is invalid', false, true);
  }
  const channelDir = params.channelDir ?? process.env.AGENT_INFRA_CONTROL_DIR ?? '/run/agent-infra/control';
  const responsePath = path.join(channelDir, 'responses', `${requestId}.json`);
  const deadline = Date.now() + (params.timeoutMs ?? 30_000);
  let accepted = false;
  let malformedResponseRaw: string | null = null;
  let malformedResponseObservedAt = 0;
  while (Date.now() < deadline) {
    if (fs.existsSync(path.join(channelDir, 'responses', `${requestId}.accepted.json`))) accepted = true;
    if (fs.existsSync(responsePath)) {
      let raw: string;
      try {
        raw = fs.readFileSync(responsePath, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      let response: SandboxControlResponse;
      try {
        response = readPublishedResponse(raw, requestId, channelDir);
        malformedResponseRaw = null;
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        const now = Date.now();
        if (malformedResponseRaw !== raw) {
          malformedResponseRaw = raw;
          malformedResponseObservedAt = now;
        } else if (now - malformedResponseObservedAt >= SANDBOX_CONTROL_RESPONSE_SETTLE_MS) {
          clientError('SANDBOX_CONTROL_RESPONSE_INVALID', 'broker response remained malformed', false, accepted, requestId);
        }
        sleep(25);
        continue;
      }
      if (response.phase === 'accepted') accepted = true;
      else return response;
    }
    sleep(25);
  }
  clientError(
    'SANDBOX_CONTROL_RESULT_UNKNOWN',
    'request did not produce a final result; inspect domain state before retrying',
    false,
    accepted,
    requestId
  );
}

function authority(params: { token?: string; generation?: string }): { token: string; generation: string } {
  const token = params.token ?? process.env.AGENT_INFRA_CONTROL_TOKEN;
  const generation = params.generation ?? process.env.AGENT_INFRA_CONTROL_GENERATION;
  if (!token || !generation) clientError('SANDBOX_CONTROL_UNAVAILABLE', 'control authority is missing', false);
  return { token, generation };
}

export function requestSandboxControl(params: Readonly<{
  family: string; args: string[]; channelDir?: string; statusDir?: string;
  token?: string; generation?: string; timeoutMs?: number;
}>): SandboxControlResponse {
  if (!isSandboxControlFamily(params.family)) clientError('SANDBOX_CONTROL_COMMAND_DENIED', `'${params.family}' is not allowed`, false);
  if (params.family === 'task-create' || params.family === 'codex-controller' || params.family === 'task-finalization') {
    clientError('SANDBOX_CONTROL_COMMAND_DENIED', `'${params.family}' requires a typed request`, false);
  }
  const auth = authority(params);
  const issuedAt = Date.now();
  const request: SandboxControlRequest = {
    version: 3, id: randomUUID(), ...auth, issuedAt,
    expiresAt: issuedAt + SANDBOX_CONTROL_ADMISSION_WINDOW_MS,
    family: params.family as 'task-lifecycle' | 'task-orchestration', args: params.args,
    controllerProcess: null,
    controllerProof: null
  };
  return exchangeSandboxControl(request, params);
}

export function requestSandboxTaskControl(params: Readonly<{
  family: 'task-lifecycle' | 'task-orchestration';
  args: string[];
  controllerProof: CodexControllerLeaseProofV1 | null;
  channelDir?: string;
  statusDir?: string;
  token?: string;
  generation?: string;
  timeoutMs?: number;
}>): SandboxControlResponse {
  const auth = authority(params);
  const issuedAt = Date.now();
  const request: SandboxTaskCommandRequest = {
    version: 3,
    id: randomUUID(),
    ...auth,
    issuedAt,
    expiresAt: issuedAt + SANDBOX_CONTROL_ADMISSION_WINDOW_MS,
    family: params.family,
    args: params.args,
    controllerProcess: null,
    controllerProof: params.controllerProof
  };
  return exchangeSandboxControl(request, params);
}

export function requestSandboxTaskFinalization(params: Readonly<{
  agent: string;
  channelDir?: string;
  statusDir?: string;
  token?: string;
  generation?: string;
  timeoutMs?: number;
}>): SandboxControlResponse {
  const agent = normalizeAgentToken(params.agent);
  if (!agent) clientError('SANDBOX_CONTROL_REQUEST_INVALID', 'task-finalization agent is invalid', false);
  const auth = authority(params);
  const issuedAt = Date.now();
  const request: SandboxTaskFinalizationRequest = {
    version: 3,
    id: randomUUID(),
    ...auth,
    issuedAt,
    expiresAt: issuedAt + SANDBOX_CONTROL_ADMISSION_WINDOW_MS,
    family: 'task-finalization',
    operation: 'complete',
    agent,
    args: [],
    controllerProcess: null,
    controllerProof: null
  };
  return exchangeSandboxControl(request, params);
}

type CodexControllerClosed = Readonly<{
  version: 1;
  status: 'closed';
  changed: boolean;
  lease: null;
  error: null;
}>;

type CodexControllerVerified = Readonly<{
  version: 1;
  status: 'verified';
  changed: false;
  lease: null;
  binding: Readonly<{
    taskId: string;
    controlGeneration: string;
    controllerInstanceDigest: string;
  }>;
  error: null;
}>;

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

function validProcess(value: unknown): value is ProcessIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const identity = value as Record<string, unknown>;
  return exactKeys(identity, ['pid', 'startTime'])
    && Number.isSafeInteger(identity.pid) && (identity.pid as number) > 0
    && Number.isSafeInteger(identity.startTime) && (identity.startTime as number) >= 0;
}

function validBuild(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const build = value as Record<string, unknown>;
  return exactKeys(build, ['internalExecutableBuildHash', 'lifecycleContractHash', 'packageVersion', 'protocolVersion'])
    && build.protocolVersion === 3
    && typeof build.packageVersion === 'string' && build.packageVersion.length > 0
    && typeof build.internalExecutableBuildHash === 'string' && /^[a-f0-9]{64}$/u.test(build.internalExecutableBuildHash)
    && typeof build.lifecycleContractHash === 'string' && /^[a-f0-9]{64}$/u.test(build.lifecycleContractHash);
}

export function parseCodexControllerResult(response: SandboxControlResponse): CodexControllerOpened | CodexControllerClosed | CodexControllerVerified {
  if (response.phase !== 'completed' || response.error !== null || response.stderr !== '') {
    clientError('SANDBOX_CONTROL_RESULT_INVALID', 'controller result outer response is invalid', false, true);
  }
  let value: unknown;
  try {
    if (!response.stdout.endsWith('\n') || response.stdout.slice(0, -1).includes('\n')) throw new Error('not canonical');
    value = JSON.parse(response.stdout);
  } catch {
    clientError('SANDBOX_CONTROL_RESULT_INVALID', 'controller result payload is invalid', false, true);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    clientError('SANDBOX_CONTROL_RESULT_INVALID', 'controller result payload is invalid', false, true);
  }
  const result = value as Record<string, unknown>;
  const resultKeys = result.status === 'verified'
    ? ['binding', 'changed', 'error', 'lease', 'status', 'version']
    : ['changed', 'error', 'lease', 'status', 'version'];
  if (!exactKeys(result, resultKeys)
    || result.version !== 1 || !['opened', 'closed', 'failed', 'verified'].includes(result.status as string)) {
    clientError('SANDBOX_CONTROL_RESULT_INVALID', 'controller result schema is invalid', false, true);
  }
  if (result.status === 'failed') {
    const error = result.error as { code?: unknown; message?: unknown; retryable?: unknown } | null;
    if (response.exitCode !== 1 || result.changed !== false || result.lease !== null
      || !error || !exactKeys(error as Record<string, unknown>, ['code', 'message', 'retryable'])
      || typeof error.code !== 'string' || !/^[A-Z][A-Z0-9_]+$/u.test(error.code)
      || typeof error.message !== 'string' || error.retryable !== false) {
      clientError('SANDBOX_CONTROL_RESULT_INVALID', 'controller failure result is invalid', false, true);
    }
    clientError(error.code, error.message, false, true);
  }
  if (response.exitCode !== 0 || result.error !== null) {
    clientError('SANDBOX_CONTROL_RESULT_INVALID', 'controller success result is invalid', false, true);
  }
  if (result.status === 'closed') {
    if (typeof result.changed !== 'boolean' || result.lease !== null) {
      clientError('SANDBOX_CONTROL_RESULT_INVALID', 'controller close result is invalid', false, true);
    }
    return result as unknown as CodexControllerClosed;
  }
  if (result.status === 'verified') {
    const binding = result.binding as Record<string, unknown> | null;
    if (result.changed !== false || result.lease !== null || !binding
      || !exactKeys(binding, ['controllerInstanceDigest', 'controlGeneration', 'taskId'])
      || typeof binding.taskId !== 'string' || binding.taskId.length === 0
      || typeof binding.controlGeneration !== 'string' || binding.controlGeneration.length === 0
      || typeof binding.controllerInstanceDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(binding.controllerInstanceDigest)) {
      clientError('SANDBOX_CONTROL_RESULT_INVALID', 'controller verify result is invalid', false, true);
    }
    return result as unknown as CodexControllerVerified;
  }
  const lease = result.lease as Record<string, unknown> | null;
  if (result.changed !== true || !lease
    || !exactKeys(lease, [
      'buildIdentity', 'controlGeneration', 'controllerInstanceDigest', 'controllerProcess',
      'expiresAt', 'issuedAt', 'leaseId', 'leaseSecret', 'taskId', 'version'
    ])
    || lease.version !== 1
    || typeof lease.leaseId !== 'string' || !/^[a-f0-9]{64}$/u.test(lease.leaseId)
    || typeof lease.leaseSecret !== 'string' || !/^[a-f0-9]{64}$/u.test(lease.leaseSecret)
    || typeof lease.taskId !== 'string' || lease.taskId.length === 0
    || typeof lease.controlGeneration !== 'string' || lease.controlGeneration.length === 0
    || typeof lease.controllerInstanceDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(lease.controllerInstanceDigest)
    || !validProcess(lease.controllerProcess) || !validBuild(lease.buildIdentity)
    || !Number.isSafeInteger(lease.issuedAt) || !Number.isSafeInteger(lease.expiresAt)
    || (lease.expiresAt as number) <= (lease.issuedAt as number)) {
    clientError('SANDBOX_CONTROL_RESULT_INVALID', 'controller open result is invalid', false, true);
  }
  return result as unknown as CodexControllerOpened | CodexControllerClosed;
}

function requestCodexController(params: Readonly<{
  command: 'open' | 'close' | 'verify';
  controllerProcess: ProcessIdentity;
  controllerProof: CodexControllerLeaseProofV1 | null;
  channelDir?: string;
  statusDir?: string;
  token?: string;
  generation?: string;
  timeoutMs?: number;
}>): CodexControllerOpened | CodexControllerClosed | CodexControllerVerified {
  const auth = authority(params);
  const issuedAt = Date.now();
  const request: SandboxCodexControllerRequest = {
    version: 3,
    id: randomUUID(),
    ...auth,
    issuedAt,
    expiresAt: issuedAt + SANDBOX_CONTROL_ADMISSION_WINDOW_MS,
    family: 'codex-controller',
    command: params.command,
    args: [],
    controllerProcess: params.controllerProcess,
    controllerProof: params.controllerProof
  };
  const result = parseCodexControllerResult(exchangeSandboxControl(request, params));
  if (result.status === 'opened'
    && (result.lease.controlGeneration !== auth.generation
      || result.lease.controllerProcess.pid !== params.controllerProcess.pid
      || result.lease.controllerProcess.startTime !== params.controllerProcess.startTime)) {
    clientError('SANDBOX_CONTROL_RESULT_INVALID', 'controller result does not match the request', false, true);
  }
  return result;
}

export function requestCodexControllerOpen(params: Omit<Parameters<typeof requestCodexController>[0], 'command' | 'controllerProof'>): CodexControllerOpened {
  const result = requestCodexController({ ...params, command: 'open', controllerProof: null });
  if (result.status !== 'opened') clientError('SANDBOX_CONTROL_RESULT_INVALID', 'controller open returned the wrong result', false, true);
  return result;
}

export function requestCodexControllerClose(params: Omit<Parameters<typeof requestCodexController>[0], 'command'>): CodexControllerClosed {
  const result = requestCodexController({ ...params, command: 'close' });
  if (result.status !== 'closed') clientError('SANDBOX_CONTROL_RESULT_INVALID', 'controller close returned the wrong result', false, true);
  return result;
}

export function requestCodexControllerVerify(params: Readonly<{
  controllerProof: CodexControllerLeaseProofV1;
  channelDir?: string;
  statusDir?: string;
  token?: string;
  generation?: string;
  timeoutMs?: number;
}>): CodexControllerVerified {
  const result = requestCodexController({
    ...params,
    controllerProcess: params.controllerProof.controllerProcess,
    command: 'verify'
  });
  if (result.status !== 'verified') {
    clientError('SANDBOX_CONTROL_RESULT_INVALID', 'controller verify returned the wrong result', false, true);
  }
  return result;
}

export function requestSandboxTaskCreate(params: Readonly<{
  candidate: TaskCreateCandidateV1; channelDir?: string; statusDir?: string;
  token?: string; generation?: string; timeoutMs?: number;
}>): SandboxControlResponse {
  const auth = authority(params);
  const issuedAt = Date.now();
  const request: SandboxTaskCreateRequest = {
    version: 3, id: randomUUID(), ...auth, issuedAt,
    expiresAt: issuedAt + SANDBOX_CONTROL_ADMISSION_WINDOW_MS,
    family: 'task-create', candidate: params.candidate,
    controllerProcess: null,
    controllerProof: null
  };
  return exchangeSandboxControl(request, { ...params, timeoutMs: params.timeoutMs ?? 120_000 });
}
