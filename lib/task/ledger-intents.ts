import fs from 'node:fs';
import path from 'node:path';

import {
  declareImplementationInput,
  IMPLEMENTATION_INPUT_ALIASES,
  parseImplementationInputs,
  renderImplementationInputs
} from './implementation-inputs.ts';
import { LEDGER_COLUMNS, LEDGER_HEADINGS, nextHdId, parseLedger, validateLedgerRows } from './ledger.ts';
import type { LedgerRow, ReviewStage } from './ledger.ts';
import { resolveTaskRef } from './resolve-ref.ts';
import { writeTask } from './write.ts';
import type { TaskMutation, TaskOperationSummary, TaskWriteOptions } from './write.ts';
import { allowsManualOverride } from './guard-override.ts';

type ReviewSeverity = 'blocker' | 'major' | 'minor';
type ExecutorResponse = 'accepted' | 'adjusted' | 'refuted' | 'cannot-judge';
type ReviewDisposition = 'confirmed' | 'closed' | 'open' | 'needs-human-decision';
type LedgerIntent =
  | { kind: 'finding-upsert'; taskRef: string; stage: ReviewStage; reviewArtifact: string; ordinal: number; severity: ReviewSeverity; evidence: string; dryRun?: boolean }
  | { kind: 'finding-respond'; taskRef: string; id: string; round: number; status: ExecutorResponse; evidence: string; dryRun?: boolean }
  | { kind: 'finding-review'; taskRef: string; id: string; status: ReviewDisposition; evidence: string; needsImplementation?: boolean; dryRun?: boolean }
  | { kind: 'decision-next-id'; taskRef: string }
  | { kind: 'decision-upsert'; taskRef: string; id: string; stage: ReviewStage; artifact: string; needsImplementation?: boolean; dryRun?: boolean };

type LedgerIntentError = { code: string; message: string };
type LedgerIntentResult = {
  status: 'planned' | 'applied' | 'no-op' | 'failed';
  changed: boolean;
  intent: LedgerIntent['kind'];
  taskId: string | null;
  entityId: string | null;
  before: LedgerRow | null;
  after: LedgerRow | null;
  operations: readonly TaskOperationSummary[];
  error: LedgerIntentError | null;
};

const PREFIX: Record<ReviewStage, string> = { analysis: 'AN', plan: 'PL', code: 'CD' };
const RESPONSE = new Set<ExecutorResponse>(['accepted', 'adjusted', 'refuted', 'cannot-judge']);
const DISPOSITION = new Set<ReviewDisposition>(['confirmed', 'closed', 'open', 'needs-human-decision']);
const REVIEW_ARTIFACT: Record<ReviewStage, RegExp> = {
  analysis: /^review-analysis(?:-r(?:[2-9]|[1-9]\d+))?\.md$/,
  plan: /^review-plan(?:-r(?:[2-9]|[1-9]\d+))?\.md$/,
  code: /^review-code(?:-r(?:[2-9]|[1-9]\d+))?\.md$/
};
const ARTIFACT: Record<ReviewStage, RegExp> = {
  analysis: /^analysis(?:-r(?:[2-9]|[1-9]\d+))?\.md$/,
  plan: /^plan(?:-r(?:[2-9]|[1-9]\d+))?\.md$/,
  code: /^code(?:-r(?:[2-9]|[1-9]\d+))?\.md$/
};

function failed(intent: LedgerIntent, code: string, message: string, taskId: string | null = null, entityId: string | null = null): LedgerIntentResult {
  return { status: 'failed', changed: false, intent: intent.kind, taskId, entityId, before: null, after: null, operations: [], error: { code, message } };
}

function normalizedEvidence(value: string): string {
  return value.trim();
}

function ledgerReadErrorCode(error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  return code === 'TABLE_DUPLICATE_KEY' ? 'LEDGER_DUPLICATE_ID' : 'LEDGER_DOCUMENT_INVALID';
}

