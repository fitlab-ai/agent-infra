import fs from 'node:fs';
import path from 'node:path';

import { parseArtifactReceipts, sha256File } from './artifact-receipts.ts';
import { invalidationMutation, parseInvalidationDocument, reconcileInvalidation } from './invalidation.ts';
import { resolveTaskRef } from './resolve-ref.ts';
import { writeTask } from './write.ts';
import type { TaskWriteOptions } from './write.ts';

type InvalidationCommandOptions = TaskWriteOptions & { now?: () => string; maxTargets?: number; dryRun?: boolean };
type InvalidationCommandResult = {
  status: 'applied' | 'planned' | 'no-op' | 'failed';
  changed: boolean;
  taskId: string | null;
  processed: number;
  remaining: number;
  error: { code: string; message: string } | null;
};

function reconcileTaskInvalidation(taskRef: string, options: InvalidationCommandOptions = {}): InvalidationCommandResult {
  const resolved = resolveTaskRef(taskRef, { repoRoot: options.repoRoot });
  if (!resolved.ok) return { status: 'failed', changed: false, taskId: resolved.taskId, processed: 0, remaining: 0, error: { code: resolved.code, message: resolved.message } };
  let content: string;
  try { content = fs.readFileSync(resolved.taskMdPath, 'utf8'); }
  catch (error) { return { status: 'failed', changed: false, taskId: resolved.taskId, processed: 0, remaining: 0, error: { code: 'TASK_READ_FAILED', message: error instanceof Error ? error.message : String(error) } }; }
  const parsed = parseInvalidationDocument(content);
  if (!parsed.ok) return { status: 'failed', changed: false, taskId: resolved.taskId, processed: 0, remaining: 0, error: { code: parsed.code, message: parsed.message } };
  if (!parsed.present) return { status: 'no-op', changed: false, taskId: resolved.taskId, processed: 0, remaining: 0, error: null };
  const beforePending = parsed.document.targets.filter((target) => target.status !== 'completed').length;
  let receipts;
  try { receipts = parseArtifactReceipts(content).rows; }
  catch (error) {
    if (parsed.document.targets.some((target) => target.status !== 'completed' && target.targetKind === 'receipt')) {
      return {
        status: 'failed', changed: false, taskId: resolved.taskId, processed: 0, remaining: beforePending,
        error: { code: 'INVALIDATION_TARGET_HASH_CONFLICT', message: error instanceof Error ? error.message : String(error) }
      };
    }
    receipts = [];
  }
  for (const target of parsed.document.targets) {
    if (target.status === 'completed') continue;
    if (target.targetKind === 'receipt') {
      const receipt = receipts.find((candidate) => candidate.output === target.targetArtifact);
      if (!receipt || receipt.inputSha256 !== target.targetSha256) {
        return {
          status: 'failed', changed: false, taskId: resolved.taskId, processed: 0, remaining: beforePending,
          error: { code: 'INVALIDATION_TARGET_HASH_CONFLICT', message: `invalidation receipt target '${target.targetArtifact}' changed before reconcile` }
        };
      }
      continue;
    }
    const targetPath = path.join(resolved.taskDir, target.targetArtifact);
    try {
      const stat = fs.lstatSync(targetPath);
      if (!stat.isFile() || stat.isSymbolicLink() || sha256File(targetPath) !== target.targetSha256) {
        return {
          status: 'failed', changed: false, taskId: resolved.taskId, processed: 0, remaining: beforePending,
          error: { code: 'INVALIDATION_TARGET_HASH_CONFLICT', message: `invalidation target '${target.targetArtifact}' changed before reconcile` }
        };
      }
    } catch {
      return {
        status: 'failed', changed: false, taskId: resolved.taskId, processed: 0, remaining: beforePending,
        error: { code: 'INVALIDATION_TARGET_HASH_CONFLICT', message: `invalidation target '${target.targetArtifact}' is unavailable before reconcile` }
      };
    }
  }
  const reconciled = reconcileInvalidation(parsed.document, (options.now ?? (() => new Date().toISOString()))(), options.maxTargets);
  if (!reconciled.ok) return { status: 'failed', changed: false, taskId: resolved.taskId, processed: 0, remaining: beforePending, error: { code: reconciled.code, message: reconciled.message } };
  if (!reconciled.changed) return { status: 'no-op', changed: false, taskId: resolved.taskId, processed: 0, remaining: beforePending, error: null };
  const result = writeTask({
    taskRef, expectedState: resolved.state, dryRun: options.dryRun,
    mutations: [invalidationMutation(content, reconciled.document)]
  }, { ...options, invalidationContext: 'reconcile', taskLocation: { repoRoot: resolved.repoRoot, taskId: resolved.taskId, taskMdPath: resolved.taskMdPath, state: resolved.state } });
  if (result.status === 'failed') return { status: 'failed', changed: false, taskId: resolved.taskId, processed: beforePending - reconciled.document.targets.filter((target) => target.status !== 'completed').length, remaining: reconciled.document.targets.filter((target) => target.status !== 'completed').length, error: result.error };
  return {
    status: result.status, changed: result.changed, taskId: resolved.taskId,
    processed: beforePending - reconciled.document.targets.filter((target) => target.status !== 'completed').length,
    remaining: reconciled.document.targets.filter((target) => target.status !== 'completed').length,
    error: null
  };
}

export { reconcileTaskInvalidation };
export type { InvalidationCommandOptions, InvalidationCommandResult };
