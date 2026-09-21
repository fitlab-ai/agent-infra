import fs from 'node:fs';
import path from 'node:path';

import { COMPLETION_BACKFILL_FAMILIES, inspectCompletionArtifacts } from '../task/finalization-artifacts.ts';
import { parseArtifactName } from '../task/artifact-name.ts';
import { parseTaskFrontmatter } from '../task/frontmatter.ts';
import { resolveTaskRef } from '../task/resolve-ref.ts';
import { getOpenWorkflowWarnings } from '../task/workflow-warnings.ts';
import { applyWorkflowWarningIntent } from '../task/workflow-warning-intents.ts';
import { captureTaskWriteMetadata } from '../task/write.ts';
import { syncPlatformComment } from './issue-comments.ts';
import type { PlatformClient } from './context.ts';
import { platformResult } from './types.ts';
import type { PlatformOperation, PlatformResult } from './types.ts';
import { taskIssueIdentity } from './task-identities.ts';

type CompletionBackfillOptions = { agent: string; cwd?: string; client?: PlatformClient };
type CompletionBackfillResult = PlatformResult & {
  artifacts: Array<{ artifact: string; status: PlatformResult['status'] }>;
  warnings: Array<{ id: string; status: string }>;
};
type CompletionBackfillEligibility = Readonly<{
  status: 'ready' | 'failed';
  eligible: boolean;
  error: { code: string; message: string; retryable: boolean } | null;
}>;

function result(
  base: PlatformResult,
  artifacts: CompletionBackfillResult['artifacts'],
  warnings: CompletionBackfillResult['warnings']
): CompletionBackfillResult {
  return { ...base, artifacts, warnings };
}

function referencedBackfillArtifact(taskDir: string, message: string): string | null {
  const names = [...message.matchAll(/(?:^|[^A-Za-z0-9_-])([a-z][a-z-]*(?:-r[1-9]\d*)?\.md)(?=$|[^A-Za-z0-9_.-])/g)]
    .map((match) => match[1]!);
  if (names.length !== 1) return null;
  const parsed = parseArtifactName(names[0]!);
  if (!parsed || (parsed.family !== 'pr-review' && !COMPLETION_BACKFILL_FAMILIES.includes(parsed.family as typeof COMPLETION_BACKFILL_FAMILIES[number]))) return null;
  const artifactPath = path.join(taskDir, parsed.name);
  try {
    const stat = fs.lstatSync(artifactPath);
    return stat.isFile() && !stat.isSymbolicLink() ? parsed.name : null;
  } catch {
    return null;
  }
}

function matchingBackfillWarnings(taskDir: string, content: string) {
  return getOpenWorkflowWarnings(content).flatMap((warning) => {
    if (warning.step !== 'complete-task' || warning.code !== 'COMMENT_SYNC_FAILED' || warning.target !== 'artifact') return [];
    const artifact = referencedBackfillArtifact(taskDir, warning.message);
    return artifact ? [{ warning, artifact }] : [];
  });
}

function inspectCompletionBackfillEligibility(
  taskRef: string,
  options: Pick<CompletionBackfillOptions, 'cwd'> = {}
): CompletionBackfillEligibility {
  const resolved = resolveTaskRef(taskRef, options.cwd ? { repoRoot: options.cwd } : {});
  if (!resolved.ok) return {
    status: 'failed', eligible: false,
    error: { code: resolved.code, message: resolved.message, retryable: false }
  };
  try {
    const content = fs.readFileSync(resolved.taskMdPath, 'utf8');
    return { status: 'ready', eligible: matchingBackfillWarnings(resolved.taskDir, content).length > 0, error: null };
  } catch (error) {
    return {
      status: 'failed', eligible: false,
      error: { code: 'TASK_READ_FAILED', message: error instanceof Error ? error.message : String(error), retryable: false }
    };
  }
}

