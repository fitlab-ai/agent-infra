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
  type SandboxTaskCreateRequest
} from './protocol.ts';
import { readSandboxControlStatus } from './state.ts';
import type { TaskCreateCandidateV1 } from '../../task/create.ts';

const SANDBOX_CONTROL_RESPONSE_SETTLE_MS = 250;

export class SandboxControlClientError extends Error {
  readonly detail: SandboxControlError;
  readonly accepted: boolean;
  constructor(detail: SandboxControlError, accepted = false) {
    super(detail.message);
    this.name = 'SandboxControlClientError';
    this.detail = detail;
    this.accepted = accepted;
  }
}

function sleep(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function clientError(code: string, message: string, retryable: boolean, accepted = false): never {
  throw new SandboxControlClientError({ code, message: `${code}: ${message}`, retryable }, accepted);
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
    || !['accepted', 'completed', 'rejected'].includes(response.phase)
    || (response.phase === 'completed' && !Number.isInteger(response.exitCode))) {
    clientError('SANDBOX_CONTROL_RESPONSE_INVALID', 'broker response is invalid', false);
  }
  return response;
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
    clientError('SANDBOX_CONTROL_REQUEST_TOO_LARGE', 'request exceeds the control limit', false);
  }
  const requestsDir = path.join(channelDir, 'requests');
  const responsesDir = path.join(channelDir, 'responses');
  const temporary = path.join(requestsDir, `.${request.id}.tmp`);
  const requestPath = path.join(requestsDir, `${request.id}.json`);
  const responsePath = path.join(responsesDir, `${request.id}.json`);
  fs.writeFileSync(temporary, encoded, { mode: 0o600, flag: 'wx' });
  fs.renameSync(temporary, requestPath);
  const deadline = Date.now() + (params.timeoutMs ?? 30_000);
  let accepted = false;
  let malformedResponseRaw: string | null = null;
  let malformedResponseObservedAt = 0;
  while (Date.now() < deadline) {
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
        response = parseResponse(raw, request.id);
        malformedResponseRaw = null;
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        const now = Date.now();
        if (malformedResponseRaw !== raw) {
          malformedResponseRaw = raw;
          malformedResponseObservedAt = now;
        } else if (now - malformedResponseObservedAt >= SANDBOX_CONTROL_RESPONSE_SETTLE_MS) {
          clientError('SANDBOX_CONTROL_RESPONSE_INVALID', 'broker response remained malformed', false, accepted);
        }
        sleep(25);
        continue;
      }
      if (response.phase === 'accepted') {
        accepted = true;
      } else {
        fs.rmSync(responsePath, { force: true });
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
          true
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
      true
    );
  }
  if (!cancelPendingRequest(requestPath)) {
    clientError(
      'SANDBOX_CONTROL_RESULT_UNKNOWN',
      'request was claimed but no acceptance result was observed; inspect domain state before retrying',
      false,
      true
    );
  }
  clientError('SANDBOX_CONTROL_BROKER_UNAVAILABLE', `broker did not accept the request within ${params.timeoutMs ?? 30_000}ms`, true);
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
  if (params.family === 'task-create') clientError('SANDBOX_CONTROL_COMMAND_DENIED', "'task-create' requires a typed candidate", false);
  const auth = authority(params);
  const issuedAt = Date.now();
  const request: SandboxControlRequest = {
    version: 2, id: randomUUID(), ...auth, issuedAt,
    expiresAt: issuedAt + SANDBOX_CONTROL_ADMISSION_WINDOW_MS,
    family: params.family, args: params.args
  };
  return exchangeSandboxControl(request, params);
}

export function requestSandboxTaskCreate(params: Readonly<{
  candidate: TaskCreateCandidateV1; channelDir?: string; statusDir?: string;
  token?: string; generation?: string; timeoutMs?: number;
}>): SandboxControlResponse {
  const auth = authority(params);
  const issuedAt = Date.now();
  const request: SandboxTaskCreateRequest = {
    version: 2, id: randomUUID(), ...auth, issuedAt,
    expiresAt: issuedAt + SANDBOX_CONTROL_ADMISSION_WINDOW_MS,
    family: 'task-create', candidate: params.candidate
  };
  return exchangeSandboxControl(request, { ...params, timeoutMs: params.timeoutMs ?? 120_000 });
}
