import {
  recoverSandboxControl,
  requestSandboxControl,
  SandboxControlClientError
} from '../sandbox/control/client.ts';
import { serveSandboxControl } from '../sandbox/control/server.ts';
import { runSandboxControlExecutor } from '../sandbox/control/executor.ts';
import { ensureInternalHandlerRoute, internalHandlerRoute } from './cli-route-inventory.ts';
import { parseTaskCreateResult, taskCreateExitCode } from '../task/create-service.ts';

function writeClientError(error: SandboxControlClientError): void {
  process.stderr.write(`${error.detail.message}\n`);
  if (error.requestId) process.stderr.write(`SANDBOX_CONTROL_REQUEST_ID: ${error.requestId}\n`);
}

function recoveredExitCode(response: Awaited<ReturnType<typeof recoverSandboxControl>>): number {
  if (response.phase !== 'completed') return response.exitCode ?? 1;
  try {
    const result = parseTaskCreateResult(JSON.parse(response.stdout));
    if (result.control?.requestId === response.id) return taskCreateExitCode(result);
  } catch {
    // Other control families use their own result envelopes.
  }
  return response.exitCode ?? 1;
}

async function sandboxControl(args: string[]): Promise<void> {
  if (!ensureInternalHandlerRoute('sandbox-control', args)) return;
  const [operation, ...rest] = args;
  if (internalHandlerRoute('sandbox-control', 'serve', operation ?? '')) {
    const manifestIndex = rest.indexOf('--manifest');
    const manifest = manifestIndex >= 0 ? rest[manifestIndex + 1] : undefined;
    if (!manifest) throw new Error('sandbox-control serve requires --manifest');
    const controller = new AbortController();
    const abort = () => controller.abort();
    process.once('SIGINT', abort);
    process.once('SIGTERM', abort);
    try {
      await serveSandboxControl(manifest, controller.signal);
    } finally {
      process.off('SIGINT', abort);
      process.off('SIGTERM', abort);
    }
    return;
  }
  if (internalHandlerRoute('sandbox-control', 'execute', operation ?? '')) {
    const requestIndex = rest.indexOf('--request');
    const nonceIndex = rest.indexOf('--nonce');
    const request = requestIndex >= 0 ? rest[requestIndex + 1] : undefined;
    const nonce = nonceIndex >= 0 ? rest[nonceIndex + 1] : undefined;
    if (!request || !nonce) throw new Error('sandbox-control execute requires --request and --nonce');
    await runSandboxControlExecutor(request, nonce);
    return;
  }
  if (internalHandlerRoute('sandbox-control', 'recover', operation ?? '')) {
    if (rest.length !== 1 || !rest[0]) throw new Error('sandbox-control recover requires <request-id>');
    let response;
    try {
      response = recoverSandboxControl(rest[0]);
    } catch (error) {
      if (!(error instanceof SandboxControlClientError)) throw error;
      writeClientError(error);
      process.exitCode = error.detail.code === 'SANDBOX_CONTROL_RESULT_UNKNOWN' ? 1 : error.detail.retryable ? 75 : 1;
      return;
    }
    process.stdout.write(response.stdout);
    process.stderr.write(response.stderr);
    process.exitCode = response.phase === 'rejected'
      ? response.error?.retryable ? 75 : 1
      : recoveredExitCode(response);
    return;
  }
  if (internalHandlerRoute('sandbox-control', 'client', operation ?? '')) {
    const [family = '', ...commandArgs] = rest;
    let response;
    try {
      response = requestSandboxControl({ family, args: commandArgs });
    } catch (error) {
      if (!(error instanceof SandboxControlClientError)) throw error;
      writeClientError(error);
      process.exitCode = error.detail.retryable ? 75 : 1;
      return;
    }
    process.stdout.write(response.stdout);
    process.stderr.write(response.stderr);
    if (response.phase === 'rejected') {
      process.stderr.write(response.error?.message ?? response.stderr);
      process.exitCode = response.error?.retryable ? 75 : 1;
    } else {
      process.exitCode = response.exitCode ?? 1;
    }
    return;
  }
  throw new Error('Usage: agent-infra-internal sandbox-control serve --manifest <path> | execute --request <path> --nonce <nonce> | client <family> [args...] | recover <request-id>');
}

export { sandboxControl };
