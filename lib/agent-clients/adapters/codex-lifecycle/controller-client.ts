import { SandboxControlClientError, requestSandboxAgentOperation } from '../../../sandbox/control/client.ts';
import type { SandboxControlResponse } from '../../../sandbox/control/protocol.ts';
import type { ProcessIdentity } from '../../../server/process-state.ts';
import type { CodexControllerLeaseProofV1, CodexControllerOpened } from './controller-registration.ts';

type ControllerClosed = Readonly<{ version: 1; status: 'closed'; changed: boolean; lease: null; error: null }>;
type ControllerVerified = Readonly<{
  version: 1; status: 'verified'; changed: false; lease: null;
  binding: Readonly<{ taskId: string; controlGeneration: string; controllerInstanceDigest: string }>;
  error: null;
}>;
type ControllerResult = CodexControllerOpened | ControllerClosed | ControllerVerified;

function fail(code: string, message: string, accepted = true): never {
  throw new SandboxControlClientError({ code, message: `${code}: ${message}`, retryable: false }, accepted);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

function validProcess(value: unknown): value is ProcessIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const process = value as Record<string, unknown>;
  return exactKeys(process, ['pid', 'startTime'])
    && Number.isSafeInteger(process.pid) && (process.pid as number) > 0
    && Number.isSafeInteger(process.startTime) && (process.startTime as number) >= 0;
}

function validBuild(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const build = value as Record<string, unknown>;
  return exactKeys(build, ['internalExecutableBuildHash', 'lifecycleContractHash', 'packageVersion', 'protocolVersion'])
    && build.protocolVersion === 3
    && typeof build.packageVersion === 'string' && build.packageVersion.length > 0
    && typeof build.internalExecutableBuildHash === 'string' && /^[a-f0-9]{64}$/u.test(build.internalExecutableBuildHash)
    && typeof build.lifecycleContractHash === 'string' && /^[a-f0-9]{64}$/u.test(build.lifecycleContractHash);
}

function parseCodexControllerResult(response: SandboxControlResponse): ControllerResult {
  if (response.phase !== 'completed' || response.error !== null || response.stderr !== '') {
    fail('SANDBOX_CONTROL_RESULT_INVALID', 'controller result outer response is invalid');
  }
  let value: unknown;
  try {
    if (!response.stdout.endsWith('\n') || response.stdout.slice(0, -1).includes('\n')) throw new Error('not canonical');
    value = JSON.parse(response.stdout);
  } catch {
    fail('SANDBOX_CONTROL_RESULT_INVALID', 'controller result payload is invalid');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('SANDBOX_CONTROL_RESULT_INVALID', 'controller result payload is invalid');
  }
  const result = value as Record<string, unknown>;
  const keys = result.status === 'verified'
    ? ['binding', 'changed', 'error', 'lease', 'status', 'version']
    : ['changed', 'error', 'lease', 'status', 'version'];
  if (!exactKeys(result, keys) || result.version !== 1
    || !['opened', 'closed', 'failed', 'verified'].includes(result.status as string)) {
    fail('SANDBOX_CONTROL_RESULT_INVALID', 'controller result schema is invalid');
  }
  if (result.status === 'failed') {
    const error = result.error as Record<string, unknown> | null;
    if (response.exitCode !== 1 || result.changed !== false || result.lease !== null || !error
      || !exactKeys(error, ['code', 'message', 'retryable'])
      || typeof error.code !== 'string' || !/^[A-Z][A-Z0-9_]+$/u.test(error.code)
      || typeof error.message !== 'string' || error.retryable !== false) {
      fail('SANDBOX_CONTROL_RESULT_INVALID', 'controller failure result is invalid');
    }
    fail(error.code, error.message);
  }
  if (response.exitCode !== 0 || result.error !== null) {
    fail('SANDBOX_CONTROL_RESULT_INVALID', 'controller success result is invalid');
  }
  if (result.status === 'closed') {
    if (typeof result.changed !== 'boolean' || result.lease !== null) fail('SANDBOX_CONTROL_RESULT_INVALID', 'controller close result is invalid');
    return result as unknown as ControllerClosed;
  }
  if (result.status === 'verified') {
    const binding = result.binding as Record<string, unknown> | null;
    if (result.changed !== false || result.lease !== null || !binding
      || !exactKeys(binding, ['controllerInstanceDigest', 'controlGeneration', 'taskId'])
      || typeof binding.taskId !== 'string' || binding.taskId.length === 0
      || typeof binding.controlGeneration !== 'string' || binding.controlGeneration.length === 0
      || typeof binding.controllerInstanceDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(binding.controllerInstanceDigest)) {
      fail('SANDBOX_CONTROL_RESULT_INVALID', 'controller verify result is invalid');
    }
    return result as unknown as ControllerVerified;
  }
  const lease = result.lease as Record<string, unknown> | null;
  if (result.changed !== true || !lease
    || !exactKeys(lease, ['buildIdentity', 'controlGeneration', 'controllerInstanceDigest', 'controllerProcess', 'expiresAt', 'issuedAt', 'leaseId', 'leaseSecret', 'taskId', 'version'])
    || lease.version !== 1 || typeof lease.leaseId !== 'string' || !/^[a-f0-9]{64}$/u.test(lease.leaseId)
    || typeof lease.leaseSecret !== 'string' || !/^[a-f0-9]{64}$/u.test(lease.leaseSecret)
    || typeof lease.taskId !== 'string' || lease.taskId.length === 0
    || typeof lease.controlGeneration !== 'string' || lease.controlGeneration.length === 0
    || typeof lease.controllerInstanceDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(lease.controllerInstanceDigest)
    || !validProcess(lease.controllerProcess) || !validBuild(lease.buildIdentity)
    || !Number.isSafeInteger(lease.issuedAt) || !Number.isSafeInteger(lease.expiresAt)
    || (lease.expiresAt as number) <= (lease.issuedAt as number)) {
    fail('SANDBOX_CONTROL_RESULT_INVALID', 'controller open result is invalid');
  }
  return result as unknown as CodexControllerOpened;
}

