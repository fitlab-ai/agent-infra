import fs from 'node:fs';
import net from 'node:net';
import { createHash } from 'node:crypto';

import {
  HOST_CONTROL_DIRECTORY_MODE,
  HOST_CONTROL_SOCKET_MODE,
  ensureHostControlWorkerToken,
  inspectHostControlEndpoint,
  prepareHostControlDirectory,
  removeHostControlWorkerToken,
  resolveHostControlEndpoint
} from './path.ts';
import {
  HOST_CONTROL_MAX_REQUEST_BYTES,
  validateHostControlRequest,
  type HostControlRequest,
  type HostControlResponse
} from './client.ts';

export type HostControlDispatch = (request: HostControlRequest) => unknown | Promise<unknown>;

export type HostControlAudit = Readonly<{
  requestId: string;
  taskId: string | null;
  operation: string;
  scope: string;
  phase: 'accepted' | 'completed' | 'rejected';
  outcome: string;
  authorityKind: 'host-broker';
  transportKind: 'host-fixed-transport';
  identityDigest: string;
}>;

export type HostControlServerOptions = Readonly<{
  endpoint?: string;
  dispatch: HostControlDispatch;
  audit?: (entry: HostControlAudit) => void;
}>;

function auditFor(request: HostControlRequest, phase: HostControlAudit['phase'], outcome: string): HostControlAudit {
  return {
    requestId: request.id,
    taskId: request.taskId,
    operation: request.operation,
    scope: request.scope,
    phase,
    outcome,
    authorityKind: 'host-broker',
    transportKind: 'host-fixed-transport',
    identityDigest: createHash('sha256').update(`${request.taskId ?? '-'}\0${request.generation ?? '-'}`, 'utf8').digest('hex')
  };
}

function response(request: HostControlRequest, status: HostControlResponse['status'], result: unknown, error: { code: string; message: string } | null): HostControlResponse {
  return { version: 1, id: request.id, status, exitCode: status === 'completed' ? 0 : 1, result, error };
}

async function handleConnection(socket: net.Socket, options: HostControlServerOptions): Promise<void> {
  let input = '';
  let completed = false;
  let processing = false;
  socket.setEncoding('utf8');
  const finish = (value: HostControlResponse): void => {
    if (completed) return;
    completed = true;
    socket.end(`${JSON.stringify(value)}\n`);
  };
  socket.on('data', async (chunk: string) => {
    if (completed || processing) return;
    input += chunk;
    if (Buffer.byteLength(input, 'utf8') > HOST_CONTROL_MAX_REQUEST_BYTES) {
      finish({ version: 1, id: 'invalid', status: 'rejected', exitCode: 1, result: null, error: { code: 'HOST_CONTROL_REQUEST_TOO_LARGE', message: 'request exceeds the control limit' } });
      return;
    }
    const newline = input.indexOf('\n');
    if (newline < 0) return;
    const raw = input.slice(0, newline);
    let request: HostControlRequest;
    try { request = validateHostControlRequest(JSON.parse(raw)); }
    catch (error) {
      finish({ version: 1, id: 'invalid', status: 'rejected', exitCode: 1, result: null, error: { code: 'HOST_CONTROL_REQUEST_INVALID', message: error instanceof Error ? error.message : String(error) } });
      return;
    }
    processing = true;
    options.audit?.(auditFor(request, 'accepted', 'in-progress'));
    try {
      const result = await options.dispatch(request);
      options.audit?.(auditFor(request, 'completed', 'success'));
      finish(response(request, 'completed', result, null));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = /^([A-Z][A-Z0-9_]+)/u.exec(message)?.[1] ?? 'HOST_CONTROL_DISPATCH_FAILED';
      options.audit?.(auditFor(request, 'rejected', 'failure'));
      finish(response(request, 'rejected', null, { code, message }));
    }
  });
}

export type RunningHostControlServer = Readonly<{
  endpoint: string;
  server: net.Server;
  close: () => Promise<void>;
}>;

export async function startHostControlServer(options: HostControlServerOptions): Promise<RunningHostControlServer> {
  const endpoint = options.endpoint ?? resolveHostControlEndpoint();
  prepareHostControlDirectory(endpoint);
  ensureHostControlWorkerToken(endpoint);
  try {
    const existing = fs.lstatSync(endpoint);
    if (existing.isSymbolicLink() || !existing.isSocket()) throw new Error('HOST_CONTROL_ENDPOINT_INVALID');
    fs.unlinkSync(endpoint);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const server = net.createServer({ allowHalfOpen: true }, (socket) => { void handleConnection(socket, options); });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(endpoint, () => { server.off('error', reject); resolve(); });
  });
  fs.chmodSync(endpoint, HOST_CONTROL_SOCKET_MODE);
  const inspection = inspectHostControlEndpoint(endpoint, { uid: process.getuid?.() });
  if (!inspection.ok) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    removeHostControlWorkerToken(endpoint);
    throw new Error(inspection.code ?? 'HOST_CONTROL_ENDPOINT_INVALID');
  }
  return {
    endpoint,
    server,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await fs.promises.rm(endpoint, { force: true });
      removeHostControlWorkerToken(endpoint);
    }
  };
}

export async function serveHostControl(options: HostControlServerOptions, signal?: AbortSignal): Promise<void> {
  const running = await startHostControlServer(options);
  if (!signal) return;
  if (signal.aborted) { await running.close(); return; }
  await new Promise<void>((resolve) => signal.addEventListener('abort', () => { void running.close().then(resolve); }, { once: true }));
}
