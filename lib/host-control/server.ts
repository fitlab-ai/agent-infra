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
import { acquireFileLock } from '../fs/file-lock.ts';
import { appendHostControlAudit } from './audit.ts';

export type HostControlDispatch = (request: HostControlRequest) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

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

function failedResponse(id: string, status: 'rejected' | 'unknown', code: string, message: string): HostControlResponse {
  const error = { code, message };
  const stdout = `${JSON.stringify({ status: 'failed', changed: status === 'rejected' ? false : null, error })}\n`;
  return { version: 1, id, status, exitCode: 1, stdout, stderr: '', error };
}

async function handleConnection(socket: net.Socket, options: HostControlServerOptions): Promise<void> {
  await new Promise<void>((resolve) => {
    let input = '';
    let completed = false;
    let processing = false;
    socket.setEncoding('utf8');
    // A disconnected caller does not cancel an already dispatched domain operation.
    socket.on('error', () => socket.destroy());
    socket.on('close', () => { if (!processing) resolve(); });
    socket.on('end', () => { if (!processing) socket.end(); });
    const finish = (value: HostControlResponse): void => {
      if (completed || socket.destroyed) return;
      completed = true;
      socket.end(`${JSON.stringify(value)}\n`);
    };
    socket.on('data', async (chunk: string) => {
      if (completed || processing) return;
      input += chunk;
      if (Buffer.byteLength(input, 'utf8') > HOST_CONTROL_MAX_REQUEST_BYTES) {
        finish(failedResponse('invalid', 'rejected', 'HOST_CONTROL_REQUEST_TOO_LARGE', 'request exceeds the control limit'));
        return;
      }
      const newline = input.indexOf('\n');
      if (newline < 0) return;
      const raw = input.slice(0, newline);
      let request: HostControlRequest;
      try { request = validateHostControlRequest(JSON.parse(raw)); }
      catch (error) {
        finish(failedResponse('invalid', 'rejected', 'HOST_CONTROL_REQUEST_INVALID', error instanceof Error ? error.message : String(error)));
        return;
      }
      processing = true;
      let started = false;
      try {
        options.audit?.(auditFor(request, 'accepted', 'in-progress'));
        started = true;
        const result = await options.dispatch(request);
        options.audit?.(auditFor(request, 'completed', result.exitCode === 0 ? 'success' : 'failure'));
        finish({ version: 1, id: request.id, status: 'completed', ...result, error: null });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const code = /^([A-Z][A-Z0-9_]+)/u.exec(message)?.[1] ?? 'HOST_CONTROL_DISPATCH_FAILED';
        const status = started ? 'unknown' : 'rejected';
        try { options.audit?.(auditFor(request, started ? 'completed' : 'rejected', status)); }
        catch { /* Return the uncertainty even when the audit sink is unavailable. */ }
        finish(failedResponse(request.id, status, code, message));
      } finally {
        resolve();
      }
    });
  });
}

export type RunningHostControlServer = Readonly<{
  endpoint: string;
  server: net.Server;
  close: () => Promise<void>;
}>;

export async function startHostControlServer(options: HostControlServerOptions): Promise<RunningHostControlServer> {
  const endpoint = options.endpoint ?? resolveHostControlEndpoint();
  const audit = options.audit ?? ((entry: HostControlAudit) => appendHostControlAudit(endpoint, entry));
  prepareHostControlDirectory(endpoint);
  const lock = acquireFileLock(`${endpoint}.lock`);
  let server: net.Server | undefined;
  try {
    ensureHostControlWorkerToken(endpoint);
    try {
      const existing = fs.lstatSync(endpoint);
      if (existing.isSymbolicLink() || !existing.isSocket()) throw new Error('HOST_CONTROL_ENDPOINT_INVALID');
      fs.unlinkSync(endpoint);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const connections = new Set<Promise<void>>();
    server = net.createServer({ allowHalfOpen: true }, (socket) => {
      const connection = handleConnection(socket, { ...options, audit });
      connections.add(connection);
      void connection.finally(() => connections.delete(connection));
    });
    const listeningServer = server;
    await new Promise<void>((resolve, reject) => {
      listeningServer.once('error', reject);
      listeningServer.listen(endpoint, () => { listeningServer.off('error', reject); resolve(); });
    });
    fs.chmodSync(endpoint, HOST_CONTROL_SOCKET_MODE);
    const inspection = inspectHostControlEndpoint(endpoint, { uid: process.getuid?.() });
    if (!inspection.ok) {
      await new Promise<void>((resolve) => listeningServer.close(() => resolve()));
      removeHostControlWorkerToken(endpoint);
      throw new Error(inspection.code ?? 'HOST_CONTROL_ENDPOINT_INVALID');
    }
    let closing: Promise<void> | undefined;
    return {
      endpoint,
      server,
      close: () => closing ??= (async () => {
        try {
          await new Promise<void>((resolve) => listeningServer.close(() => resolve()));
          await Promise.all(connections);
          await fs.promises.rm(endpoint, { force: true });
          removeHostControlWorkerToken(endpoint);
        } finally { lock.release(); }
      })()
    };
  } catch (error) {
    if (server?.listening) await new Promise<void>((resolve) => server!.close(() => resolve()));
    lock.release();
    throw error;
  }
}

export async function serveHostControl(options: HostControlServerOptions, signal?: AbortSignal): Promise<void> {
  const running = await startHostControlServer(options);
  if (!signal) return;
  if (signal.aborted) { await running.close(); return; }
  await new Promise<void>((resolve) => signal.addEventListener('abort', () => { void running.close().then(resolve); }, { once: true }));
}
