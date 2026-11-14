import fs from 'node:fs';

import { applyLedgerIntent } from '../task/ledger-intents.ts';
import type { LedgerIntent } from '../task/ledger-intents.ts';
import { LEDGER_SECTION_MISSING_CODE, LEDGER_SECTION_MISSING_MESSAGE, isReviewStage, parseLedgerDocument, summarizeLedgerStage, validateLedgerRows } from '../task/ledger.ts';
import { resolveTaskRef } from '../task/resolve-ref.ts';
import { ensureInternalHandlerRoute, internalHandlerRoute } from './cli-route-inventory.ts';

const USAGE = `Usage: agent-infra-internal task-ledger <task-ref> <intent> [intent flags] [--dry-run]\n\nIntents: finding-upsert, finding-respond, finding-review, decision-next-id, decision-upsert, rework-intent-upsert, rework-intent-rebuild, stage-status\n`;
const FLAGS: Record<string, string> = {
  '--stage': 'stage', '--review-artifact': 'reviewArtifact', '--ordinal': 'ordinal',
  '--severity': 'severity', '--evidence': 'evidence', '--id': 'id', '--round': 'round',
  '--status': 'status', '--artifact': 'artifact', '--needs-implementation': 'needsImplementation',
  '--intent-id': 'intentId', '--finding-id': 'findingId', '--source-artifact': 'sourceArtifact',
  '--source-sha256': 'sourceSha256', '--classification': 'classification'
};
const NUMERIC = new Set(['ordinal', 'round']);
const BOOLEAN = new Set(['needsImplementation']);
const REWORK_CLASSIFICATIONS = new Set(['scope-or-requirement', 'design', 'implementation', 'human-decision', 'insufficient-evidence']);
const REQUIRED: Record<string, string[]> = {
  'finding-upsert': ['stage', 'reviewArtifact', 'ordinal', 'severity', 'evidence'],
  'finding-respond': ['id', 'round', 'status', 'evidence'],
  'finding-review': ['id', 'status', 'evidence'],
  'decision-next-id': [],
  'decision-upsert': ['id', 'stage', 'artifact'],
  'rework-intent-upsert': ['intentId', 'findingId', 'sourceArtifact', 'sourceSha256', 'classification'],
  'rework-intent-rebuild': [],
  'stage-status': ['stage']
};
const OPTIONAL: Record<string, string[]> = {
  'finding-review': ['needsImplementation'],
  'decision-upsert': ['needsImplementation'],
  'rework-intent-rebuild': ['findingId', 'sourceArtifact', 'sourceSha256', 'classification']
};

function usageFailure(message: string): void {
  process.stdout.write(`${JSON.stringify({ status: 'failed', changed: false, error: { code: 'LEDGER_PAYLOAD_INVALID', message } })}\n`);
  process.stderr.write(USAGE);
  process.exitCode = 1;
}

type LedgerValues = Record<string, unknown> & { kind: string; taskRef: string };

function parseLedgerOptions(args: string[], values: LedgerValues): string | null {
  const seen = new Set<string>();
  for (let index = 2; index < args.length; index += 1) {
    const flag = args[index]!;
    if (flag === '--dry-run') {
      if (seen.has(flag)) return `duplicate option '${flag}'`;
      seen.add(flag); values.dryRun = true; continue;
    }
    const key = FLAGS[flag];
    if (!key) return `unknown option '${flag}'`;
    if (seen.has(flag)) return `duplicate option '${flag}'`;
    const value = args[++index];
    if (value === undefined || value.startsWith('--')) return `option '${flag}' requires a value`;
    if (BOOLEAN.has(key) && value !== 'true' && value !== 'false') return `option '${flag}' must be true or false`;
    seen.add(flag);
    values[key] = NUMERIC.has(key) ? Number(value) : BOOLEAN.has(key) ? value === 'true' : value;
  }
  return null;
}

function validateLedgerValues(kind: string, values: LedgerValues): string | null {
  const allowed = new Set(['kind', 'taskRef', 'dryRun', ...REQUIRED[kind]!, ...(OPTIONAL[kind] ?? [])]);
  const unexpected = Object.keys(values).find((key) => !allowed.has(key));
  if (unexpected) return `${kind} does not accept '${unexpected}'`;
  const missing = REQUIRED[kind]!.find((key) => values[key] === undefined);
  if (missing) return `${kind} requires '${missing}'`;
  if (values.classification !== undefined && !REWORK_CLASSIFICATIONS.has(String(values.classification))) {
    return `invalid rework classification '${values.classification}'`;
  }
  return null;
}

async function reportStageStatus(taskRef: string, stage: string): Promise<void> {
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
    process.stdout.write(`${JSON.stringify({ status: 'ready', changed: false, taskId: resolved.taskId, stageStatus: summarizeLedgerStage(rows, stage as 'analysis' | 'plan' | 'code'), error: null })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ status: 'failed', changed: false, taskId: resolved.taskId, error: { code: 'LEDGER_DOCUMENT_INVALID', message: error instanceof Error ? error.message : String(error) } })}\n`);
    process.exitCode = 1;
  }
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
    internalHandlerRoute('task-ledger', 'rework-intent-rebuild', kind),
    internalHandlerRoute('task-ledger', 'stage-status', kind)
  ].some(Boolean)) {
    usageFailure(`unknown ledger intent '${kind}'`); return;
  }
  const values: LedgerValues = { kind, taskRef };
  const optionError = parseLedgerOptions(args, values);
  if (optionError) { usageFailure(optionError); return; }
  const validationError = validateLedgerValues(kind, values);
  if (validationError) { usageFailure(validationError); return; }
  if (kind === 'stage-status') {
    if (!isReviewStage(String(values.stage))) { usageFailure(`stage-status requires a valid review stage`); return; }
    await reportStageStatus(taskRef, String(values.stage));
    return;
  }
  const lockResolved = resolveTaskRef(taskRef);
  if (!lockResolved.ok) { usageFailure(lockResolved.message); return; }
  const result = await applyLedgerIntent(values as LedgerIntent);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.status === 'failed') process.exitCode = 1;
}

export { taskLedger };