function maxHandshakeRounds(repoRoot: string): number {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(repoRoot, '.agents', '.airc.json'), 'utf8')) as { review?: { maxHandshakeRounds?: unknown } };
    const value = parsed.review?.maxHandshakeRounds;
    return Number.isInteger(value) && Number(value) > 0 ? Number(value) : 3;
  } catch { return 3; }
}

function nextFindingId(rows: readonly LedgerRow[], stage: ReviewStage): string {
  const prefix = PREFIX[stage];
  let max = 0;
  for (const row of rows) {
    const match = new RegExp(`^${prefix}-(\\d+)$`).exec(row.id);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `${prefix}-${max + 1}`;
}

function reviewArtifactRound(reviewArtifact: string): number {
  const match = /-r([1-9]\d*)\.md$/.exec(reviewArtifact);
  return match ? Number(match[1]) : 1;
}

function rowMutation(row: LedgerRow): TaskMutation {
  return {
    kind: 'table-row', action: 'upsert', sectionAliases: LEDGER_HEADINGS,
    columns: LEDGER_COLUMNS, keyColumn: 'id', key: row.id,
    values: { stage: row.stage, round: row.round, severity: row.severity, status: row.status, evidence: row.evidence }
  };
}

function ledgerSectionMutation(content: string): TaskMutation[] {
  if (/^##\s+(审查分歧账本|Review Disagreement Ledger)\s*$/m.test(content)) return [];
  const english = /^##\s+Activity Log\s*$/m.test(content);
  return [{
    kind: 'section', aliases: LEDGER_HEADINGS, heading: english ? 'Review Disagreement Ledger' : '审查分歧账本',
    body: `| ${LEDGER_COLUMNS.join(' | ')} |\n|----|-------|-------|----------|--------|----------|`
  }];
}

function implementationInputMutation(content: string, rows: Parameters<typeof renderImplementationInputs>[0]): TaskMutation {
  const english = /^##\s+Activity Log\s*$/m.test(content);
  return {
    kind: 'section', aliases: IMPLEMENTATION_INPUT_ALIASES,
    heading: english ? 'Implementation Inputs' : '实现输入',
    body: renderImplementationInputs(rows)
  };
}

function mapWrite(intent: LedgerIntent, entityId: string, before: LedgerRow | null, after: LedgerRow, result: ReturnType<typeof writeTask>): LedgerIntentResult {
  if (result.status === 'failed') return failed(intent, result.error.code, result.error.message, result.taskId, entityId);
  return { status: result.status, changed: result.changed, intent: intent.kind, taskId: result.taskId, entityId, before, after, operations: result.operations, error: null };
}

function applyLedgerIntent(intent: LedgerIntent, options: TaskWriteOptions = {}): LedgerIntentResult {
  const resolved = resolveTaskRef(intent.taskRef, { repoRoot: options.repoRoot });
  if (!resolved.ok) return failed(intent, resolved.code, resolved.message, resolved.taskId);
  const stateOverride = allowsManualOverride(options.manualOverride, 'ledger-intent', 'TASK_STATE_MISMATCH');
  if (resolved.state !== 'active' && !stateOverride) return failed(intent, 'TASK_STATE_MISMATCH', `task ${resolved.taskId} is ${resolved.state}, expected active`, resolved.taskId);
  let content: string;
  let rows: LedgerRow[];
  try {
    content = fs.readFileSync(resolved.taskMdPath, 'utf8');
    rows = parseLedger(content);
  } catch (error) {
    return failed(intent, ledgerReadErrorCode(error), error instanceof Error ? error.message : String(error), resolved.taskId);
  }
  const invalidRows = validateLedgerRows(rows);
  if (invalidRows) return failed(intent, invalidRows.code, invalidRows.message, resolved.taskId);

  if (intent.kind === 'decision-next-id') {
    return { status: 'no-op', changed: false, intent: intent.kind, taskId: resolved.taskId, entityId: nextHdId(rows), before: null, after: null, operations: [], error: null };
  }

  let before: LedgerRow | null = null;
  let after: LedgerRow;
  if (intent.kind === 'finding-upsert') {
    if (!REVIEW_ARTIFACT[intent.stage]?.test(intent.reviewArtifact) || !Number.isInteger(intent.ordinal) || intent.ordinal < 1 || !['blocker', 'major', 'minor'].includes(intent.severity)) {
      return failed(intent, 'LEDGER_PAYLOAD_INVALID', 'finding identity, stage, ordinal, or severity is invalid', resolved.taskId);
    }
    const evidence = normalizedEvidence(intent.evidence);
    if (!evidence.startsWith(`${intent.reviewArtifact}#`) || /[\r\n]/.test(evidence)) {
      return failed(intent, 'LEDGER_EVIDENCE_INVALID', 'finding evidence must be a single-line anchor in the review artifact', resolved.taskId);
    }
    const artifactRows = rows.filter((row) => row.stage === intent.stage && row.id.startsWith(`${PREFIX[intent.stage]}-`) && row.evidence.startsWith(`${intent.reviewArtifact}#`));
    if (artifactRows.length < intent.ordinal - 1) return failed(intent, 'LEDGER_IDENTITY_CONFLICT', 'finding ordinals must be submitted in order', resolved.taskId);
    before = artifactRows[intent.ordinal - 1] ?? null;
    if (before) {
      if (before.severity !== intent.severity || before.evidence !== evidence || before.status !== 'open') {
        return failed(intent, 'LEDGER_IDENTITY_CONFLICT', 'finding identity conflicts with the existing open row', resolved.taskId, before.id);
      }
      after = { ...before };
    } else {
      const id = nextFindingId(rows, intent.stage);
      after = {
        id, stage: intent.stage, round: String(reviewArtifactRound(intent.reviewArtifact)),
        severity: intent.severity, status: 'open', evidence, sourceLine: -1
      };
    }
  } else if (intent.kind === 'decision-upsert') {
    if (!/^HD-[1-9]\d*$/.test(intent.id) || !ARTIFACT[intent.stage]?.test(intent.artifact)) {
      return failed(intent, 'LEDGER_PAYLOAD_INVALID', 'decision id, stage, or artifact is invalid', resolved.taskId, intent.id);
    }
    const evidence = `${intent.artifact}#${intent.id}`;
    before = rows.find((row) => row.id === intent.id) ?? null;
    if (before) {
      if (before.stage !== intent.stage || before.round !== '-' || before.severity !== 'decision' || before.status !== 'needs-human-decision' || before.evidence !== evidence) {
        return failed(intent, 'LEDGER_IDENTITY_CONFLICT', `decision id '${intent.id}' conflicts with an existing row`, resolved.taskId, intent.id);
      }
      after = { ...before };
    } else {
      if (intent.id !== nextHdId(rows)) return failed(intent, 'LEDGER_ID_CONFLICT', `next decision id is ${nextHdId(rows)}`, resolved.taskId, intent.id);
      after = { id: intent.id, stage: intent.stage, round: '-', severity: 'decision', status: 'needs-human-decision', evidence, sourceLine: -1 };
    }
  } else {
    before = rows.find((row) => row.id === intent.id) ?? null;
    if (!before || !/^(AN|PL|CD)-[1-9]\d*$/.test(before.id)) return failed(intent, 'LEDGER_NOT_FOUND', `finding '${intent.id}' was not found`, resolved.taskId, intent.id);
    const evidence = normalizedEvidence(intent.evidence);
    if (!evidence || /[\r\n]/.test(evidence)) return failed(intent, 'LEDGER_EVIDENCE_INVALID', 'evidence must be a non-empty single line', resolved.taskId, intent.id);
    if (intent.kind === 'finding-respond') {
      if (!RESPONSE.has(intent.status) || !Number.isInteger(intent.round) || intent.round < 1) return failed(intent, 'LEDGER_PAYLOAD_INVALID', 'response status or round is invalid', resolved.taskId, intent.id);
      if (before.status === intent.status && before.round === String(intent.round) && before.evidence === evidence) after = { ...before };
      else if (before.status !== 'open' || Number(before.round) + 1 !== intent.round) return failed(intent, 'LEDGER_TRANSITION_INVALID', `finding '${intent.id}' cannot accept this response`, resolved.taskId, intent.id);
      else after = { ...before, round: String(intent.round), status: intent.status, evidence };
    } else {
      if (!DISPOSITION.has(intent.status)) return failed(intent, 'LEDGER_PAYLOAD_INVALID', 'review disposition is invalid', resolved.taskId, intent.id);
      if (before.status === intent.status && before.evidence === evidence) after = { ...before };
      else {
        const allowed = before.status === 'accepted'
          ? new Set(['closed', 'open', 'needs-human-decision'])
          : before.status === 'adjusted' || before.status === 'refuted'
            ? new Set(['confirmed', 'open', 'needs-human-decision'])
            : before.status === 'cannot-judge' ? new Set(['open', 'needs-human-decision']) : new Set<string>();
        const sameRoundMinorClose = before.status === 'open' && before.severity === 'minor' && intent.status === 'closed';
        if (((!sameRoundMinorClose && !allowed.has(intent.status)) || (intent.status === 'open' && Number(before.round) >= maxHandshakeRounds(resolved.repoRoot)))
          && !allowsManualOverride(options.manualOverride, 'ledger-intent', 'LEDGER_TRANSITION_INVALID')) {
          return failed(intent, 'LEDGER_TRANSITION_INVALID', `finding '${intent.id}' cannot transition from ${before.status} to ${intent.status}`, resolved.taskId, intent.id);
        }
        after = { ...before, status: intent.status, evidence };
      }
    }
  }

  let implementationMutation: TaskMutation | null = null;
  if (intent.kind === 'decision-upsert' || intent.kind === 'finding-review') {
    const stage = intent.kind === 'decision-upsert' ? intent.stage : after.stage;
    const escalates = intent.kind === 'decision-upsert' || intent.status === 'needs-human-decision';
    if (stage === 'code' && escalates && intent.needsImplementation === undefined) {
      return failed(intent, 'LEDGER_PAYLOAD_INVALID', 'code-stage decisions require --needs-implementation true|false', resolved.taskId, after.id);
    }
    if ((stage !== 'code' || !escalates) && intent.needsImplementation !== undefined) {
      return failed(intent, 'LEDGER_PAYLOAD_INVALID', '--needs-implementation is only valid for code-stage escalation', resolved.taskId, after.id);
    }
    if (stage === 'code' && escalates) {
      try {
        const parsed = parseImplementationInputs(content);
        const declaration = declareImplementationInput(parsed.rows, {
          ledgerId: after.id, decisionEvidence: after.evidence,
          needsImplementation: intent.needsImplementation!
        });
        const nextRows = parsed.rows.includes(declaration) ? parsed.rows : [...parsed.rows, declaration];
        implementationMutation = implementationInputMutation(content, nextRows);
      } catch (error) {
        return failed(intent, 'LEDGER_DOCUMENT_INVALID', error instanceof Error ? error.message : String(error), resolved.taskId, after.id);
      }
    }
  }

  const result = writeTask({
    taskRef: intent.taskRef, expectedState: stateOverride ? resolved.state : 'active',
    mutations: [...ledgerSectionMutation(content), rowMutation(after), ...(implementationMutation ? [implementationMutation] : [])],
    dryRun: 'dryRun' in intent ? intent.dryRun : false
  }, { ...options, taskLocation: { repoRoot: resolved.repoRoot, taskId: resolved.taskId, taskMdPath: resolved.taskMdPath, state: resolved.state } });
  return mapWrite(intent, after.id, before, after, result);
}

export { applyLedgerIntent };
export type { LedgerIntent, LedgerIntentResult, LedgerIntentError, ReviewSeverity, ExecutorResponse, ReviewDisposition };