async function backfillCompletionComments(
  taskRef: string,
  options: CompletionBackfillOptions
): Promise<CompletionBackfillResult> {
  const resolved = resolveTaskRef(taskRef, options.cwd ? { repoRoot: options.cwd } : {});
  if (!resolved.ok) return result(platformResult('failed', {
    error: { code: resolved.code, message: resolved.message, retryable: false }
  }), [], []);
  const inventory = inspectCompletionArtifacts(resolved.taskId, { repoRoot: resolved.repoRoot });
  if (inventory.status === 'failed') return result(platformResult('failed', {
    error: {
      code: inventory.error?.code || 'ARTIFACT_TOPOLOGY_CONFLICT',
      message: inventory.error?.message || 'Completion artifact inventory failed',
      retryable: false
    }
  }), [], []);
  const initialContent = fs.readFileSync(resolved.taskMdPath, 'utf8');
  const issueIdentity = taskIssueIdentity(parseTaskFrontmatter(initialContent));
  if (!issueIdentity) return result(platformResult('no-op', {
    error: { code: 'ISSUE_NOT_LINKED', message: 'Task has no valid platform issue identity', retryable: false }
  }), [], []);

  const artifacts: CompletionBackfillResult['artifacts'] = [];
  const operations: PlatformOperation[] = [];
  let latest = platformResult('no-op', { error: null });
  for (const artifact of inventory.artifacts) {
    latest = await syncPlatformComment(resolved.taskId, {
      kind: 'artifact',
      artifact: artifact.name,
      agent: options.agent,
      backfill: true,
      cwd: resolved.repoRoot,
      client: options.client
    });
    operations.push(...latest.operations.map((operation) => ({
      ...operation,
      name: `${artifact.name}:${operation.name}`
    })));
    artifacts.push({ artifact: artifact.name, status: latest.status });
    if (latest.status === 'failed' || latest.status === 'blocked') return result({ ...latest, operations }, artifacts, []);
    if (latest.error) return result(platformResult(latest.error.retryable ? 'blocked' : 'failed', {
      platform: latest.platform,
      resource: latest.resource,
      capabilities: latest.capabilities,
      operations,
      error: latest.error
    }), artifacts, []);
  }

  const matching = matchingBackfillWarnings(resolved.taskDir, initialContent);
  const warnings: CompletionBackfillResult['warnings'] = [];
  let metadata: ReturnType<typeof captureTaskWriteMetadata> | null = null;
  for (const { warning, artifact } of matching) {
    metadata ??= captureTaskWriteMetadata();
    const resolution = [
      `artifact=${artifact}`,
      `completionFamilies=${COMPLETION_BACKFILL_FAMILIES.join(',')}`,
      `synchronized=${inventory.artifacts.map((artifact) => artifact.name).join(',') || 'none'}`,
      `completedAt=${metadata.timestamp}`
    ].join('; ');
    const updated = applyWorkflowWarningIntent({
      kind: 'set-status', taskRef: resolved.taskId, id: warning.id, status: 'resolved', resolution
    }, { repoRoot: resolved.repoRoot, metadataProvider: () => metadata! });
    if (updated.status === 'failed') return result(platformResult('failed', {
      platform: latest.platform,
      resource: latest.resource,
      capabilities: latest.capabilities,
      operations,
      changed: artifacts.some((item) => item.status === 'applied'),
      error: { code: updated.error?.code || 'WARNING_UPDATE_FAILED', message: updated.error?.message || 'Unable to resolve workflow warning', retryable: false }
    }), artifacts, warnings);
    warnings.push({ id: warning.id, status: updated.status });
  }
  const changed = artifacts.some((item) => item.status === 'applied') || warnings.some((item) => item.status === 'applied');
  return result(platformResult(changed ? 'applied' : 'no-op', {
    platform: latest.platform,
    resource: latest.resource,
    capabilities: latest.capabilities,
    changed,
    operations,
    error: null
  }), artifacts, warnings);
}

export { backfillCompletionComments, inspectCompletionBackfillEligibility };
export type { CompletionBackfillEligibility, CompletionBackfillOptions, CompletionBackfillResult };
