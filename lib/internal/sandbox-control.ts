import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  recoverSandboxControl,
  requestSandboxControl,
  requestSandboxTaskFinalization,
  requestSandboxTaskControl,
  requestSandboxTaskWorkflow,
  resolveVisibleActiveShortId,
  SandboxControlClientError
} from '../sandbox/control/client.ts';
import { normalizeAgentToken, AGENT_USAGE_HINT } from '../agent-clients/tokens.ts';
import { serveSandboxControl } from '../sandbox/control/server.ts';
import { runSandboxControlExecutor } from '../sandbox/control/executor.ts';
import {
  controllerProofFromContext,
  verifyCodexSandboxControllerContextWithWarnings
} from '../agent-clients/adapters/codex-lifecycle/sandbox-controller.ts';
import { ensureInternalHandlerRoute, internalHandlerRoute } from './cli-route-inventory.ts';
import { parseTaskCreateResult, taskCreateExitCode } from '../task/create-service.ts';
import { createTaskWorkflowRequest } from '../sandbox/control/task-workflow.ts';
import { computeLifecycleBuildIdentity } from '../agent-clients/adapters/codex-lifecycle/build-identity.ts';
import { routeOrchestration } from '../task/orchestration.ts';
import { parseArtifactName } from '../task/artifact-name.ts';
import type { LifecycleAuthorityRequestV1 } from '../task/control-authority.ts';

function valueAfter(args: readonly string[], flag: string): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === flag) return args[index + 1];
    if (args[index]?.startsWith(`${flag}=`)) return args[index]!.slice(flag.length + 1);
  }
  return undefined;
}

function withoutValue(args: readonly string[], flag: string): string[] {
  const result: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === flag) { index += 1; continue; }
    if (args[index]?.startsWith(`${flag}=`)) continue;
    result.push(args[index]!);
  }
  return result;
}

function lifecycleIds(authorityRef: string, taskId: string): Readonly<{ operationId: string; lifecycleRequestId: string }> {
  const digest = (label: string) => createHash('sha256')
    .update(`${label}\0${taskId}\0${authorityRef}`, 'utf8')
    .digest('hex');
  return { operationId: digest('operation'), lifecycleRequestId: digest('lifecycle-request') };
}

function lifecycleAuthorityIdentity(
  authorityRef: string,
  taskId: string,
  requestId: string,
  phase: LifecycleAuthorityRequestV1['phase'],
  family: LifecycleAuthorityRequestV1['family'],
  artifact: string,
  round: number
): LifecycleAuthorityRequestV1 | undefined {
  const contextPath = process.env.AGENT_INFRA_CODEX_CONTROLLER_CONTEXT;
  if (!authorityRef || !contextPath) return undefined;
  const routed = verifyCodexSandboxControllerContextWithWarnings(contextPath, { repoRoot: process.cwd() });
  const buildIdentity = computeLifecycleBuildIdentity(process.cwd());
  const hookDefinitionHash = createHash('sha256')
    .update(readFileSync(path.join(process.cwd(), '.codex', 'hooks.json')))
    .digest('hex');
  const ids = lifecycleIds(authorityRef, taskId);
  return {
    version: 1,
    requestId,
    operationId: ids.operationId,
    phase,
    taskId,
    family,
    artifact,
    round,
    lifecycleRequestId: ids.lifecycleRequestId,
    authorityRef,
    expectedControlGeneration: routed.context.controlGeneration,
    expectedControllerInstanceDigest: routed.context.controllerInstanceDigest,
    expectedBuildIdentityDigest: createHash('sha256').update(JSON.stringify(buildIdentity)).digest('hex'),
    expectedHookDefinitionHash: hookDefinitionHash
  };
}

function lifecycleAuthoritySelector(args: readonly string[]): LifecycleAuthorityRequestV1 | undefined {
  if (!isCanonicalCodexPrepare(args)) return undefined;
  const authorityRef = valueAfter(args, '--capability-ref');
  const taskId = args[0];
  if (!authorityRef || !taskId) return undefined;
  const routed = routeOrchestration(taskId);
  if (!routed.next || !['analysis', 'plan', 'code'].includes(routed.next.stage)) return undefined;
  return lifecycleAuthorityIdentity(
    authorityRef,
    taskId,
    randomUUID(),
    'orchestration.prepare',
    routed.next.stage === 'analysis' ? 'analysis' : routed.next.stage === 'plan' ? 'plan' : 'code',
    routed.next.artifact,
    routed.next.round
  );
}

