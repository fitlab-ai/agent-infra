import { TASK_WORKFLOW_COMMANDS } from '../../task/workflow-command.ts';

import { parseArtifactCommand, executeArtifactCommand } from '../../task/artifact-command.ts';
import { parseReviewCommand } from '../../task/review-command.ts';
import { prepareLocalArtifact, commitLocalArtifactProvenance } from '../../task/local-artifact-finalization.ts';
import { prepareReviewSummaryCandidate, commitReviewSummaryProvenance } from '../../task/review-finalization.ts';
import { withTaskExecutionLock } from '../../task/task-execution-lock.ts';
import { dispatchHostControlCommand } from '../../host-control/command.ts';
import { assertSandboxTaskSource } from '../workspace-view.ts';
import { appendDiagnosticAudit } from './audit.ts';
import {
  readTaskArtifact, writeTaskArtifact, type TaskWorkflowRequest
} from './task-workflow.ts';
import type { SandboxControlManifest } from './protocol.ts';
import type { SandboxControlExecutionResult } from './executor.ts';
import type { LifecycleRecoveryAttestationV1 } from '../../task/control-authority.ts';
import { applyTaskEvent } from '../../task/events.ts';
import { parseTaskEventRequest } from '../../internal/task-event.ts';

function executionResult(result: Record<string, unknown>): SandboxControlExecutionResult {
  return { exitCode: result.status === 'failed' || result.status === 'refused' ? 1 : 0, stdout: `${JSON.stringify(result)}\n`, stderr: '' };
}

/** The broker already authorized this host executor; domain operations own validation. */
export async function executeTaskWorkflow(
  manifest: SandboxControlManifest,
  request: TaskWorkflowRequest,
  lifecycleRecoveryAttestation: LifecycleRecoveryAttestationV1 | null = null
): Promise<SandboxControlExecutionResult> {
  let publicationStarted = false;
  try {
    if (manifest.taskProjectionDir !== undefined || manifest.taskProjectionTopology !== undefined) {
      throw new Error('SANDBOX_CONTROL_RECREATE_REQUIRED');
    }
    const taskDir = assertSandboxTaskSource(manifest.repoRoot, request.taskId);
    const [command] = TASK_WORKFLOW_COMMANDS[request.operation];
    if (request.operation === 'event') {
      const eventRequest = parseTaskEventRequest(request.args);
      const boundEventRequest = lifecycleRecoveryAttestation && eventRequest.requestId === undefined
        ? { ...eventRequest, requestId: lifecycleRecoveryAttestation.lifecycleRequestId }
        : eventRequest;
      const result = applyTaskEvent(boundEventRequest, {
        repoRoot: manifest.repoRoot,
        lifecycleRecoveryAttestation,
        deferLifecycleRecoveryConsumption: true
      });
      return executionResult(result);
    }
    if (command !== 'task-artifact' && command !== 'task-review') {
      publicationStarted = true;
      // Inherit this executor's process group so its existing recovery owns the worker too.
      const result = await dispatchHostControlCommand({
        operation: command, payload: { workingDirectory: manifest.repoRoot, args: request.args }
      });
      return result;
    }
    const input = command === 'task-artifact' ? parseArtifactCommand(request.args) : parseReviewCommand(request.args);
    if (command === 'task-artifact' && 'operation' in input && input.operation === 'inspect') {
      return executionResult(executeArtifactCommand(input, { repoRoot: manifest.repoRoot }));
    }
    if ('operation' in input && (input.operation === 'init' || input.operation === 'repair')) {
      return executionResult(executeArtifactCommand(input, { repoRoot: manifest.repoRoot, artifactDir: taskDir }));
    }
    return await withTaskExecutionLock(manifest.repoRoot, request.taskId, `sandbox-control.${request.operation}`, async () => {
      const artifact = await readTaskArtifact(taskDir, { artifact: input.artifact });
      const content = artifact.bytes.toString('utf8');
      let result: Record<string, unknown>;
      if ('operation' in input) {
        const { family } = input;
        if (family !== 'analysis' && family !== 'plan' && family !== 'code') throw new Error('ARTIFACT_IDENTITY_INVALID');
        const local = { taskRef: request.taskId, family, artifact: input.artifact, repoRoot: manifest.repoRoot } as const;
        const prepared = prepareLocalArtifact(local, content, lifecycleRecoveryAttestation ?? undefined);
        if (prepared.result.status === 'failed') return executionResult(commitLocalArtifactProvenance(prepared));
        publicationStarted = true;
        await writeTaskArtifact(taskDir, {
          artifact: artifact.artifact,
          bytes: artifact.bytes,
          expectedSha256: artifact.sha256
        });
        result = commitLocalArtifactProvenance(prepared);
      } else {
        if (input.overrideTicket) throw new Error('TASK_WORKFLOW_OVERRIDE_UNSUPPORTED');
        const prepared = prepareReviewSummaryCandidate(input, content, { repoRoot: manifest.repoRoot });
        if (input.dryRun || prepared.result.status === 'planned') return executionResult(prepared.result);
        if (prepared.result.status === 'failed') return executionResult(commitReviewSummaryProvenance(prepared, manifest.repoRoot));
        publicationStarted = true;
        await writeTaskArtifact(taskDir, {
          artifact: input.artifact,
          bytes: Buffer.from(prepared.content, 'utf8'),
          expectedSha256: artifact.sha256
        });
        result = commitReviewSummaryProvenance(prepared, manifest.repoRoot);
      }
      if (result.status !== 'failed') appendDiagnosticAudit(manifest, 'task-workflow-artifact-finalized', {
        requestId: request.id, sandboxTaskId: request.taskId, workflowOperation: request.operation,
        artifact: input.artifact, sha256: result.artifactSha256 as string, semanticDigest: result.semanticDigest as string
      });
      return executionResult({ ...result, changed: true });
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = (error as { code?: string })?.code ?? /^([A-Z][A-Z0-9_]+)/u.exec(message)?.[1] ?? 'TASK_WORKFLOW_REQUEST_INVALID';
    return executionResult({ status: 'failed', changed: publicationStarted ? null : false, error: { code, message } });
  }
}
