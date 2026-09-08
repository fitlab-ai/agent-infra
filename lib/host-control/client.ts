import net from 'node:net';
import { randomUUID } from 'node:crypto';

import {
  inspectHostControlEndpoint,
  resolveHostControlEndpoint
} from './path.ts';
import { validateTaskWorkflowRequest } from '../sandbox/control/task-workflow.ts';

export const HOST_CONTROL_MAX_REQUEST_BYTES = 64 * 1024;

export const HOST_CONTROL_COMMANDS = Object.freeze([
  'task-lifecycle', 'task-orchestration', 'task-finalization',
  'task-artifact', 'task-review', 'task-event', 'task-ledger',
  'task-invalidation', 'task-warning'
] as const);
export type HostControlCommand = typeof HOST_CONTROL_COMMANDS[number];

export type HostControlCommandPayload = Readonly<{
  workingDirectory: string;
  args: readonly string[];
  environment?: Readonly<Record<string, string>>;
}>;

export const HOST_CONTROL_TEST_ENVIRONMENT_KEYS = Object.freeze([
  'TZ', 'AGENT_INFRA_GH_BIN', 'AGENT_INFRA_GH_ARGS_JSON', 'GH_FAKE_PR_PATH', 'GH_FAKE_ARGS_PATH'
] as const);

export type HostControlRequest = Readonly<{
  version: 1;
  id: string;
  taskId: string | null;
  generation: string | null;
  operation: string;
  scope: string;
  payload?: Readonly<Record<string, unknown>>;
}>;

export type HostControlResponse = Readonly<{
  version: 1;
  id: string;
  status: 'completed' | 'rejected';
  exitCode: number;
  result: unknown;
  error: Readonly<{ code: string; message: string }> | null;
}>;

export class HostControlClientError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  constructor(code: string, message: string, retryable = false) {
    super(`${code}: ${message}`);
    this.name = 'HostControlClientError';
    this.code = code;
    this.retryable = retryable;
  }
}

function reject(message: string): never {
  throw new HostControlClientError('HOST_CONTROL_REQUEST_INVALID', message);
}

export function validateHostControlRequest(value: unknown): HostControlRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) reject('request must be an object');
  const request = value as Record<string, unknown>;
  const keys = Object.keys(request).sort().join(',');
  if (!['generation,id,operation,payload,scope,taskId,version', 'generation,id,operation,scope,taskId,version'].includes(keys)
    || request.version !== 1 || typeof request.id !== 'string' || !/^[a-f0-9-]{16,64}$/u.test(request.id)
    || (request.taskId !== null && (typeof request.taskId !== 'string' || !/^TASK-\d{8}-\d{6}$/u.test(request.taskId)))
    || (request.generation !== null && (typeof request.generation !== 'string' || !request.generation))
    || typeof request.operation !== 'string' || !/^[a-z][a-z0-9-]{1,63}$/u.test(request.operation)
    || typeof request.scope !== 'string' || !/^[a-z][a-z0-9-]{1,63}$/u.test(request.scope)) reject('request schema is invalid');
  if (request.payload !== undefined) {
    if (!request.payload || typeof request.payload !== 'object' || Array.isArray(request.payload)) reject('request payload is invalid');
    const forbidden = ['repoRoot', 'taskDir', 'workspaceRoot', 'runtimeDir', 'path', 'socket', 'handler', 'command'];
    if (Object.keys(request.payload as object).some((key) => forbidden.includes(key))) reject('request payload contains a forbidden field');
    if (request.scope === 'task-workflow') {
      const workflow = validateTaskWorkflowRequest(request.payload);
      if (workflow.id !== request.id || workflow.taskId !== request.taskId || workflow.generation !== request.generation
        || workflow.operation !== request.operation) reject('task-workflow binding is invalid');
    }
    if (request.scope === 'host-command') {
      const payload = request.payload as Record<string, unknown>;
      if (!['args,environment,workingDirectory', 'args,workingDirectory'].includes(Object.keys(payload).sort().join(','))
        || !Array.isArray(payload.args)
        || !payload.args.every((arg) => typeof arg === 'string' && !/[\r\n]/u.test(arg))
        || payload.args.length > 128
        || typeof payload.workingDirectory !== 'string'
        || !payload.workingDirectory.startsWith('/')
        || !HOST_CONTROL_COMMANDS.includes(request.operation as HostControlCommand)) {
        reject('host-command payload is invalid');
      }
      if (payload.environment !== undefined) {
        if (!payload.environment || typeof payload.environment !== 'object' || Array.isArray(payload.environment)) reject('host-command environment is invalid');
        for (const [key, value] of Object.entries(payload.environment as Record<string, unknown>)) {
          if (!HOST_CONTROL_TEST_ENVIRONMENT_KEYS.includes(key as typeof HOST_CONTROL_TEST_ENVIRONMENT_KEYS[number])
            || typeof value !== 'string' || /[\r\n]/u.test(value)) reject('host-command environment is invalid');
        }
      }
    }
  } else if (request.scope === 'task-workflow') {
    reject('task-workflow payload is required');
  }
  return request as HostControlRequest;
}

