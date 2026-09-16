import { TASK_WORKFLOW_COMMANDS } from '../../task/workflow-command.ts';

import { parseArtifactCommand, executeArtifactCommand } from '../../task/artifact-command.ts';
import { parseReviewCommand } from '../../task/review-command.ts';
import { prepareLocalArtifact, preflightLocalArtifact, commitLocalArtifactProvenance } from '../../task/local-artifact-finalization.ts';
import { prepareReviewSummaryCandidate, commitReviewSummaryProvenance } from '../../task/review-finalization.ts';
import { readArtifactRecoveryIntent } from '../../task/artifact-repair-intent.ts';
import { withTaskExecutionLock } from '../../task/task-execution-lock.ts';
import { dispatchWorkflowCommand } from '../../task/workflow-dispatch.ts';
import { assertSandboxTaskSource } from '../workspace-view.ts';
import { appendDiagnosticAudit } from './audit.ts';
import {
  readTaskArtifact, type TaskWorkflowRequest
} from './task-workflow.ts';
import type { SandboxControlManifest } from './protocol.ts';
import type { SandboxControlExecutionResult } from './executor.ts';
import type { LifecycleRecoveryAttestationV1 } from '../../task/control-authority.ts';
import { applyTaskEvent } from '../../task/events.ts';
import { parseTaskEventRequest } from '../../internal/task-event.ts';

export type TaskWorkflowFaultWindow =
  | 'before-call'
  | 'before-domain-write'
  | 'after-atomic-rename'
  | 'before-result-return';

export type TaskWorkflowExecutionOptions = Readonly<{
  /** Deterministic test seam; production callers leave this unset. */
  faultWindow?: TaskWorkflowFaultWindow;
}>;

function executionResult(result: Record<string, unknown>): SandboxControlExecutionResult {
  return { exitCode: result.status === 'failed' || result.status === 'refused' ? 1 : 0, stdout: `${JSON.stringify(result)}\n`, stderr: '' };
}

