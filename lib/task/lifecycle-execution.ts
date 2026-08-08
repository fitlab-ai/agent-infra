import {
  inspectOrchestrationStage,
  pauseOrchestration,
  planOrchestrationStageCompletion,
  readRun
} from './orchestration.ts';
import type {
  OrchestrationStageCompletion,
  OrchestrationStageIdentity
} from './orchestration.ts';
import { resolveTaskRef } from './resolve-ref.ts';

type LifecycleExecutionMode = 'standalone' | 'orchestrated';
type LifecycleExecutionRequest = Readonly<{
  mode: LifecycleExecutionMode;
  identity: OrchestrationStageIdentity;
  agent?: string;
  dryRun?: boolean;
}>;
type LifecycleExecutionResult = Readonly<{
  ok: boolean;
  mode: LifecycleExecutionMode;
  completionPlan: OrchestrationStageCompletion | null;
  error: Readonly<{ code: string; message: string }> | null;
}>;

function failure(mode: LifecycleExecutionMode, code: string, message: string): LifecycleExecutionResult {
  return { ok: false, mode, completionPlan: null, error: { code, message } };
}

function inspectLifecycleExecution(
  taskRef: string,
  request: LifecycleExecutionRequest,
  options: Readonly<{ repoRoot?: string }> = {}
): LifecycleExecutionResult {
  const resolved = resolveTaskRef(taskRef, { repoRoot: options.repoRoot });
  if (!resolved.ok) return failure(request.mode, resolved.code, resolved.message);
  if (request.mode === 'standalone') {
    try {
      const run = readRun(resolved.taskDir);
      if (run?.pendingDelegation) {
        return failure(
          request.mode,
          'ORCHESTRATION_STANDALONE_BUSY',
          'standalone lifecycle execution is blocked by a pending orchestration delegation'
        );
      }
      return { ok: true, mode: request.mode, completionPlan: null, error: null };
    } catch (error) {
      return failure(
        request.mode,
        'ORCHESTRATION_STATE_INVALID',
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  if (request.agent) {
    const planned = planOrchestrationStageCompletion(taskRef, {
      ...request.identity,
      agent: request.agent
    }, options);
    if (planned.plan) {
      return { ok: true, mode: request.mode, completionPlan: planned.plan, error: null };
    }
    return failure(
      request.mode,
      planned.result.error?.code ?? 'ORCHESTRATION_PROVENANCE_MISMATCH',
      planned.result.error?.message ?? 'orchestration provenance validation failed'
    );
  }

  const inspected = inspectOrchestrationStage(taskRef, request.identity, options);
  if (inspected.status !== 'failed') {
    return { ok: true, mode: request.mode, completionPlan: null, error: null };
  }
  return failure(
    request.mode,
    inspected.error?.code ?? 'ORCHESTRATION_PROVENANCE_MISMATCH',
    inspected.error?.message ?? 'orchestration provenance validation failed'
  );
}

function validateLifecycleExecution(
  taskRef: string,
  request: LifecycleExecutionRequest,
  options: Readonly<{ repoRoot?: string }> = {}
): LifecycleExecutionResult {
  const inspected = inspectLifecycleExecution(taskRef, request, options);
  if (inspected.ok || request.mode === 'standalone' || request.dryRun) return inspected;
  const paused = pauseOrchestration(
    taskRef,
    inspected.error?.code ?? 'ORCHESTRATION_PROVENANCE_MISMATCH',
    inspected.error?.message ?? 'orchestration provenance validation failed',
    true,
    options
  );
  return failure(
    request.mode,
    paused.run?.pause?.code ?? inspected.error?.code ?? 'ORCHESTRATION_PROVENANCE_MISMATCH',
    paused.run?.pause?.message ?? inspected.error?.message ?? 'orchestration provenance validation failed'
  );
}

export { inspectLifecycleExecution, validateLifecycleExecution };
export type { LifecycleExecutionMode, LifecycleExecutionRequest, LifecycleExecutionResult };
