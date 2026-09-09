import path from 'node:path';

import { TASK_WORKFLOW_COMMANDS } from '../../task/workflow-command.ts';

import { parseArtifactCommand, executeArtifactCommand } from '../../task/artifact-command.ts';
import { parseReviewCommand } from '../../task/review-command.ts';
import { prepareLocalArtifact, commitLocalArtifactProvenance } from '../../task/local-artifact-finalization.ts';
import { prepareReviewSummaryCandidate, commitReviewSummaryProvenance } from '../../task/review-finalization.ts';
import { withTaskExecutionLock } from '../../task/task-execution-lock.ts';
import { hostControlRequestForCommand, requestHostControl } from '../../host-control/client.ts';
import { resolveHostControlEndpoint } from '../../host-control/path.ts';
import { appendDiagnosticAudit } from './audit.ts';
import {
  readProjectionArtifact, landProjectionArtifact, verifyProjectionTopology,
  type TaskProjectionManifest, type TaskWorkflowRequest
} from './task-workflow.ts';
import type { SandboxControlManifest } from './protocol.ts';
import type { SandboxControlExecutionResult } from './executor.ts';

function executionResult(result: Record<string, unknown>): SandboxControlExecutionResult {
  return { exitCode: result.status === 'failed' || result.status === 'refused' ? 1 : 0, stdout: `${JSON.stringify(result)}\n`, stderr: '' };
}

/** The broker already authorized this host executor; domain operations own validation. */
export async function executeTaskWorkflow(
  manifest: SandboxControlManifest,
  request: TaskWorkflowRequest
): Promise<SandboxControlExecutionResult> {
  let publicationStarted = false;
  try {
    const [command] = TASK_WORKFLOW_COMMANDS[request.operation];
    if (command !== 'task-artifact' && command !== 'task-review') {
      publicationStarted = true;
      const response = await requestHostControl({
        endpoint: process.env.AGENT_INFRA_TEST_HOST_CONTROL_ENDPOINT ?? resolveHostControlEndpoint(),
        request: { ...hostControlRequestForCommand(command, request.args, manifest.repoRoot), id: request.id, generation: request.generation }
      });
      return response;
    }
    const input = command === 'task-artifact' ? parseArtifactCommand(request.args) : parseReviewCommand(request.args);
    if (command === 'task-artifact' && 'operation' in input && input.operation === 'inspect') {
      return executionResult(executeArtifactCommand(input, { repoRoot: manifest.repoRoot }));
    }
    if (!manifest.taskProjectionDir || !manifest.taskProjectionTopology) throw new Error('TASK_PROJECTION_TOPOLOGY_UNVERIFIED');
    const projection: TaskProjectionManifest = {
      version: 1, taskId: request.taskId, generation: request.generation,
      projectionRoot: manifest.taskProjectionDir,
      authoritativeTaskDir: path.join(manifest.repoRoot, '.agents', 'workspace', 'active', request.taskId),
      topology: { verified: true, ancestors: manifest.taskProjectionTopology }
    };
    verifyProjectionTopology(projection);
    if ('operation' in input && (input.operation === 'init' || input.operation === 'repair')) {
      return executionResult(executeArtifactCommand(input, { repoRoot: manifest.repoRoot, artifactDir: projection.projectionRoot }));
    }
    return await withTaskExecutionLock(manifest.repoRoot, request.taskId, `sandbox-control.${request.operation}`, async () => {
      const artifact = await readProjectionArtifact(projection, { artifact: input.artifact });
      const content = artifact.bytes.toString('utf8');
      let result: Record<string, unknown>;
      if ('operation' in input) {
        const { family } = input;
        if (family !== 'analysis' && family !== 'plan' && family !== 'code') throw new Error('ARTIFACT_IDENTITY_INVALID');
        const local = { taskRef: request.taskId, family, artifact: input.artifact, repoRoot: manifest.repoRoot } as const;
        const prepared = prepareLocalArtifact(local, content);
        if (prepared.result.status === 'failed') return executionResult(commitLocalArtifactProvenance(prepared));
        publicationStarted = true;
        await landProjectionArtifact(projection, artifact);
        result = commitLocalArtifactProvenance(prepared);
      } else {
        if (input.overrideTicket) throw new Error('TASK_WORKFLOW_OVERRIDE_UNSUPPORTED');
        const prepared = prepareReviewSummaryCandidate(input, content, { repoRoot: manifest.repoRoot });
        if (input.dryRun || prepared.result.status === 'planned') return executionResult(prepared.result);
        if (prepared.result.status === 'failed') return executionResult(commitReviewSummaryProvenance(prepared, manifest.repoRoot));
        publicationStarted = true;
        await landProjectionArtifact(projection, { artifact: input.artifact, bytes: Buffer.from(prepared.content, 'utf8') });
        result = commitReviewSummaryProvenance(prepared, manifest.repoRoot);
      }
      if (result.status !== 'failed') appendDiagnosticAudit(manifest, 'task-workflow-artifact-landed', {
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