/** The broker already authorized this host executor; domain operations own validation. */
export async function executeTaskWorkflow(
  manifest: SandboxControlManifest,
  request: TaskWorkflowRequest,
  lifecycleRecoveryAttestation: LifecycleRecoveryAttestationV1 | null = null,
  options: TaskWorkflowExecutionOptions = {}
): Promise<SandboxControlExecutionResult> {
  let publicationCommitted = false;
  let recoveryObservation: Readonly<{
    family: 'analysis' | 'plan' | 'code' | 'review-analysis' | 'review-plan' | 'review-code';
    artifact: string;
    wasPassed: boolean;
  }> | null = null;
  const observeRecoveryPublication = (): void => {
    if (!recoveryObservation || recoveryObservation.wasPassed) return;
    const intent = readArtifactRecoveryIntent(
      manifest.repoRoot,
      request.taskId,
      recoveryObservation.family,
      recoveryObservation.artifact
    );
    publicationCommitted ||= intent?.state === 'passed' || intent?.state === 'commit-started';
  };
  let faultTriggered = false;
  const fault = (window: TaskWorkflowFaultWindow): void => {
    if (faultTriggered || options.faultWindow !== window) return;
    faultTriggered = true;
    throw new Error(`TASK_WORKFLOW_FAULT_INJECTED:${window}`);
  };
  const response = (result: Record<string, unknown>): SandboxControlExecutionResult => {
    fault('before-result-return');
    return executionResult(result);
  };
  try {
    fault('before-call');
    const taskDir = assertSandboxTaskSource(manifest.repoRoot, request.taskId);
    const [command] = TASK_WORKFLOW_COMMANDS[request.operation];
    if (request.operation === 'event') {
      const eventRequest = parseTaskEventRequest(request.args);
      const boundEventRequest = lifecycleRecoveryAttestation && eventRequest.requestId === undefined
        ? { ...eventRequest, requestId: lifecycleRecoveryAttestation.lifecycleRequestId }
        : eventRequest;
      fault('before-domain-write');
      const result = applyTaskEvent(boundEventRequest, {
        repoRoot: manifest.repoRoot,
        lifecycleRecoveryAttestation,
        deferLifecycleRecoveryConsumption: true
      });
      publicationCommitted = result.changed;
      fault('after-atomic-rename');
      return response(result);
    }
    if (command !== 'task-artifact' && command !== 'task-review') {
      // The broker owns this short-lived executor; no global service or worker
      // credential participates in the command's authority or recovery path.
      fault('before-domain-write');
      const result = dispatchWorkflowCommand(manifest.repoRoot, request.operation, request.args);
      publicationCommitted = result.changed === true;
      fault('after-atomic-rename');
      return response(result);
    }
    const input = command === 'task-artifact' ? parseArtifactCommand(request.args) : parseReviewCommand(request.args);
    if (command === 'task-artifact' && 'operation' in input && input.operation === 'inspect') {
      fault('before-domain-write');
      const result = executeArtifactCommand(input, { repoRoot: manifest.repoRoot });
      publicationCommitted = result.changed === true;
      fault('after-atomic-rename');
      return response(result);
    }
    if ('operation' in input && input.operation === 'init') {
      fault('before-domain-write');
      const result = executeArtifactCommand(input, { repoRoot: manifest.repoRoot, artifactDir: taskDir });
      publicationCommitted = result.changed === true;
      fault('after-atomic-rename');
      return response(result);
    }
    return await withTaskExecutionLock(manifest.repoRoot, request.taskId, `sandbox-control.${request.operation}`, async () => {
      const artifact = await readTaskArtifact(taskDir, { artifact: input.artifact });
      const content = artifact.bytes.toString('utf8');
      fault('before-domain-write');
      let result: Record<string, unknown>;
      if ('operation' in input) {
        const { family } = input;
        if (family !== 'analysis' && family !== 'plan' && family !== 'code') throw new Error('ARTIFACT_IDENTITY_INVALID');
        const local = { taskRef: request.taskId, family, artifact: input.artifact, repoRoot: manifest.repoRoot, recoveryId: input.recoveryId, lockAlreadyHeld: true } as const;
        if (input.operation === 'preflight') {
          // Preflight only seals a verified generation. It must not publish the
          // formal artifact, set publicationStarted, or append finalizer audit.
          return executionResult(preflightLocalArtifact(local));
        }
        recoveryObservation = {
          family,
          artifact: input.artifact,
          wasPassed: readArtifactRecoveryIntent(manifest.repoRoot, request.taskId, family, input.artifact)?.state === 'passed'
        };
        const prepared = prepareLocalArtifact(local, content, lifecycleRecoveryAttestation ?? undefined);
        observeRecoveryPublication();
        const commitOptions = { afterPublish: () => fault('after-atomic-rename') };
        if (prepared.result.status === 'failed') return executionResult(commitLocalArtifactProvenance(prepared, commitOptions));
        result = commitLocalArtifactProvenance(prepared, commitOptions);
      } else {
        if (input.overrideTicket) throw new Error('TASK_WORKFLOW_OVERRIDE_UNSUPPORTED');
        const family = `review-${input.stage}` as 'review-analysis' | 'review-plan' | 'review-code';
        recoveryObservation = {
          family,
          artifact: input.artifact,
          wasPassed: readArtifactRecoveryIntent(manifest.repoRoot, request.taskId, family, input.artifact)?.state === 'passed'
        };
        const prepared = prepareReviewSummaryCandidate(input, content, { repoRoot: manifest.repoRoot, lockAlreadyHeld: true, startRecovery: true });
        observeRecoveryPublication();
        if (input.dryRun || prepared.result.status === 'planned') return executionResult(prepared.result);
        const commitOptions = { afterPublish: () => fault('after-atomic-rename') };
        if (prepared.result.status === 'failed') return executionResult(commitReviewSummaryProvenance(prepared, manifest.repoRoot, commitOptions));
        result = commitReviewSummaryProvenance(prepared, manifest.repoRoot, commitOptions);
      }
      observeRecoveryPublication();
      publicationCommitted ||= result.changed === true;
      if (result.status !== 'failed') appendDiagnosticAudit(manifest, 'task-workflow-artifact-finalized', {
        requestId: request.id, sandboxTaskId: request.taskId, workflowOperation: request.operation,
        artifact: input.artifact, sha256: result.artifactSha256 as string, semanticDigest: result.semanticDigest as string
      });
      fault('after-atomic-rename');
      return response(result);
    });
  } catch (error) {
    observeRecoveryPublication();
    const message = error instanceof Error ? error.message : String(error);
    const code = (error as { code?: string })?.code ?? /^([A-Z][A-Z0-9_]+)/u.exec(message)?.[1] ?? 'TASK_WORKFLOW_REQUEST_INVALID';
    return executionResult({ status: 'failed', changed: publicationCommitted ? null : false, error: { code, message } });
  }
}
