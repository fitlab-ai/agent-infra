import fs from 'node:fs';

import { reconcileTaskInvalidation } from './invalidation-command.ts';
import { applyLedgerIntent } from './ledger-intents.ts';
import type { LedgerIntent } from './ledger-intents.ts';
import { isReviewStage, parseLedgerDocument, summarizeLedgerStage, validateLedgerRows } from './ledger.ts';
import { resolveTaskRef } from './resolve-ref.ts';
import { TaskExecutionLockError, withTaskExecutionLock } from './task-execution-lock.ts';
import type { TaskWorkflowOperation } from './workflow-command.ts';
import { applyWorkflowWarningIntent } from './workflow-warning-intents.ts';
import type { WorkflowWarningIntent } from './workflow-warning-intents.ts';

export type WorkflowDispatchResult = Readonly<Record<string, unknown>>;

type OptionValues = Readonly<Record<string, string | boolean>>;
type DispatchFailure = Readonly<{
  status: 'failed';
  changed: false;
  error: Readonly<{ code: string; message: string }>;
}>;

function failed(code: string, message: string): DispatchFailure {
  return { status: 'failed', changed: false, error: { code, message } };
}

function isFailure(value: unknown): value is DispatchFailure {
  return Boolean(value) && typeof value === 'object' && (value as { status?: unknown }).status === 'failed';
}

function options(
  args: readonly string[],
  allowed: Readonly<Record<string, string>>
): OptionValues | DispatchFailure {
  const values: Record<string, string | boolean> = {};
  for (let index = 2; index < args.length; index += 1) {
    const flag = args[index]!;
    if (flag === '--dry-run') {
      if (!Object.hasOwn(allowed, flag) || values[flag] !== undefined) return failed('TASK_WORKFLOW_PAYLOAD_INVALID', `invalid option '${flag}'`);
      values[flag] = true;
      continue;
    }
    const key = allowed[flag];
    if (!key || values[flag] !== undefined) return failed('TASK_WORKFLOW_PAYLOAD_INVALID', `invalid option '${flag}'`);
    const value = args[++index];
    if (value === undefined || value.startsWith('--')) return failed('TASK_WORKFLOW_PAYLOAD_INVALID', `option '${flag}' requires a value`);
    if (flag === '--needs-implementation' && value !== 'true' && value !== 'false') {
      return failed('TASK_WORKFLOW_PAYLOAD_INVALID', "option '--needs-implementation' must be true or false");
    }
    values[flag] = value;
  }
  return values;
}

function value(values: OptionValues, flag: string): string | undefined {
  const candidate = values[flag];
  return typeof candidate === 'string' ? candidate : undefined;
}

function required(values: OptionValues, flags: readonly string[]): DispatchFailure | null {
  const missing = flags.find((flag) => value(values, flag) === undefined);
  return missing ? failed('TASK_WORKFLOW_PAYLOAD_INVALID', `option '${missing}' is required`) : null;
}

function resultForLock(error: unknown): WorkflowDispatchResult {
  if (error instanceof TaskExecutionLockError) return failed(error.code, error.message);
  throw error;
}

