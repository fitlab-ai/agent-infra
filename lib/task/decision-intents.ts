import fs from 'node:fs';
import path from 'node:path';

import { activityWarnings, appendActivityEntry, locateActivityLog } from './activity-log.ts';
import { parseArtifactName } from './artifact-name.ts';
import { lifecycleExecutions, serializeLifecycleExecution } from './lifecycle-execution.ts';
import { isDecisionItem, listDecisionItems, selectDecisionItem } from './decision-items.ts';
import {
  createImplementationInput,
  finalizeImplementationInput,
  IMPLEMENTATION_INPUT_ALIASES,
  parseImplementationInputs,
  renderImplementationInputs,
  selectDeclaredImplementationInput
} from './implementation-inputs.ts';
import { LEDGER_COLUMNS, LEDGER_HEADINGS, LEDGER_SECTION_MISSING_CODE, LEDGER_SECTION_MISSING_MESSAGE, parseLedgerDocument } from './ledger.ts';
import type { LedgerRow } from './ledger.ts';
import { resolveTaskContext } from './resolve-ref.ts';
import { extractSection, extractSubSection, findSectionHeading } from './sections.ts';
import { captureTaskWriteMetadata, writeTask } from './write.ts';
import type { TaskMutation, TaskOperationSummary, TaskWriteOptions } from './write.ts';
import { consumeHumanDecisionReworkIntents, parseReworkIntentDocument, reworkIntentMutation } from './rework-intent.ts';

type HumanDecisionRequest = {
  taskRef?: string;
  selector: string;
  decision: string;
  needsImplementation?: boolean;
  supersede?: string;
  reviewSource?: string;
  dryRun?: boolean;
};

