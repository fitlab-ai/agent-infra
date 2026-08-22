import fs from 'node:fs';

import { appendActivityEntry, locateActivityLog } from './activity-log.ts';
import { isDecisionItem, listDecisionItems, selectDecisionItem } from './decision-items.ts';
import {
  createImplementationInput,
  finalizeImplementationInput,
  IMPLEMENTATION_INPUT_ALIASES,
  parseImplementationInputs,
  renderImplementationInputs,
  selectDeclaredImplementationInput
} from './implementation-inputs.ts';
import { LEDGER_COLUMNS, LEDGER_HEADINGS, parseLedger } from './ledger.ts';
import type { LedgerRow } from './ledger.ts';
import { resolveTaskContext } from './resolve-ref.ts';
import { extractSection, extractSubSection, findSectionHeading } from './sections.ts';
import { captureTaskWriteMetadata, writeTask } from './write.ts';
import type { TaskMutation, TaskOperationSummary, TaskWriteOptions } from './write.ts';
import { allowsManualOverride } from './guard-override.ts';

type HumanDecisionRequest = {
  taskRef?: string;
  selector: string;
  decision: string;
  needsImplementation?: boolean;
  dryRun?: boolean;
};

type HumanDecisionResult = {
  status: 'planned' | 'applied' | 'no-op' | 'failed'; changed: boolean;
  taskId: string | null; ledgerId: string | null; recordId: string | null;
  implementationInputId: string | null; operations: readonly TaskOperationSummary[];
  error: { code: string; message: string } | null;
};

const DECISION_ALIASES = ['人工裁决', 'Human Rulings', 'Human Decisions', 'Human Decision'] as const;
const ACTIVITY_ALIASES = ['活动日志', 'Activity Log'] as const;

function failed(code: string, message: string, taskId: string | null = null, ledgerId: string | null = null): HumanDecisionResult {
  return { status: 'failed', changed: false, taskId, ledgerId, recordId: null, implementationInputId: null, operations: [], error: { code, message } };
}