export function hostControlRequestForTaskWorkflow(
  request: Parameters<typeof validateTaskWorkflowRequest>[0],
  scope = 'task-workflow'
): HostControlRequest {
  const workflow = validateTaskWorkflowRequest(request);
  return {
    version: 1,
    id: workflow.id,
    taskId: workflow.taskId,
    generation: workflow.generation,
    operation: workflow.operation,
    scope,
    payload: workflow
  };
}

export function hostControlRequestForCommand(
  command: HostControlCommand,
  args: readonly string[],
  workingDirectory: string,
  environment: Readonly<Record<string, string>> = {}
): HostControlRequest {
  if (!HOST_CONTROL_COMMANDS.includes(command)) reject('host-command is unsupported');
  const taskArg = args[0];
  const taskId = taskArg && /^TASK-\d{8}-\d{6}$/u.test(taskArg) ? taskArg : null;
  return validateHostControlRequest({
    version: 1,
    id: randomUUID(),
    taskId,
    generation: null,
    operation: command,
    scope: 'host-command',
    payload: {
      workingDirectory,
      args: [...args],
      ...(Object.keys(environment).length > 0 ? { environment } : {})
    }
  });
}

function parseResponse(value: unknown, id: string): HostControlResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HostControlClientError('HOST_CONTROL_RESPONSE_INVALID', 'response must be an object');
  const response = value as Record<string, unknown>;
  if (Object.keys(response).sort().join(',') !== 'error,exitCode,id,result,status,version'
    || response.version !== 1 || response.id !== id
    || !['completed', 'rejected'].includes(response.status as string)
    || !Number.isSafeInteger(response.exitCode)
    || (response.error !== null && (!response.error || typeof response.error !== 'object'))) {
    throw new HostControlClientError('HOST_CONTROL_RESPONSE_INVALID', 'response schema is invalid');
  }
  return response as HostControlResponse;
}

export async function requestHostControl(params: Readonly<{
  request: HostControlRequest;
  endpoint?: string;
  timeoutMs?: number;
}>): Promise<HostControlResponse> {
  const request = validateHostControlRequest(params.request);
  const endpoint = params.endpoint ?? resolveHostControlEndpoint();
  const inspection = inspectHostControlEndpoint(endpoint, { uid: process.getuid?.() });
  if (!inspection.ok) throw new HostControlClientError(inspection.code ?? 'HOST_CONTROL_UNAVAILABLE', 'fixed host-control endpoint is unavailable', true);
  const encoded = `${JSON.stringify(request)}\n`;
  if (Buffer.byteLength(encoded, 'utf8') > HOST_CONTROL_MAX_REQUEST_BYTES) throw new HostControlClientError('HOST_CONTROL_REQUEST_TOO_LARGE', 'request exceeds the control limit');
  const timeoutMs = params.timeoutMs ?? 30_000;
  return await new Promise<HostControlResponse>((resolve, rejectPromise) => {
    const socket = net.createConnection(endpoint);
    let output = '';
    let settled = false;
    const finish = (error?: Error, response?: HostControlResponse): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) rejectPromise(error); else resolve(response!);
    };
    const timer = setTimeout(() => finish(new HostControlClientError('HOST_CONTROL_TIMEOUT', 'host-control did not respond', true)), timeoutMs);
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.end(encoded));
    socket.on('data', (chunk: string) => {
      output += chunk;
      if (Buffer.byteLength(output, 'utf8') > HOST_CONTROL_MAX_REQUEST_BYTES) {
        finish(new HostControlClientError('HOST_CONTROL_RESPONSE_TOO_LARGE', 'host-control response exceeds the control limit'));
        return;
      }
      const newline = output.indexOf('\n');
      if (newline < 0) return;
      try { finish(undefined, parseResponse(JSON.parse(output.slice(0, newline)), request.id)); }
      catch (error) { finish(error instanceof Error ? error : new HostControlClientError('HOST_CONTROL_RESPONSE_INVALID', String(error))); }
    });
    socket.on('error', (error) => finish(new HostControlClientError('HOST_CONTROL_UNAVAILABLE', error.message, true)));
    socket.on('close', () => {
      if (!settled) finish(new HostControlClientError('HOST_CONTROL_RESPONSE_INVALID', 'host-control closed without a response'));
    });
  });
}

export function createHostControlRequest(input: Omit<HostControlRequest, 'version' | 'id'> & Partial<Pick<HostControlRequest, 'id'>>): HostControlRequest {
  return validateHostControlRequest({ version: 1, id: input.id ?? randomUUID(), ...input });
}