function ledgerIntent(operation: TaskWorkflowOperation, args: readonly string[]): LedgerIntent | DispatchFailure {
  const [taskRef, kind] = args;
  const mappings: Partial<Record<TaskWorkflowOperation, {
    kind: LedgerIntent['kind']; required: readonly string[]; flags: Readonly<Record<string, string>>;
  }>> = {
    'ledger-finding-response': {
      kind: 'finding-respond', required: ['--id', '--round', '--status', '--evidence'],
      flags: { '--id': 'id', '--round': 'round', '--status': 'status', '--evidence': 'evidence', '--dry-run': 'dryRun' }
    },
    'ledger-finding-review': {
      kind: 'finding-review', required: ['--id', '--status', '--evidence'],
      flags: { '--id': 'id', '--status': 'status', '--evidence': 'evidence', '--needs-implementation': 'needsImplementation', '--dry-run': 'dryRun' }
    },
    'ledger-finding-upsert': {
      kind: 'finding-upsert', required: ['--stage', '--review-artifact', '--ordinal', '--severity', '--evidence'],
      flags: { '--stage': 'stage', '--review-artifact': 'reviewArtifact', '--ordinal': 'ordinal', '--severity': 'severity', '--evidence': 'evidence', '--dry-run': 'dryRun' }
    },
    'decision-next-id': { kind: 'decision-next-id', required: [], flags: {} },
    'decision-upsert': {
      kind: 'decision-upsert', required: ['--id', '--stage', '--artifact'],
      flags: { '--id': 'id', '--stage': 'stage', '--artifact': 'artifact', '--needs-implementation': 'needsImplementation', '--dry-run': 'dryRun' }
    }
  };
  const mapping = mappings[operation];
  if (!mapping || !taskRef || kind === undefined) return failed('TASK_WORKFLOW_PAYLOAD_INVALID', 'task workflow ledger request is invalid');
  const values = options(args, mapping.flags);
  if (isFailure(values)) return values;
  const missing = required(values, mapping.required);
  if (missing) return missing;
  const dryRun = values['--dry-run'] === true;
  if (mapping.kind === 'decision-next-id') return { kind: mapping.kind, taskRef };
  if (mapping.kind === 'finding-respond') return {
    kind: mapping.kind, taskRef, id: value(values, '--id')!, round: Number(value(values, '--round')),
    status: value(values, '--status') as never, evidence: value(values, '--evidence')!, ...(dryRun ? { dryRun } : {})
  } as LedgerIntent;
  if (mapping.kind === 'finding-review') return {
    kind: mapping.kind, taskRef, id: value(values, '--id')!, status: value(values, '--status') as never,
    evidence: value(values, '--evidence')!, ...(value(values, '--needs-implementation') === 'true' ? { needsImplementation: true } : {}),
    ...(dryRun ? { dryRun } : {})
  } as LedgerIntent;
  if (mapping.kind === 'finding-upsert') return {
    kind: mapping.kind, taskRef, stage: value(values, '--stage') as never, reviewArtifact: value(values, '--review-artifact')!,
    ordinal: Number(value(values, '--ordinal')), severity: value(values, '--severity') as never, evidence: value(values, '--evidence')!,
    ...(dryRun ? { dryRun } : {})
  } as LedgerIntent;
  return {
    kind: mapping.kind, taskRef, id: value(values, '--id')!, stage: value(values, '--stage') as never,
    artifact: value(values, '--artifact')!, ...(value(values, '--needs-implementation') === 'true' ? { needsImplementation: true } : {}),
    ...(dryRun ? { dryRun } : {})
  } as LedgerIntent;
}

function warningIntent(args: readonly string[]): WorkflowWarningIntent | DispatchFailure {
  const [taskRef, kind] = args;
  if (!taskRef || !['add', 'list', 'set-status'].includes(kind ?? '')) {
    return failed('TASK_WORKFLOW_PAYLOAD_INVALID', 'task workflow warning request is invalid');
  }
  if (kind === 'list') {
    const values = options(args, { '--status': 'status' });
    if (isFailure(values)) return values;
    return { kind, taskRef, ...(value(values, '--status') ? { status: value(values, '--status') as never } : {}) };
  }
  if (kind === 'set-status') {
    const values = options(args, { '--id': 'id', '--status': 'status', '--resolution': 'resolution', '--dry-run': 'dryRun' });
    if (isFailure(values)) return values;
    const missing = required(values, ['--id', '--status', '--resolution']);
    if (missing) return missing;
    return {
      kind, taskRef, id: value(values, '--id')!, status: value(values, '--status') as never,
      resolution: value(values, '--resolution')!, ...(values['--dry-run'] === true ? { dryRun: true } : {})
    };
  }
  const values = options(args, {
    '--step': 'step', '--severity': 'severity', '--code': 'code', '--target': 'target',
    '--message': 'message', '--action': 'action', '--dry-run': 'dryRun'
  });
  if (isFailure(values)) return values;
  const missing = required(values, ['--step', '--severity', '--code', '--target', '--message', '--action']);
  if (missing) return missing;
  return {
    kind: 'add', taskRef, step: value(values, '--step')!, severity: value(values, '--severity') as never,
    code: value(values, '--code')!, target: value(values, '--target')!, message: value(values, '--message')!,
    action: value(values, '--action')!, ...(values['--dry-run'] === true ? { dryRun: true } : {})
  } as WorkflowWarningIntent;
}

