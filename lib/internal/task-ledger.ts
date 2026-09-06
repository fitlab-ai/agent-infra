import fs from 'node:fs';

import { applyLedgerIntent } from '../task/ledger-intents.ts';
import type { LedgerIntent } from '../task/ledger-intents.ts';
import { consumeHumanOverride, failureId, overrideDryRunConflict } from '../task/human-override.ts';
import { LEDGER_SECTION_MISSING_CODE, LEDGER_SECTION_MISSING_MESSAGE, isReviewStage, parseLedgerDocument, summarizeLedgerStage, validateLedgerRows } from '../task/ledger.ts';
import { resolveTaskRef } from '../task/resolve-ref.ts';
import { TaskExecutionLockError, withTaskExecutionLock } from '../task/task-execution-lock.ts';
import { ensureInternalHandlerRoute, internalHandlerRoute } from './cli-route-inventory.ts';

const USAGE = `Usage: agent-infra-internal task-ledger <task-ref> <intent> [intent flags] [--dry-run]\n\nIntents: finding-upsert, finding-respond, finding-review, decision-next-id, decision-upsert, rework-intent-upsert, stage-status\n`;
const FLAGS: Record<string, string> = {
  '--stage': 'stage', '--review-artifact': 'reviewArtifact', '--ordinal': 'ordinal',
  '--severity': 'severity', '--evidence': 'evidence', '--id': 'id', '--round': 'round',
  '--status': 'status', '--artifact': 'artifact', '--needs-implementation': 'needsImplementation',
  '--intent-id': 'intentId', '--finding-id': 'findingId', '--source-artifact': 'sourceArtifact',
  '--source-sha256': 'sourceSha256', '--target': 'target',
  '--override-ticket': 'overrideTicket', '--override-target': 'overrideTarget', '--override-scope': 'overrideScope'
};
const NUMERIC = new Set(['ordinal', 'round']);
const BOOLEAN = new Set(['needsImplementation']);

function usageFailure(message: string): void {
  process.stdout.write(`${JSON.stringify({ status: 'failed', changed: false, error: { code: 'LEDGER_PAYLOAD_INVALID', message } })}\n`);
  process.stderr.write(USAGE);
  process.exitCode = 1;
}

