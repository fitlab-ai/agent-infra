import {
  requestSandboxControl,
  requestSandboxTaskControl,
  SandboxControlClientError
} from '../sandbox/control/client.ts';
import { serveSandboxControl } from '../sandbox/control/server.ts';
import { runSandboxControlExecutor } from '../sandbox/control/executor.ts';
import {
  controllerProofFromContext,
  verifyCodexSandboxControllerContext
} from '../agent-clients/adapters/codex-lifecycle/controller-context.ts';

function isCanonicalCodexPrepare(args: readonly string[]): boolean {
  if (args[1] !== 'prepare') return false;
  const clients: string[] = [];
  for (let index = 2; index < args.length; index += 1) {
    if (args[index] === '--client') clients.push(args[index + 1] ?? '');
    else if (args[index]?.startsWith('--client=')) clients.push(args[index]!.slice('--client='.length));
  }
  return clients.length === 1 && clients[0] === 'codex';
}

async function sandboxControl(args: string[]): Promise<void> {
  const [operation, ...rest] = args;
  if (operation === 'serve') {
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
  if (operation === 'execute') {
    const requestIndex = rest.indexOf('--request');
    const nonceIndex = rest.indexOf('--nonce');
    const request = requestIndex >= 0 ? rest[requestIndex + 1] : undefined;
    const nonce = nonceIndex >= 0 ? rest[nonceIndex + 1] : undefined;
    if (!request || !nonce) throw new Error('sandbox-control execute requires --request and --nonce');
    await runSandboxControlExecutor(request, nonce);
    return;
  }
  if (operation === 'client') {
    const [family = '', ...commandArgs] = rest;
    let response;
    try {
      if (family === 'task-orchestration' && isCanonicalCodexPrepare(commandArgs)) {
        const contextPath = process.env.AGENT_INFRA_CODEX_CONTROLLER_CONTEXT;
        const taskId = process.env.AGENT_INFRA_TASK_ID;
        const proof = contextPath && taskId
          ? controllerProofFromContext(verifyCodexSandboxControllerContext(contextPath, taskId))
          : null;
        response = requestSandboxTaskControl({ family, args: commandArgs, controllerProof: proof });
      } else {
        response = requestSandboxControl({ family, args: commandArgs });
      }
    } catch (error) {
      if (!(error instanceof SandboxControlClientError)) throw error;
      process.stderr.write(`${error.detail.message}\n`);
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
  throw new Error('Usage: agent-infra-internal sandbox-control serve --manifest <path> | execute --request <path> --nonce <nonce> | client <family> [args...]');
}

export { sandboxControl };