type HumanDecisionResult = {
  status: 'planned' | 'applied' | 'no-op' | 'failed'; changed: boolean;
  taskId: string | null; ledgerId: string | null; recordId: string | null;
  implementationInputId: string | null; operations: readonly TaskOperationSummary[];
  error: { code: string; message: string } | null;
  warnings?: readonly { code: string; message: string }[];
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
  if (!block || !block.includes(`**原账本 ID**：${row.id}`) || !block.split('\n').includes(`- **裁决结果**：${decision}`)) {
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
  if (resolved.state !== 'active') return failed('TASK_STATE_MISMATCH', `task ${resolved.taskId} is ${resolved.state}, expected active`, resolved.taskId);
  let content: string;
  let rows: LedgerRow[];
  try {
    content = fs.readFileSync(resolved.taskMdPath, 'utf8');
    const ledger = parseLedgerDocument(content);
    if (!ledger.present) return failed(LEDGER_SECTION_MISSING_CODE, LEDGER_SECTION_MISSING_MESSAGE, resolved.taskId);
    rows = ledger.rows as LedgerRow[];
  }
  catch (error) { return failed('DECISION_DOCUMENT_INVALID', error instanceof Error ? error.message : String(error), resolved.taskId); }

  const direct = rows.filter((row) => row.id.toUpperCase() === request.selector.toUpperCase());
  if (!request.supersede && !/^-?\d+$/.test(request.selector) && direct.length === 1 && direct[0]!.status === 'human-decided' && isDecisionItem(direct[0]!)) {
    try {
      const replay = existingDecision(content, direct[0]!, request.decision.trim(), request.needsImplementation);
      if ('conflict' in replay) return failed('DECISION_CONFLICT', replay.conflict, resolved.taskId, direct[0]!.id);
      return { status: 'no-op', changed: false, taskId: resolved.taskId, ledgerId: direct[0]!.id, recordId: replay.recordId, implementationInputId: replay.implementationInputId, operations: [], error: null, warnings: activityWarnings(content) };
    } catch (error) { return failed('DECISION_DOCUMENT_INVALID', error instanceof Error ? error.message : String(error), resolved.taskId, direct[0]!.id); }
  }

  const candidates = request.supersede ? listDecisionItems(rows, { includeDecided: true }) : listDecisionItems(rows);
  const selected = selectDecisionItem(candidates, request.selector);
  if (!selected.ok) {
    const message = selected.code === 'not-found' && !/^-?\d+$/.test(request.selector)
      ? classifyMissing(rows, request.selector) : selected.message;
    return failed('DECISION_TARGET_INVALID', message, resolved.taskId);
  }
  const row = selected.row;
  if (request.supersede && row.status === 'human-decided' && row.evidence !== `task.md#${request.supersede}`) {
    try {
      const current = extractSubSection(content, row.evidence.split('#')[1] ?? '');
      if (current.includes(`**替代裁决**：task.md#${request.supersede}`)) {
        if (request.reviewSource && !current.includes(`**审查来源**：${request.reviewSource}`)) return failed('DECISION_CONFLICT', 'replacement review source conflicts with prior ruling', resolved.taskId, row.id);
        const replay = existingDecision(content, row, request.decision.trim(), request.needsImplementation);
        if ('conflict' in replay) return failed('DECISION_CONFLICT', replay.conflict, resolved.taskId, row.id);
        return { status: 'no-op', changed: false, taskId: resolved.taskId, ledgerId: row.id, ...replay, operations: [], error: null, warnings: activityWarnings(content) };
      }
    } catch (error) { return failed('DECISION_DOCUMENT_INVALID', error instanceof Error ? error.message : String(error), resolved.taskId, row.id); }
  }
  if (request.supersede && (row.status !== 'human-decided' || row.evidence !== `task.md#${request.supersede}`)) {
    return failed('DECISION_CONFLICT', 'replacement does not match the current ruling', resolved.taskId, row.id);
  }
  if (!request.supersede && request.reviewSource) return failed('DECISION_PAYLOAD_INVALID', 'review source requires replacement', resolved.taskId, row.id);
  const previous = request.supersede ? extractSubSection(content, request.supersede) : '';
  const recordedSource = /^- \*\*审查来源\*\*：(.+)$/mu.exec(previous)?.[1];
  const source = row.status === 'human-decided' ? recordedSource ?? request.reviewSource : row.evidence;
  if (request.supersede && request.reviewSource && recordedSource && request.reviewSource !== recordedSource) return failed('DECISION_CONFLICT', 'replacement review source conflicts with prior ruling', resolved.taskId, row.id);
  const isFinding = /^(AN|PL|CD)-[1-9]\d*$/.test(row.id);
  if (request.supersede && isFinding && (!source || parseArtifactName(source.split('#')[0]!)?.family !== `review-${row.stage}` || !source.split('#')[1])) return failed('DECISION_PAYLOAD_INVALID', 'replacement requires its original review source', resolved.taskId, row.id);
  if (request.supersede && isFinding && !recordedSource && source !== `${source?.split('#')[0]}#${row.id}`) return failed('DECISION_PAYLOAD_INVALID', 'historical review source must identify the original finding', resolved.taskId, row.id);
  if (request.supersede && isFinding && !recordedSource) {
    try {
      const [artifact] = source!.split('#');
      const review = fs.readFileSync(path.join(resolved.taskDir, artifact!), 'utf8');
      if (!new RegExp(`(?:^|\\n)###?\\s+${row.id}(?:[：: .]|\\s)`, 'u').test(review)) throw new Error('review finding anchor is missing');
    } catch (error) { return failed('DECISION_CONFLICT', error instanceof Error ? error.message : String(error), resolved.taskId, row.id); }
  }
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
  const record = `### ${recordId}\n\n- **原账本 ID**：${row.id}${source ? `\n- **审查来源**：${source}` : ''}${request.supersede ? `\n- **替代裁决**：task.md#${request.supersede}` : ''}\n- **裁决时间**：${metadata.timestamp}\n- **裁决结果**：${decision}`;
  const activity = locateActivityLog(content);
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
    let nextInputs = declaredInput
      ? finalizeImplementationInput(parsedInputs!.rows, declaredInput.id, evidence, metadata.timestamp)
      : [...parsedInputs!.rows, createImplementationInput(parsedInputs!.rows, {
          ledgerId: row.id, decisionEvidence: evidence,
          needsImplementation: effectiveNeedsImplementation!, decidedAt: metadata.timestamp
        })];
    if (request.supersede) {
      const oldInputs = parsedInputs!.rows.filter((item) => item.ledgerId === row.id && item.decisionEvidence === row.evidence);
      if (oldInputs.length !== 1) return failed('DECISION_CONFLICT', 'prior implementation input identity is ambiguous', resolved.taskId, row.id);
      const old = oldInputs[0]!;
      nextInputs = nextInputs.map((item) => item.id === old.id && (item.status === 'pending' || item.status === 'not-required') ? { ...item, status: 'superseded' as const } : item);
      const open = lifecycleExecutions(content, resolved.taskDir);
      const matches = open.filter((item) => item.family === 'code' && item.implementationInput === old.id);
      if (matches.length > 1) return failed('DECISION_CONFLICT', 'prior open execution identity is ambiguous', resolved.taskId, row.id);
      if (matches.length === 1) mutations.push({ kind: 'frontmatter', lifecycleExecutionDomain: 'ordinary', set: { lifecycle_execution: serializeLifecycleExecution(open.filter((item) => item !== matches[0]), content) } });
    }
    implementationInputId = declaredInput?.id ?? nextInputs[nextInputs.length - 1]!.id;
    mutations.push({
      kind: 'section', aliases: IMPLEMENTATION_INPUT_ALIASES,
      heading: findSectionHeading(content, [...IMPLEMENTATION_INPUT_ALIASES]),
      body: renderImplementationInputs(nextInputs)
    });
  }
  if (activity) mutations.push({
    kind: 'section', aliases: ACTIVITY_ALIASES, heading: activity.heading,
    body: appendActivityEntry(activity, { time: metadata.timestamp, step: 'Human Decision', agent: 'human', note: `${row.id} decided → ${recordId}` })
  });
  try {
    const parsedRework = parseReworkIntentDocument(content);
    if (!parsedRework.ok) return failed('DECISION_DOCUMENT_INVALID', parsedRework.message, resolved.taskId, row.id);
    const consumed = consumeHumanDecisionReworkIntents(parsedRework.intents, row.id, metadata.timestamp);
    if (consumed.changed) mutations.push(reworkIntentMutation(content, consumed.intents));
  } catch (error) {
    return failed('DECISION_DOCUMENT_INVALID', error instanceof Error ? error.message : String(error), resolved.taskId, row.id);
  }
  const writeResult = writeTask({ taskRef: resolved.taskId, expectedState: 'active', mutations, dryRun: request.dryRun }, {
    ...options,
    taskLocation: { repoRoot: resolved.repoRoot, taskId: resolved.taskId, taskMdPath: resolved.taskMdPath, state: resolved.state },
    metadataProvider: () => metadata
  });
  if (writeResult.status === 'failed') return failed(writeResult.error.code, writeResult.error.message, writeResult.taskId, row.id);
  return { status: writeResult.status, changed: writeResult.changed, taskId: writeResult.taskId, ledgerId: row.id, recordId, implementationInputId, operations: writeResult.operations, error: null, warnings: activityWarnings(content) };
}

export { applyHumanDecision };
export type { HumanDecisionRequest, HumanDecisionResult };