function lifecycleWorkflowAuthoritySelector(
  originalArgs: readonly string[],
  workflow: ReturnType<typeof createTaskWorkflowRequest>
): LifecycleAuthorityRequestV1 | undefined {
  const authorityRef = valueAfter(originalArgs, '--capability-ref');
  if (!authorityRef) return undefined;
  if (workflow.operation === 'artifact-finalize-local') {
    const family = valueAfter(workflow.args, '--family');
    const artifact = valueAfter(workflow.args, '--artifact');
    const parsed = artifact ? parseArtifactName(artifact) : null;
    if ((family !== 'analysis' && family !== 'plan' && family !== 'code')
      || !parsed || parsed.family !== family) return undefined;
    return lifecycleAuthorityIdentity(authorityRef, workflow.taskId, workflow.id,
      'artifact.finalize-local', family, artifact!, parsed.round);
  }
  if (workflow.operation !== 'event') return undefined;
  const completed = /^(analysis|plan|code)\.completed$/u.exec(workflow.args[1] ?? '');
  const artifact = valueAfter(workflow.args, '--artifact');
  const parsed = artifact ? parseArtifactName(artifact) : null;
  if (!completed || !parsed || parsed.family !== completed[1]) return undefined;
  return lifecycleAuthorityIdentity(authorityRef, workflow.taskId, workflow.id,
    'task-event.completed', completed[1] as LifecycleAuthorityRequestV1['family'], artifact!, parsed.round);
}

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
    writeClientError(error);
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
    if (family === 'task-finalization') {
      sandboxFinalizationClient(commandArgs);
      return;
    }
    if (family === 'task-workflow') {
      const command = commandArgs[0] as Parameters<typeof createTaskWorkflowRequest>[0] | undefined;
      const taskId = process.env.AGENT_INFRA_TASK_ID;
      const generation = process.env.AGENT_INFRA_CONTROL_GENERATION;
      if (!command || !taskId || !generation) {
        process.stdout.write(`${JSON.stringify({ status: 'failed', changed: false, error: { code: 'SANDBOX_CONTROL_REQUEST_INVALID', message: 'task-workflow requires a bound task and generation' } })}\n`);
        process.exitCode = 1;
        return;
      }
      let workflow;
      try {
        const args = withoutValue(commandArgs.slice(1), '--capability-ref');
        if (/^\d+$/.test(args[0] ?? '')) {
          const resolved = resolveVisibleActiveShortId(args[0]!);
          if (resolved !== taskId) throw new Error('SANDBOX_TASK_REF_MISMATCH');
          args[0] = resolved;
        }
        workflow = createTaskWorkflowRequest(command, args, taskId, generation);
      }
      catch (error) {
        process.stdout.write(`${JSON.stringify({ status: 'failed', changed: false, error: { code: 'SANDBOX_CONTROL_REQUEST_INVALID', message: error instanceof Error ? error.message : String(error) } })}\n`);
        process.exitCode = 1;
        return;
      }
      let response;
      try {
        const authority = lifecycleWorkflowAuthoritySelector(commandArgs, workflow);
        response = requestSandboxTaskWorkflow({
          workflow,
          ...(authority ? { authority } : {})
        });
      }
      catch (error) {
        if (!(error instanceof SandboxControlClientError)) throw error;
        writeClientError(error);
        process.exitCode = error.detail.retryable ? 75 : 1;
        return;
      }
      process.stdout.write(response.stdout);
      process.stderr.write(response.stderr);
      process.exitCode = response.phase === 'rejected' ? response.error?.retryable ? 75 : 1 : response.exitCode ?? 1;
      return;
    }
    let response;
    try {
      if (family === 'task-orchestration' && isCanonicalCodexPrepare(commandArgs)) {
        const contextPath = process.env.AGENT_INFRA_CODEX_CONTROLLER_CONTEXT;
        const proof = contextPath
          ? controllerProofFromContext(verifyCodexSandboxControllerContextWithWarnings(contextPath).context)
          : null;
        const authority = lifecycleAuthoritySelector(commandArgs);
        response = requestSandboxTaskControl({
          family,
          args: commandArgs,
          controllerProof: authority ? null : proof,
          ...(authority ? { authority } : {})
        });
      } else {
        response = requestSandboxControl({ family, args: commandArgs });
      }
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
