import fs from 'node:fs';
import path from 'node:path';

import { resolveTaskRef } from './resolve-ref.ts';
import { locateActivityLog, appendActivityEntry } from './activity-log.ts';
import { buildArtifactLinkSection, parseArtifactName } from './artifact-lifecycle.ts';
import { captureTaskWriteMetadata, writeTask } from './write.ts';
import type { TaskMutation, TaskOperationSummary, TaskWriteOptions } from './write.ts';

export type ActivityAppendIntent = {
  kind: 'append';
  taskRef: string;
  step: string;
  agent: string;
  note: string;
  artifact?: string;
  dryRun?: boolean;
};

export type ActivityIntentResult = {
  status: 'planned' | 'applied' | 'no-op' | 'failed';
  changed: boolean;
  intent: 'append';
  taskId: string | null;
  artifact: string | null;
  operations: readonly TaskOperationSummary[];
  error: { code: string; message: string } | null;
};

function failed(intent: ActivityAppendIntent, code: string, message: string, taskId: string | null = null): ActivityIntentResult {
  return {
    status: 'failed', changed: false, intent: 'append', taskId,
    artifact: intent.artifact ?? null, operations: [], error: { code, message }
  };
}

function oneLine(value: string): string {
  return value.replace(/\s*\r?\n\s*/g, ' ').trim();
}

/**
 * Append an Activity Log entry (and, optionally, a `## 审查反馈` artifact link)
 * to an active task via the atomic `writeTask` path. `current_step` is never
 * touched (PL-2): review-pr does not join the standard stage chain.
 */
export function applyActivityAppendIntent(intent: ActivityAppendIntent, options: TaskWriteOptions = {}): ActivityIntentResult {
  if (intent.kind !== 'append') return failed(intent, 'ACTIVITY_INTENT_INVALID', 'intent kind must be append');
  const resolved = resolveTaskRef(intent.taskRef, { repoRoot: options.repoRoot });
  if (!resolved.ok) return failed(intent, resolved.code, resolved.message, resolved.taskId);
  if (resolved.state !== 'active') {
    return failed(intent, 'TASK_STATE_MISMATCH', `task ${resolved.taskId} is ${resolved.state}, expected active`, resolved.taskId);
  }
  const step = oneLine(intent.step);
  const agent = oneLine(intent.agent);
  const note = oneLine(intent.note);
  if (!step || !agent || !note || /[\r\n]/.test(intent.step) || /[\r\n]/.test(intent.agent) || /[\r\n]/.test(intent.note)) {
    return failed(intent, 'ACTIVITY_INTENT_INVALID', 'step, agent and note must be non-empty single-line values', resolved.taskId);
  }

  let artifact: ReturnType<typeof parseArtifactName> | null = null;
  if (intent.artifact !== undefined) {
    artifact = parseArtifactName(intent.artifact);
    if (!artifact || artifact.family !== 'pr-review') {
      return failed(intent, 'ACTIVITY_ARTIFACT_INVALID', `artifact '${intent.artifact}' is not a canonical pr-review artifact`, resolved.taskId);
    }
  }

  let content: string;
  try {
    content = fs.readFileSync(resolved.taskMdPath, 'utf8');
  } catch (error) {
    return failed(intent, 'TASK_READ_FAILED', error instanceof Error ? error.message : String(error), resolved.taskId);
  }
  const section = locateActivityLog(content);
  if (!section) {
    return failed(intent, 'ACTIVITY_SECTION_MISSING', 'task has no unique Activity Log section', resolved.taskId);
  }

  let metadata;
  try {
    metadata = (options.metadataProvider ?? captureTaskWriteMetadata)();
  } catch (error) {
    return failed(intent, 'METADATA_CAPTURE_FAILED', error instanceof Error ? error.message : String(error), resolved.taskId);
  }

  const mutations: TaskMutation[] = [];
  const activityBody = appendActivityEntry(section, { time: metadata.timestamp, step, agent, note });
  mutations.push({ kind: 'section', aliases: ['活动日志', 'Activity Log'], heading: section.heading, body: activityBody });
  if (artifact) {
    const link = buildArtifactLinkSection(content, {
      ...artifact,
      path: path.join(resolved.taskDir, artifact.name),
      size: 0,
      mtimeMs: 0
    });
    mutations.push({ kind: 'section', aliases: link.aliases, heading: link.heading, body: link.body });
  }

  const writeResult = writeTask({
    taskRef: intent.taskRef,
    expectedState: 'active',
    mutations,
    dryRun: intent.dryRun
  }, {
    ...options,
    taskLocation: {
      repoRoot: resolved.repoRoot,
      taskId: resolved.taskId,
      taskMdPath: resolved.taskMdPath,
      state: resolved.state
    },
    metadataProvider: () => metadata
  });
  if (writeResult.status === 'failed') {
    return failed(intent, writeResult.error.code, writeResult.error.message, writeResult.taskId);
  }
  return {
    status: writeResult.status,
    changed: writeResult.changed,
    intent: 'append',
    taskId: writeResult.taskId,
    artifact: intent.artifact ?? null,
    operations: writeResult.operations,
    error: null
  };
}

export type { TaskWriteOptions } from './write.ts';
