import {
  assertWritableInventory,
  inspectTaskArtifacts
} from './artifact-lifecycle.ts';
import type {
  ArtifactError,
  ArtifactFamily,
  ArtifactIdentity,
  InspectOptions
} from './artifact-lifecycle.ts';

const COMPLETION_BACKFILL_FAMILIES = [
  'analysis',
  'review-analysis',
  'plan',
  'review-plan',
  'code',
  'review-code',
  'manual-validation'
] as const satisfies readonly ArtifactFamily[];

type CompletionArtifactResult = {
  status: 'ready' | 'failed';
  changed: false;
  taskId: string | null;
  taskDir: string | null;
  artifacts: readonly ArtifactIdentity[];
  error: ArtifactError | null;
};

function inspectCompletionArtifacts(
  taskRef: string,
  options: InspectOptions = {}
): CompletionArtifactResult {
  const artifacts: ArtifactIdentity[] = [];
  let taskId: string | null = null;
  let taskDir: string | null = null;
  for (const family of COMPLETION_BACKFILL_FAMILIES) {
    const inventory = inspectTaskArtifacts(taskRef, family, options);
    taskId = inventory.taskId ?? taskId;
    taskDir = inventory.taskDir ?? taskDir;
    if (inventory.status === 'failed') {
      return { status: 'failed', changed: false, taskId, taskDir, artifacts: [], error: inventory.error };
    }
    const writableError = assertWritableInventory(inventory);
    const brokenReference = inventory.diagnostics.find((item) => item.code === 'BROKEN_REFERENCE');
    const error = writableError ?? (brokenReference ? {
      code: 'ARTIFACT_REFERENCE_INVALID' as const,
      message: brokenReference.message
    } : null);
    if (error) return { status: 'failed', changed: false, taskId, taskDir, artifacts: [], error };
    artifacts.push(...inventory.artifacts);
  }
  return { status: 'ready', changed: false, taskId, taskDir, artifacts, error: null };
}

export { COMPLETION_BACKFILL_FAMILIES, inspectCompletionArtifacts };
export type { CompletionArtifactResult };
