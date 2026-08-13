import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  SANDBOX_CONTROL_MAX_BYTES,
  isSandboxControlFamily,
  type SandboxControlRequest,
  type SandboxControlResponse,
  type SandboxTaskCreateRequest
} from './protocol.ts';
import type { TaskCreateCandidateV1 } from '../../task/create.ts';

function sleep(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function exchangeSandboxControl(request: SandboxControlRequest, params: Readonly<{
  channelDir?: string;
  timeoutMs?: number;
}>): SandboxControlResponse {
  const channelDir = params.channelDir ?? process.env.AGENT_INFRA_CONTROL_DIR ?? '/run/agent-infra/control';
  const encoded = `${JSON.stringify(request)}\n`;
  if (Buffer.byteLength(encoded, 'utf8') > SANDBOX_CONTROL_MAX_BYTES) {
    throw new Error('SANDBOX_CONTROL_REQUEST_TOO_LARGE: request exceeds the control limit');
  }
  const requestsDir = path.join(channelDir, 'requests');
  const responsesDir = path.join(channelDir, 'responses');
  const temporary = path.join(requestsDir, `.${request.id}.tmp`);
  const requestPath = path.join(requestsDir, `${request.id}.json`);
  const responsePath = path.join(responsesDir, `${request.id}.json`);
  fs.writeFileSync(temporary, encoded, { mode: 0o600, flag: 'wx' });
  fs.renameSync(temporary, requestPath);
  const deadline = Date.now() + (params.timeoutMs ?? 30_000);
  while (Date.now() < deadline) {
    if (fs.existsSync(responsePath)) {
      const raw = fs.readFileSync(responsePath, 'utf8');
      fs.unlinkSync(responsePath);
      const response = JSON.parse(raw) as SandboxControlResponse;
      if (response.version !== 1 || response.id !== request.id || !Number.isInteger(response.exitCode)) {
        throw new Error('SANDBOX_CONTROL_RESPONSE_INVALID: broker response is invalid');
      }
      return response;
    }
    sleep(25);
  }
  throw new Error(`SANDBOX_CONTROL_TIMEOUT: broker did not respond within ${params.timeoutMs ?? 30_000}ms`);
}

export function requestSandboxControl(params: Readonly<{
  family: string;
  args: string[];
  channelDir?: string;
  token?: string;
  timeoutMs?: number;
}>): SandboxControlResponse {
  if (!isSandboxControlFamily(params.family)) {
    throw new Error(`SANDBOX_CONTROL_COMMAND_DENIED: '${params.family}' is not allowed`);
  }
  if (params.family === 'task-create') throw new Error("SANDBOX_CONTROL_COMMAND_DENIED: 'task-create' requires a typed candidate");
  const token = params.token ?? process.env.AGENT_INFRA_CONTROL_TOKEN;
  if (!token) throw new Error('SANDBOX_CONTROL_UNAVAILABLE: control token is missing');
  const id = randomUUID();
  const request: SandboxControlRequest = { version: 1, id, token, family: params.family, args: params.args };
  return exchangeSandboxControl(request, params);
}

export function requestSandboxTaskCreate(params: Readonly<{
  candidate: TaskCreateCandidateV1;
  channelDir?: string;
  token?: string;
  timeoutMs?: number;
}>): SandboxControlResponse {
  const token = params.token ?? process.env.AGENT_INFRA_CONTROL_TOKEN;
  if (!token) throw new Error('SANDBOX_CONTROL_UNAVAILABLE: control token is missing');
  const request: SandboxTaskCreateRequest = {
    version: 1, id: randomUUID(), token, family: 'task-create', candidate: params.candidate
  };
  return exchangeSandboxControl(request, { ...params, timeoutMs: params.timeoutMs ?? 120_000 });
}