function stageStatus(repoRoot: string, args: readonly string[]): WorkflowDispatchResult {
  const [taskRef, kind] = args;
  if (!taskRef || kind !== 'stage-status') return failed('TASK_WORKFLOW_PAYLOAD_INVALID', 'task workflow ledger request is invalid');
  const values = options(args, { '--stage': 'stage' });
  if (isFailure(values)) return values;
  const stage = value(values, '--stage');
  if (!stage || !isReviewStage(stage)) return failed('TASK_WORKFLOW_PAYLOAD_INVALID', 'stage-status requires a valid review stage');
  const resolved = resolveTaskRef(taskRef, { repoRoot });
  if (!resolved.ok) return failed(resolved.code, resolved.message);
  try {
    const ledger = parseLedgerDocument(fs.readFileSync(resolved.taskMdPath, 'utf8'));
    if (!ledger.present) return failed('LEDGER_SECTION_MISSING', 'review disagreement ledger section is missing');
    const invalid = validateLedgerRows(ledger.rows);
    if (invalid) return failed(invalid.code, invalid.message);
    return { status: 'ready', changed: false, taskId: resolved.taskId, stageStatus: summarizeLedgerStage(ledger.rows, stage), error: null };
  } catch (error) {
    return failed('LEDGER_DOCUMENT_INVALID', error instanceof Error ? error.message : String(error));
  }
}

/**
 * The caller has already selected and authorized the execution boundary.
 * This function deliberately invokes task domains in that process: starting a
 * second CLI process would discard the broker binding and could misclassify a
 * sandbox process with cleared environment variables as direct-host.
 */
export function dispatchWorkflowCommand(
  repoRoot: string,
  operation: TaskWorkflowOperation,
  args: readonly string[]
): WorkflowDispatchResult {
  const taskRef = args[0];
  if (!taskRef) return failed('TASK_WORKFLOW_PAYLOAD_INVALID', 'task ref is required');
  try {
    if (operation === 'invalidation-reconcile') {
      const values = options(args, { '--max-targets': 'maxTargets', '--dry-run': 'dryRun' });
      if (isFailure(values)) return values;
      const maxTargets = value(values, '--max-targets');
      if (maxTargets !== undefined && (!Number.isSafeInteger(Number(maxTargets)) || Number(maxTargets) < 1)) {
        return failed('TASK_WORKFLOW_PAYLOAD_INVALID', '--max-targets must be a positive integer');
      }
      return withTaskExecutionLock(repoRoot, taskRef, 'task-invalidation.reconcile', () => reconcileTaskInvalidation(taskRef, {
        repoRoot, ...(maxTargets === undefined ? {} : { maxTargets: Number(maxTargets) }),
        ...(values['--dry-run'] === true ? { dryRun: true } : {})
      }));
    }
    if (operation === 'ledger-stage-status') return stageStatus(repoRoot, args);
    if (operation === 'warning-add' || operation === 'warning-list' || operation === 'warning-set-status') {
      const intent = warningIntent(args);
      if (isFailure(intent)) return intent;
      if (intent.kind === 'list') return applyWorkflowWarningIntent(intent, { repoRoot });
      return withTaskExecutionLock(repoRoot, taskRef, `task-warning.${intent.kind}`, () => applyWorkflowWarningIntent(intent, { repoRoot }));
    }
    const intent = ledgerIntent(operation, args);
    if (isFailure(intent)) return intent;
    return withTaskExecutionLock(repoRoot, taskRef, `task-ledger.${intent.kind}`, () => applyLedgerIntent(intent, { repoRoot }));
  } catch (error) {
    return resultForLock(error);
  }
}
