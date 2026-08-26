import {
  requestSandboxControl,
  requestSandboxTaskFinalization,
  requestSandboxTaskControl,
  SandboxControlClientError
} from '../sandbox/control/client.ts';
import { normalizeAgentToken, AGENT_USAGE_HINT } from '../agent-clients/tokens.ts';
import { serveSandboxControl } from '../sandbox/control/server.ts';
import { runSandboxControlExecutor } from '../sandbox/control/executor.ts';
import {
  controllerProofFromContext,
  verifyCodexSandboxControllerContext
} from '../agent-clients/adapters/codex-lifecycle/sandbox-controller.ts';

function isCanonicalCodexPrepare(args: readonly string[]): boolean {
  if (args[1] !== 'prepare') return false;
  const clients: string[] = [];
  for (let index = 2; index < args.length; index += 1) {
    if (args[index] === '--client') clients.push(args[index + 1] ?? '');
    else if (args[index]?.startsWith('--client=')) clients.push(args[index]!.slice('--client='.length));
  }
  return clients.length === 1 && clients[0] === 'codex';
}

type FinalizationStatus = 'completed' | 'failed' | 'blocked' | 'unknown';

function writeFinalizationEnvelope(
  status: FinalizationStatus,
  accepted: boolean,
  error: { code: string; message: string; retryable: boolean },
  changed = false,
  result: unknown = null
): void {
  process.stdout.write(`${JSON.stringify({ version: 1, status, changed, accepted, result, error })}\n`);
}

function finalizationErrorStatus(error: { retryable: boolean; code: string }): FinalizationStatus {
  if (error.code === 'SANDBOX_CONTROL_RESULT_UNKNOWN') return 'unknown';
  return error.retryable ? 'blocked' : 'failed';
}

function sandboxFinalizationClient(args: string[]): void {
  if (args.length !== 4 || !args[0] || args[1] !== 'complete' || args[2] !== '--agent' || !args[3]) {
    const error = { code: 'TASK_FINALIZATION_PAYLOAD_INVALID', message: 'task ref, complete intent, and --agent are required', retryable: false };
    writeFinalizationEnvelope('failed', false, error);
    process.stderr.write('Usage: agent-infra-internal task-finalization <N | TASK-id> complete --agent <agent>\n');
    process.exitCode = 1;
    return;
  }
  const agent = normalizeAgentToken(args[3]);
  if (!agent) {
    const error = { code: 'TASK_FINALIZATION_PAYLOAD_INVALID', message: `invalid --agent: ${AGENT_USAGE_HINT}`, retryable: false };
    writeFinalizationEnvelope('failed', false, error);
    process.exitCode = 1;
    return;
  }
  let response;
  try {
    response = requestSandboxTaskFinalization({ agent });
  } catch (error) {
    if (!(error instanceof SandboxControlClientError)) throw error;
    writeFinalizationEnvelope(finalizationErrorStatus(error.detail), error.accepted, error.detail);
    process.stderr.write(`${error.detail.message}\n`);
    process.exitCode = error.detail.code === 'SANDBOX_CONTROL_RESULT_UNKNOWN' ? 1 : error.detail.retryable ? 2 : 1;
    return;
  }
  if (response.phase === 'rejected') {
    const error = response.error ?? {
      code: 'SANDBOX_CONTROL_REJECTED',
      message: 'sandbox control rejected the finalization request',
      retryable: false
    };
    writeFinalizationEnvelope(finalizationErrorStatus(error), error.code === 'SANDBOX_CONTROL_RESULT_UNKNOWN', error);
    process.stderr.write(`${error.message}\n`);
    process.exitCode = error.code === 'SANDBOX_CONTROL_RESULT_UNKNOWN' ? 1 : error.retryable ? 2 : 1;
    return;
  }
  process.stdout.write(response.stdout);
  process.stderr.write(response.stderr);
  process.exitCode = response.exitCode ?? 1;
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
    if (family === 'task-finalization') {
      sandboxFinalizationClient(commandArgs);
      return;
    }
    let response;
    try {
      if (family === 'task-orchestration' && isCanonicalCodexPrepare(commandArgs)) {
        const contextPath = process.env.AGENT_INFRA_CODEX_CONTROLLER_CONTEXT;
        const proof = contextPath
          ? controllerProofFromContext(verifyCodexSandboxControllerContext(contextPath))
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