function requestController(params: Readonly<{
  command: 'open' | 'close' | 'verify';
  controllerProcess: ProcessIdentity;
  controllerProof: CodexControllerLeaseProofV1 | null;
  channelDir?: string;
  statusDir?: string;
  token?: string;
  generation?: string;
  timeoutMs?: number;
}>): ControllerResult {
  const result = parseCodexControllerResult(requestSandboxAgentOperation({
    agentClient: 'codex',
    operation: `controller.${params.command}`,
    payload: params.command === 'open'
      ? { controllerProcess: params.controllerProcess }
      : { proof: params.controllerProof },
    ...params
  }));
  if (result.status === 'opened'
    && (result.lease.controlGeneration !== (params.generation ?? process.env.AGENT_INFRA_CONTROL_GENERATION)
      || result.lease.controllerProcess.pid !== params.controllerProcess.pid
      || result.lease.controllerProcess.startTime !== params.controllerProcess.startTime)) {
    fail('SANDBOX_CONTROL_RESULT_INVALID', 'controller result does not match the request');
  }
  return result;
}

function requestCodexControllerOpen(params: Omit<Parameters<typeof requestController>[0], 'command' | 'controllerProof'>): CodexControllerOpened {
  const result = requestController({ ...params, command: 'open', controllerProof: null });
  if (result.status !== 'opened') fail('SANDBOX_CONTROL_RESULT_INVALID', 'controller open returned the wrong result');
  return result;
}

function requestCodexControllerClose(params: Omit<Parameters<typeof requestController>[0], 'command'>): ControllerClosed {
  const result = requestController({ ...params, command: 'close' });
  if (result.status !== 'closed') fail('SANDBOX_CONTROL_RESULT_INVALID', 'controller close returned the wrong result');
  return result;
}

function requestCodexControllerVerify(params: Readonly<{
  controllerProof: CodexControllerLeaseProofV1;
  channelDir?: string;
  statusDir?: string;
  token?: string;
  generation?: string;
  timeoutMs?: number;
}>): ControllerVerified {
  const result = requestController({ ...params, controllerProcess: params.controllerProof.controllerProcess, command: 'verify' });
  if (result.status !== 'verified') fail('SANDBOX_CONTROL_RESULT_INVALID', 'controller verify returned the wrong result');
  return result;
}

export { parseCodexControllerResult, requestCodexControllerClose, requestCodexControllerOpen, requestCodexControllerVerify };
