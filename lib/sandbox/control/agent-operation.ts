import { getAgentClientAdapter } from '../../agent-clients/registry.ts';
import type { AgentClientSandboxControlOperation } from '../../agent-clients/adapter.ts';
import type { SandboxControlManifest, SandboxAgentClientRequest } from './protocol.ts';

function operationFor(request: SandboxAgentClientRequest) {
  const adapter = getAgentClientAdapter(request.agentClient);
  const operation = adapter.sandboxControlOperation;
  if (!operation) throw new Error('SANDBOX_CONTROL_AGENT_OPERATION_UNSUPPORTED');
  return operation;
}

function validateAgentClientOperation(request: SandboxAgentClientRequest, manifest: SandboxControlManifest): void {
  operationFor(request).validate({
    operation: request.operation,
    payload: request.payload,
    manifest
  });
}

function executeAgentClientOperation(
  request: SandboxAgentClientRequest,
  manifest: SandboxControlManifest,
  manifestPath: string,
  override?: AgentClientSandboxControlOperation
) {
  return (override ?? operationFor(request)).execute({
    operation: request.operation,
    payload: request.payload,
    manifest,
    manifestPath
  });
}

function recoverAgentClientOperation(params: Readonly<{
  request: SandboxAgentClientRequest;
  manifest: SandboxControlManifest;
  manifestPath: string;
  stdout: string | null;
}>): Readonly<Record<string, unknown>> {
  const operation = operationFor(params.request);
  return operation.recover?.({
    operation: params.request.operation,
    manifest: params.manifest,
    manifestPath: params.manifestPath,
    stdout: params.stdout
  }) ?? { consistent: false };
}

export { executeAgentClientOperation, recoverAgentClientOperation, validateAgentClientOperation };
