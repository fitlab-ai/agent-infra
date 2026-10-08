import type { ProcessIdentity } from '../../../server/process-state.ts';
import {
  closeCodexControllerRegistration,
  CodexControllerRegistrationError,
  openCodexControllerRegistration,
  readCodexControllerRegistration,
  resolveCodexControllerBinding,
  type CodexControllerLeaseProofV1
} from './controller-registration.ts';
import { computeLifecycleBuildIdentity } from './build-identity.ts';

function validProcess(value: unknown): value is ProcessIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const process = value as Record<string, unknown>;
  return Object.keys(process).sort().join(',') === 'pid,startTime'
    && Number.isSafeInteger(process.pid) && (process.pid as number) > 0
    && Number.isSafeInteger(process.startTime) && (process.startTime as number) >= 0;
}

function validProof(value: unknown): value is CodexControllerLeaseProofV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proof = value as Record<string, unknown>;
  return Object.keys(proof).sort().join(',') === 'controllerProcess,leaseId,leaseSecret,version'
    && proof.version === 1
    && typeof proof.leaseId === 'string' && /^[a-f0-9]{64}$/u.test(proof.leaseId)
    && typeof proof.leaseSecret === 'string' && /^[a-f0-9]{64}$/u.test(proof.leaseSecret)
    && validProcess(proof.controllerProcess);
}

function validate(params: Readonly<{
  operation: string;
  payload: Record<string, unknown>;
  manifest: { mode: string; taskId: string | null };
}>): void {
  const { operation, payload, manifest } = params;
  const expectedKeys = operation === 'controller.open' ? ['controllerProcess'] : ['proof'];
  if (!['controller.open', 'controller.close', 'controller.verify'].includes(operation)
    || Object.keys(payload).sort().join(',') !== expectedKeys.sort().join(',')
    || (operation === 'controller.open'
      ? !validProcess(payload.controllerProcess)
      : !validProof(payload.proof))) {
    throw new Error('SANDBOX_CONTROL_REQUEST_INVALID: controller operation payload is invalid');
  }
  if (manifest.mode !== 'task-bound' || !manifest.taskId) {
    throw new Error('SANDBOX_CONTROL_BRANCH_ONLY: controller operations require a task-bound sandbox');
  }
}

async function execute(params: Readonly<{
  operation: string;
  payload: Record<string, unknown>;
  manifest: Parameters<typeof openCodexControllerRegistration>[0]['manifest'];
  manifestPath: string;
}>): Promise<Readonly<{ exitCode: number; stdout: string; stderr: string }>> {
  const { operation, payload, manifest, manifestPath } = params;
  try {
    const result = operation === 'controller.open'
      ? openCodexControllerRegistration({
        manifest,
        manifestPath,
        controllerProcess: payload.controllerProcess as ProcessIdentity,
        buildIdentity: computeLifecycleBuildIdentity(manifest.repoRoot)
      })
      : operation === 'controller.close'
        ? closeCodexControllerRegistration({
          manifest,
          manifestPath,
          proof: payload.proof as CodexControllerLeaseProofV1
        })
        : (() => {
          const binding = resolveCodexControllerBinding({
            manifest,
            manifestPath,
            proof: payload.proof as CodexControllerLeaseProofV1,
            buildIdentity: computeLifecycleBuildIdentity(manifest.repoRoot)
          });
          return {
            version: 1,
            status: 'verified',
            changed: false,
            lease: null,
            binding: {
              taskId: manifest.taskId,
              controlGeneration: binding.controlGeneration,
              controllerInstanceDigest: binding.instanceDigest
            },
            error: null
          };
        })();
    return { exitCode: 0, stdout: `${JSON.stringify(result)}\n`, stderr: '' };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = error instanceof CodexControllerRegistrationError
      ? error.code
      : /^([A-Z][A-Z0-9_]+)/u.exec(message)?.[1] ?? 'CODEX_SANDBOX_CONTROLLER_FAILED';
    return {
      exitCode: 1,
      stdout: `${JSON.stringify({
        version: 1,
        status: 'failed',
        changed: false,
        lease: null,
        error: { code, message, retryable: false }
      })}\n`,
      stderr: ''
    };
  }
}

function recover(params: Readonly<{
  operation: string;
  manifest: Parameters<typeof openCodexControllerRegistration>[0]['manifest'];
  manifestPath: string;
  stdout: string | null;
}>): Readonly<Record<string, unknown>> {
  if (params.stdout === null) return { consistent: false };
  let output: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(params.stdout);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { consistent: false };
    output = parsed as Record<string, unknown>;
  } catch {
    return { consistent: false };
  }
  if (output.error !== null || typeof output.status !== 'string') return { consistent: false };
  try {
    const registration = readCodexControllerRegistration(params.manifestPath);
    if (params.operation === 'controller.open') {
      const lease = output.lease as Record<string, unknown> | null;
      return { consistent: output.status === 'opened' && output.changed === true
        && lease?.controlGeneration === registration.controlGeneration
        && lease?.controllerInstanceDigest === registration.controllerInstanceDigest
        && registration.controlGeneration === params.manifest.generation };
    }
    if (params.operation === 'controller.verify') {
      const binding = output.binding as Record<string, unknown> | null;
      return { consistent: output.status === 'verified' && output.changed === false
        && binding?.controlGeneration === registration.controlGeneration
        && binding?.controllerInstanceDigest === registration.controllerInstanceDigest };
    }
    return { consistent: false };
  } catch (error) {
    return { consistent: params.operation === 'controller.close'
      && (error as { code?: string }).code === 'CODEX_SANDBOX_CONTROLLER_REGISTRATION_MISSING'
      && output.status === 'closed' && typeof output.changed === 'boolean' };
  }
}

const codexControllerOperation = Object.freeze({ validate, execute, recover });

export { codexControllerOperation };
