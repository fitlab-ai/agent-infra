import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  SANDBOX_CONTROL_MAX_BYTES,
  isSandboxControlFamily,
  type SandboxControlRequest,
  type SandboxControlResponse
} from './protocol.ts';

function sleep(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
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
  const channelDir = params.channelDir ?? process.env.AGENT_INFRA_CONTROL_DIR ?? '/run/agent-infra/control';
  const token = params.token ?? process.env.AGENT_INFRA_CONTROL_TOKEN;
  if (!token) throw new Error('SANDBOX_CONTROL_UNAVAILABLE: control token is missing');
  const requestsDir = path.join(channelDir, 'requests');
  const responsesDir = path.join(channelDir, 'responses');
  const id = randomUUID();
  const request: SandboxControlRequest = { version: 1, id, token, family: params.family, args: params.args };
  const encoded = `${JSON.stringify(request)}\n`;
  if (Buffer.byteLength(encoded, 'utf8') > SANDBOX_CONTROL_MAX_BYTES) {
    throw new Error('SANDBOX_CONTROL_REQUEST_TOO_LARGE: request exceeds the control limit');
  }
  const temporary = path.join(requestsDir, `.${id}.tmp`);
  const requestPath = path.join(requestsDir, `${id}.json`);
  const responsePath = path.join(responsesDir, `${id}.json`);
  fs.writeFileSync(temporary, encoded, { mode: 0o600, flag: 'wx' });
  fs.renameSync(temporary, requestPath);
  const deadline = Date.now() + (params.timeoutMs ?? 30_000);
  while (Date.now() < deadline) {
    if (fs.existsSync(responsePath)) {
      const raw = fs.readFileSync(responsePath, 'utf8');
      fs.unlinkSync(responsePath);
      const response = JSON.parse(raw) as SandboxControlResponse;
      if (response.version !== 1 || response.id !== id || !Number.isInteger(response.exitCode)) {
        throw new Error('SANDBOX_CONTROL_RESPONSE_INVALID: broker response is invalid');
      }
      return response;
    }
    sleep(25);
  }
  throw new Error(`SANDBOX_CONTROL_TIMEOUT: broker did not respond within ${params.timeoutMs ?? 30_000}ms`);
}