async function taskLedger(args: string[] = []): Promise<void> {
  if (!ensureInternalHandlerRoute('task-ledger', args)) return;
  if (args[0] === '--help' || args[0] === '-h') { process.stdout.write(USAGE); return; }
  const [taskRef, kind] = args;
  if (!taskRef || !kind) { usageFailure('task ref and intent are required'); return; }
  if (![
    internalHandlerRoute('task-ledger', 'finding-upsert', kind),
    internalHandlerRoute('task-ledger', 'finding-respond', kind),
    internalHandlerRoute('task-ledger', 'finding-review', kind),
    internalHandlerRoute('task-ledger', 'decision-next-id', kind),
    internalHandlerRoute('task-ledger', 'decision-upsert', kind),
    internalHandlerRoute('task-ledger', 'rework-intent-upsert', kind),
    internalHandlerRoute('task-ledger', 'stage-status', kind)
  ].some(Boolean)) {
    usageFailure(`unknown ledger intent '${kind}'`); return;
  }
  const values: Record<string, unknown> = { kind, taskRef };
  const seen = new Set<string>();
  for (let index = 2; index < args.length; index += 1) {
    const flag = args[index]!;
    if (flag === '--dry-run') {
      if (seen.has(flag)) { usageFailure(`duplicate option '${flag}'`); return; }
      seen.add(flag); values.dryRun = true; continue;
    }
    const key = FLAGS[flag];
    if (!key) { usageFailure(`unknown option '${flag}'`); return; }
    if (seen.has(flag)) { usageFailure(`duplicate option '${flag}'`); return; }
    const value = args[++index];
    if (value === undefined || value.startsWith('--')) { usageFailure(`option '${flag}' requires a value`); return; }
    if (BOOLEAN.has(key) && value !== 'true' && value !== 'false') {
      usageFailure(`option '${flag}' must be true or false`); return;
    }
    seen.add(flag);
    values[key] = NUMERIC.has(key) ? Number(value) : BOOLEAN.has(key) ? value === 'true' : value;
  }
  const required: Record<string, string[]> = {
    'finding-upsert': ['stage', 'reviewArtifact', 'ordinal', 'severity', 'evidence'],
    'finding-respond': ['id', 'round', 'status', 'evidence'],
    'finding-review': ['id', 'status', 'evidence'],
    'decision-next-id': [],
    'decision-upsert': ['id', 'stage', 'artifact'],
    'rework-intent-upsert': ['intentId', 'findingId', 'sourceArtifact', 'sourceSha256', 'target'],
    'stage-status': ['stage']
  };
  const optional: Record<string, string[]> = {
    'finding-review': ['needsImplementation'],
    'decision-upsert': ['needsImplementation']
  };
  const overrideFields = kind === 'stage-status' || kind === 'decision-next-id' || kind === 'rework-intent-upsert'
    ? []
    : ['overrideTicket', 'overrideTarget', 'overrideScope'];
  const allowed = new Set(['kind', 'taskRef', 'dryRun', ...required[kind]!, ...(optional[kind] ?? []), ...overrideFields]);
  const unexpected = Object.keys(values).find((key) => !allowed.has(key));
  const missing = required[kind]!.find((key) => values[key] === undefined);
  if (unexpected) { usageFailure(`${kind} does not accept '${unexpected}'`); return; }
  if (missing) { usageFailure(`${kind} requires '${missing}'`); return; }
  const dryRunConflict = overrideDryRunConflict(values);
  if (dryRunConflict) { usageFailure(dryRunConflict.message); return; }
  if (kind === 'stage-status') {
    if (!isReviewStage(String(values.stage))) { usageFailure(`stage-status requires a valid review stage`); return; }
    const resolved = resolveTaskRef(taskRef);
    if (!resolved.ok || resolved.state !== 'active') {
      const message = resolved.ok ? `task ${resolved.taskId} is ${resolved.state}, expected active` : resolved.message;
      process.stdout.write(`${JSON.stringify({ status: 'failed', changed: false, error: { code: resolved.ok ? 'TASK_STATE_MISMATCH' : resolved.code, message } })}\n`);
      process.exitCode = 1;
      return;
    }
    try {
      const ledger = parseLedgerDocument(fs.readFileSync(resolved.taskMdPath, 'utf8'));
      if (!ledger.present) {
        process.stdout.write(`${JSON.stringify({ status: 'failed', changed: false, taskId: resolved.taskId, error: { code: LEDGER_SECTION_MISSING_CODE, message: LEDGER_SECTION_MISSING_MESSAGE } })}\n`);
        process.exitCode = 1;
        return;
      }
      const rows = ledger.rows;
      const invalid = validateLedgerRows(rows);
      if (invalid) {
        process.stdout.write(`${JSON.stringify({ status: 'failed', changed: false, taskId: resolved.taskId, error: invalid })}\n`);
        process.exitCode = 1;
        return;
      }
      process.stdout.write(`${JSON.stringify({ status: 'ready', changed: false, taskId: resolved.taskId, stageStatus: summarizeLedgerStage(rows, values.stage as 'analysis' | 'plan' | 'code'), error: null })}\n`);
    } catch (error) {
      process.stdout.write(`${JSON.stringify({ status: 'failed', changed: false, taskId: resolved.taskId, error: { code: 'LEDGER_DOCUMENT_INVALID', message: error instanceof Error ? error.message : String(error) } })}\n`);
      process.exitCode = 1;
    }
    return;
  }
  const lockResolved = resolveTaskRef(taskRef);
  if (!lockResolved.ok) { usageFailure(lockResolved.message); return; }
  let result;
  let humanOverride: unknown = null;
  try {
    result = await withTaskExecutionLock(lockResolved.repoRoot, lockResolved.taskId, `task-ledger.${kind}`, async () => {
      let current = applyLedgerIntent(values as LedgerIntent);
      if (current.status !== 'failed' || !values.overrideTicket) return current;
      if (!values.overrideTarget || !values.overrideScope) { usageFailure('override ticket requires target and scope'); return current; }
      const consumed = await consumeHumanOverride({
        taskRef,
        ticketId: String(values.overrideTicket),
        failureId: failureId('ledger-intent', current.error?.code ?? 'TASK_STATE_MISMATCH'),
        target: String(values.overrideTarget),
        scope: String(values.overrideScope)
      }, {
        effectExecutor: (capability) => {
          const retried = applyLedgerIntent(values as LedgerIntent, { manualOverride: capability });
          current = retried;
          return retried.status === 'failed'
            ? { code: 'OVERRIDE_EFFECT_FAILED', message: `${retried.error?.code ?? 'LEDGER_FAILED'}: ${retried.error?.message ?? 'manual ledger effect failed'}` }
            : null;
        }
      });
      humanOverride = consumed;
      return current;
    });
  } catch (error) {
    if (!(error instanceof TaskExecutionLockError)) throw error;
    process.stdout.write(`${JSON.stringify({ status: 'failed', changed: false, error: { code: error.code, message: error.message } })}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`${JSON.stringify(humanOverride ? { ...result, humanOverride } : result)}\n`);
  const overrideFailed = Boolean(
    humanOverride && typeof humanOverride === 'object' &&
    (humanOverride as { status?: unknown }).status === 'failed'
  );
  if (result.status === 'failed' || overrideFailed) process.exitCode = 1;
}

export { taskLedger };