function nextRecordId(content: string): string {
  let max = 0;
  for (const match of content.matchAll(/^###\s+HDR-(\d+)\s*$/gm)) max = Math.max(max, Number(match[1]));
  return `HDR-${max + 1}`;
}

function classifyMissing(rows: readonly LedgerRow[], selector: string): string {
  const matches = rows.filter((row) => row.id.toUpperCase() === selector.toUpperCase());
  const valid = matches.filter(isDecisionItem);
  if (valid.some((row) => row.status === 'human-decided')) return `${selector} is already decided`;
  if (valid.length > 0) return `${selector} is not a pending review decision`;
  if (matches.length > 0 || !/^(AN|PL|CD|HD)-\d+$/i.test(selector)) return `${selector} is an invalid decision item`;
  return `${selector} not found in review ledger`;
}

function prependBlock(body: string, block: string): string {
  return body ? `${block}\n\n${body}` : block;
}

function existingDecision(
  content: string,
  row: LedgerRow,
  decision: string,
  needsImplementation: boolean | undefined
): { recordId: string; implementationInputId: string | null } | { conflict: string } {
  const match = /^task\.md#(HDR-[1-9]\d*)$/.exec(row.evidence);
  if (!match) return { conflict: `decided row '${row.id}' has invalid decision evidence` };
  const recordId = match[1]!;
  const block = extractSubSection(content, recordId);
  if (!block || !block.includes(`**原账本 ID**：${row.id}`) || !block.includes(`**裁决结果**：${decision}`)) {
    return { conflict: `decision for '${row.id}' conflicts with ${recordId}` };
  }
  if (row.stage !== 'code') return needsImplementation === undefined
    ? { recordId, implementationInputId: null }
    : { conflict: '--needs-implementation is only valid for code-stage decisions' };
  const inputs = parseImplementationInputs(content).rows.filter((input) => input.ledgerId === row.id && input.decisionEvidence === row.evidence);
  if (inputs.length !== 1 || (needsImplementation !== undefined && inputs[0]!.needsImplementation !== needsImplementation)) {
    return { conflict: `implementation intent for '${row.id}' conflicts with the existing decision` };
  }
  return { recordId, implementationInputId: inputs[0]!.id };
}

function applyHumanDecision(request: HumanDecisionRequest, options: TaskWriteOptions = {}): HumanDecisionResult {
  if (!request.selector || !request.decision.trim()) return failed('DECISION_PAYLOAD_INVALID', 'selector and decision are required');
  const resolved = resolveTaskContext(request.taskRef, { repoRoot: options.repoRoot });
  if (!resolved.ok) return failed(resolved.code, resolved.message, resolved.taskId);
  const stateOverride = allowsManualOverride(options.manualOverride, 'decision-intent', 'TASK_STATE_MISMATCH');
  if (resolved.state !== 'active' && !stateOverride) return failed('TASK_STATE_MISMATCH', `task ${resolved.taskId} is ${resolved.state}, expected active`, resolved.taskId);
  let content: string;
  let rows: LedgerRow[];
  try { content = fs.readFileSync(resolved.taskMdPath, 'utf8'); rows = parseLedger(content); }
  catch (error) { return failed('DECISION_DOCUMENT_INVALID', error instanceof Error ? error.message : String(error), resolved.taskId); }

  const direct = rows.filter((row) => row.id.toUpperCase() === request.selector.toUpperCase());
  if (!/^-?\d+$/.test(request.selector) && direct.length === 1 && direct[0]!.status === 'human-decided' && isDecisionItem(direct[0]!)) {
    try {
      const replay = existingDecision(content, direct[0]!, request.decision.trim(), request.needsImplementation);
      if ('conflict' in replay) return failed('DECISION_CONFLICT', replay.conflict, resolved.taskId, direct[0]!.id);
      return { status: 'no-op', changed: false, taskId: resolved.taskId, ledgerId: direct[0]!.id, recordId: replay.recordId, implementationInputId: replay.implementationInputId, operations: [], error: null };
    } catch (error) { return failed('DECISION_DOCUMENT_INVALID', error instanceof Error ? error.message : String(error), resolved.taskId, direct[0]!.id); }
  }

  const candidates = listDecisionItems(rows);
  const selected = selectDecisionItem(candidates, request.selector);
  if (!selected.ok) {
    const message = selected.code === 'not-found' && !/^-?\d+$/.test(request.selector)
      ? classifyMissing(rows, request.selector) : selected.message;
    return failed('DECISION_TARGET_INVALID', message, resolved.taskId);
  }
  const row = selected.row;
  if (row.stage !== 'code' && request.needsImplementation !== undefined) return failed('DECISION_PAYLOAD_INVALID', '--needs-implementation is only valid for code-stage decisions', resolved.taskId, row.id);

  let parsedInputs: ReturnType<typeof parseImplementationInputs> | null = null;
  let declaredInput: ReturnType<typeof selectDeclaredImplementationInput> = null;
  let effectiveNeedsImplementation = request.needsImplementation;
  if (row.stage === 'code') {
    try {
      parsedInputs = parseImplementationInputs(content);
      declaredInput = selectDeclaredImplementationInput(parsedInputs.rows, row.id, row.evidence);
    } catch (error) {
      return failed('DECISION_DOCUMENT_INVALID', error instanceof Error ? error.message : String(error), resolved.taskId, row.id);
    }
    if (declaredInput) {
      if (request.needsImplementation !== undefined && request.needsImplementation !== declaredInput.needsImplementation) {
        return failed('DECISION_CONFLICT', `implementation intent for '${row.id}' conflicts with its declaration`, resolved.taskId, row.id);
      }
      effectiveNeedsImplementation = declaredInput.needsImplementation;
    } else if (effectiveNeedsImplementation === undefined) {
      return failed('DECISION_PAYLOAD_INVALID', 'code-stage decisions require --needs-implementation true|false when no implementation intent was declared', resolved.taskId, row.id);
    }
  }

  let metadata;
  try { metadata = (options.metadataProvider ?? captureTaskWriteMetadata)(); }
  catch (error) { return failed('METADATA_CAPTURE_FAILED', error instanceof Error ? error.message : String(error), resolved.taskId, row.id); }
  const recordId = nextRecordId(content);
  const evidence = `task.md#${recordId}`;
  const decision = request.decision.trim();
  const record = `### ${recordId}\n\n- **原账本 ID**：${row.id}\n- **裁决时间**：${metadata.timestamp}\n- **裁决结果**：${decision}`;
  const activity = locateActivityLog(content);
  if (!activity) return failed('DECISION_ACTIVITY_MISSING', 'activity log section is missing or ambiguous', resolved.taskId, row.id);
  const mutations: TaskMutation[] = [
    {
      kind: 'table-row', action: 'upsert', sectionAliases: LEDGER_HEADINGS, columns: LEDGER_COLUMNS,
      keyColumn: 'id', key: row.id,
      values: { stage: row.stage, round: row.round, severity: row.severity, status: 'human-decided', evidence }
    },
    {
      kind: 'section', aliases: DECISION_ALIASES,
      heading: findSectionHeading(content, [...DECISION_ALIASES]),
      body: prependBlock(extractSection(content, [...DECISION_ALIASES]), record)
    }
  ];
  let implementationInputId: string | null = null;
  if (row.stage === 'code') {
    const nextInputs = declaredInput
      ? finalizeImplementationInput(parsedInputs!.rows, declaredInput.id, evidence, metadata.timestamp)
      : [...parsedInputs!.rows, createImplementationInput(parsedInputs!.rows, {
          ledgerId: row.id, decisionEvidence: evidence,
          needsImplementation: effectiveNeedsImplementation!, decidedAt: metadata.timestamp
        })];
    implementationInputId = declaredInput?.id ?? nextInputs[nextInputs.length - 1]!.id;
    mutations.push({
      kind: 'section', aliases: IMPLEMENTATION_INPUT_ALIASES,
      heading: findSectionHeading(content, [...IMPLEMENTATION_INPUT_ALIASES]),
      body: renderImplementationInputs(nextInputs)
    });
  }
  mutations.push({
    kind: 'section', aliases: ACTIVITY_ALIASES, heading: activity.heading,
    body: appendActivityEntry(activity, { time: metadata.timestamp, step: 'Human Decision', agent: 'human', note: `${row.id} decided → ${recordId}` })
  });
  const writeResult = writeTask({ taskRef: resolved.taskId, expectedState: stateOverride ? resolved.state : 'active', mutations, dryRun: request.dryRun }, {
    ...options,
    taskLocation: { repoRoot: resolved.repoRoot, taskId: resolved.taskId, taskMdPath: resolved.taskMdPath, state: resolved.state },
    metadataProvider: () => metadata
  });
  if (writeResult.status === 'failed') return failed(writeResult.error.code, writeResult.error.message, writeResult.taskId, row.id);
  return { status: writeResult.status, changed: writeResult.changed, taskId: writeResult.taskId, ledgerId: row.id, recordId, implementationInputId, operations: writeResult.operations, error: null };
}

export { applyHumanDecision };
export type { HumanDecisionRequest, HumanDecisionResult };
