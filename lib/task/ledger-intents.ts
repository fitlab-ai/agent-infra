import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import {
  declareImplementationInput,
  IMPLEMENTATION_INPUT_ALIASES,
  parseImplementationInputs,
  renderImplementationInputs
} from './implementation-inputs.ts';
import { parseArtifactName } from './artifact-name.ts';
import { LEDGER_COLUMNS, LEDGER_HEADINGS, LEDGER_SECTION_MISSING_CODE, LEDGER_SECTION_MISSING_MESSAGE, nextHdId, parseLedgerDocument, validateLedgerRows } from './ledger.ts';
import type { LedgerRow, ReviewStage } from './ledger.ts';
import { resolveTaskRef } from './resolve-ref.ts';
import { writeTask } from './write.ts';
import type { TaskMutation, TaskOperationSummary, TaskWriteOptions } from './write.ts';
import { allowsManualOverride } from './guard-override.ts';
import { parseLegacyReworkIntentDocument, parseReworkIntentDocument, reworkIntentMutation, upsertReworkIntent } from './rework-intent.ts';
import type { ReworkClassification, ReworkIntent, ReworkTarget } from './rework-intent.ts';
import { extractSection, extractSubSection } from './sections.ts';
import { parseLifecyclePathDecision } from './lifecycle-path.ts';
import { scanVisibleMarkdown } from './markdown.ts';

type ReviewSeverity = 'blocker' | 'major' | 'minor';
type ExecutorResponse = 'accepted' | 'adjusted' | 'refuted' | 'cannot-judge';
type ReviewDisposition = 'confirmed' | 'closed' | 'open' | 'needs-human-decision';
type LedgerIntent =
  | { kind: 'finding-upsert'; taskRef: string; stage: ReviewStage; reviewArtifact: string; ordinal: number; severity: ReviewSeverity; evidence: string; dryRun?: boolean }
  | { kind: 'finding-respond'; taskRef: string; id: string; round: number; status: ExecutorResponse; evidence: string; dryRun?: boolean }
  | { kind: 'finding-review'; taskRef: string; id: string; status: ReviewDisposition; evidence: string; needsImplementation?: boolean; dryRun?: boolean }
  | { kind: 'decision-next-id'; taskRef: string }
  | { kind: 'decision-upsert'; taskRef: string; id: string; stage: ReviewStage; artifact: string; needsImplementation?: boolean; dryRun?: boolean }
  | { kind: 'rework-intent-upsert'; taskRef: string; intentId: string; findingId: string; sourceArtifact: string; sourceSha256: string; classification: ReworkClassification; dryRun?: boolean }
  | { kind: 'rework-intent-rebuild'; taskRef: string; findingId?: string; sourceArtifact?: string; sourceSha256?: string; classification?: ReworkClassification; dryRun?: boolean };

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
  rebuild?: Readonly<{ mode: 'format-only' | 'pending-reclassification'; beforeSha256: string; afterSha256: string; converted: number; newIntentId: string | null }>;
  error: LedgerIntentError | null;
};

const PREFIX: Record<ReviewStage, string> = { analysis: 'AN', plan: 'PL', code: 'CD' };
const RESPONSE = new Set<ExecutorResponse>(['accepted', 'adjusted', 'refuted', 'cannot-judge']);
const DISPOSITION = new Set<ReviewDisposition>(['confirmed', 'closed', 'open', 'needs-human-decision']);

function failed(intent: LedgerIntent, code: string, message: string, taskId: string | null = null, entityId: string | null = null): LedgerIntentResult {
  return { status: 'failed', changed: false, intent: intent.kind, taskId, entityId, before: null, after: null, operations: [], error: { code, message } };
}

function normalizedEvidence(value: string): string {
  return value.trim();
}

function ledgerReadErrorCode(error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  if (code === LEDGER_SECTION_MISSING_CODE) return code;
  return code === 'TABLE_DUPLICATE_KEY' ? 'LEDGER_DUPLICATE_ID' : 'LEDGER_DOCUMENT_INVALID';
}

const CLASSIFICATION_TARGET: Record<ReworkClassification, ReworkTarget> = {
  'scope-or-requirement': 'analysis', design: 'plan', implementation: 'code',
  'human-decision': 'pause', 'insufficient-evidence': 'pause'
};

function semanticDigest(value: string): string {
  return createHash('sha256').update(value.normalize('NFKC').replace(/\s+/g, ' ').trim()).digest('hex');
}

function normalizedTaskFact(value: string): string {
  return value.normalize('NFKC').replace(/\s+/g, ' ').trim();
}

function semanticFindingEvidence(reviewContent: string, heading: ReturnType<typeof scanVisibleMarkdown>['headings'][number], end: number): string {
  const title = heading.text.replace(/^\d+[.、：:]\s*/, '').trim();
  return `${title}\n${reviewContent.slice(heading.end, end)}`;
}

function findingEvidence(reviewContent: string, evidence: string): string | null {
  const anchor = evidence.split('#')[1];
  if (!anchor) return null;
  const markdown = scanVisibleMarkdown(reviewContent);
  const explicit = markdown.anchors.find((candidate) => candidate.id === anchor);
  if (explicit) {
    const heading = markdown.headings.find((candidate) => candidate.start > explicit.start);
    const next = heading && markdown.headings.find((candidate) => candidate.start > heading.start && candidate.level <= heading.level);
    const end = next?.start ?? reviewContent.length;
    return heading ? semanticFindingEvidence(reviewContent, heading, end) : reviewContent.slice(explicit.end, end);
  }
  const heading = markdown.headings.find((candidate) => {
    const escapedAnchor = anchor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return candidate.text === anchor || new RegExp(`^${escapedAnchor}(?:\\s|[.、：:])`).test(candidate.text);
  });
  if (!heading) return null;
  const next = markdown.headings.find((candidate) => candidate.start > heading.start && candidate.level <= heading.level);
  return semanticFindingEvidence(reviewContent, heading, next?.start ?? reviewContent.length);
}

function taskFactDigest(taskDir: string, content: string): string {
  const analysisNames = fs.readdirSync(taskDir).filter((name) => /^analysis(?:-r\d+)?\.md$/.test(name));
  const latest = analysisNames.map((name) => ({ name, round: parseArtifactName(name)?.round ?? 0 })).sort((a, b) => b.round - a.round)[0];
  const flow = latest ? parseLifecyclePathDecision(fs.readFileSync(path.join(taskDir, latest.name), 'utf8')) : null;
  return semanticDigest(JSON.stringify({
    taskInput: normalizedTaskFact(extractSection(content, ['任务输入', 'Task Input'])),
    requirements: normalizedTaskFact(extractSection(content, ['需求', 'Requirements'])),
    flow: flow?.status === 'valid' ? flow.decision.semanticDigest : flow?.status ?? 'missing'
  }));
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

function rowMutation(row: LedgerRow): TaskMutation {
  return {
    kind: 'table-row', action: 'upsert', sectionAliases: LEDGER_HEADINGS,
    columns: LEDGER_COLUMNS, keyColumn: 'id', key: row.id,
    values: { stage: row.stage, round: row.round, severity: row.severity, status: row.status, evidence: row.evidence }
  };
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
    const ledger = parseLedgerDocument(content);
    if (!ledger.present) return failed(intent, LEDGER_SECTION_MISSING_CODE, LEDGER_SECTION_MISSING_MESSAGE, resolved.taskId);
    rows = ledger.rows as LedgerRow[];
  } catch (error) {
    return failed(intent, ledgerReadErrorCode(error), error instanceof Error ? error.message : String(error), resolved.taskId);
  }
  const invalidRows = validateLedgerRows(rows);
  if (invalidRows) return failed(intent, invalidRows.code, invalidRows.message, resolved.taskId);

  if (intent.kind === 'decision-next-id') {
    return { status: 'no-op', changed: false, intent: intent.kind, taskId: resolved.taskId, entityId: nextHdId(rows), before: null, after: null, operations: [], error: null };
  }

  if (intent.kind === 'rework-intent-upsert') {
    if (!/^RI-[1-9]\d*$/.test(intent.intentId) || !/^(AN|PL|CD)-[1-9]\d*$/.test(intent.findingId) || !(intent.classification in CLASSIFICATION_TARGET) || !/^[a-f0-9]{64}$/.test(intent.sourceSha256)) {
      return failed(intent, 'LEDGER_PAYLOAD_INVALID', 'rework intent identity, classification, or source hash is invalid', resolved.taskId, intent.intentId);
    }
    const finding = rows.find((row) => row.id === intent.findingId);
    if (!finding || finding.severity === 'decision') return failed(intent, 'LEDGER_NOT_FOUND', `finding '${intent.findingId}' was not found`, resolved.taskId, intent.findingId);
    if (intent.classification === 'human-decision' && finding.status !== 'needs-human-decision') {
      return failed(intent, 'LEDGER_TRANSITION_INVALID', 'human-decision classification requires a needs-human-decision finding', resolved.taskId, intent.findingId);
    }
    const sourceFromEvidence = finding.evidence.split('#')[0];
    if (sourceFromEvidence !== intent.sourceArtifact || parseArtifactName(intent.sourceArtifact)?.family !== `review-${finding.stage}`) {
      return failed(intent, 'LEDGER_IDENTITY_CONFLICT', 'rework intent source artifact does not match finding evidence', resolved.taskId, intent.intentId);
    }
    try {
      const actualHash = createHash('sha256').update(fs.readFileSync(path.join(resolved.taskDir, intent.sourceArtifact))).digest('hex');
      if (actualHash !== intent.sourceSha256) return failed(intent, 'LEDGER_IDENTITY_CONFLICT', 'rework intent source artifact hash does not match', resolved.taskId, intent.intentId);
      const parsed = parseReworkIntentDocument(content);
      if (!parsed.ok) return failed(intent, parsed.code, parsed.message, resolved.taskId, intent.intentId);
      const reviewContent = fs.readFileSync(path.join(resolved.taskDir, intent.sourceArtifact), 'utf8');
      const evidenceBlock = findingEvidence(reviewContent, finding.evidence);
      if (!evidenceBlock) return failed(intent, 'LEDGER_EVIDENCE_INVALID', `finding evidence anchor '${finding.evidence}' was not found`, resolved.taskId, intent.intentId);
      const evidenceDigest = semanticDigest(evidenceBlock);
      const factsDigest = taskFactDigest(resolved.taskDir, content);
      const requestedIntent: ReworkIntent = {
        intentId: intent.intentId, findingId: intent.findingId, sourceArtifact: intent.sourceArtifact,
        sourceSha256: intent.sourceSha256, target: CLASSIFICATION_TARGET[intent.classification], classification: intent.classification,
        evidenceDigest, taskFactDigest: factsDigest, status: 'pending',
        declaredAt: new Date().toISOString(), consumedAt: ''
      };
      if (parsed.intents.some((candidate) => candidate.intentId === intent.intentId)) {
        const replay = upsertReworkIntent(parsed.intents, requestedIntent);
        if (!replay.changed) {
          return { status: 'no-op', changed: false, intent: intent.kind, taskId: resolved.taskId, entityId: intent.intentId, before: null, after: null, operations: [], error: null };
        }
      }
      const same = parsed.intents.find((candidate) => candidate.findingId === intent.findingId
        && candidate.evidenceDigest === evidenceDigest && candidate.taskFactDigest === factsDigest
        && candidate.classification === intent.classification && candidate.target === CLASSIFICATION_TARGET[intent.classification]);
      const classification: ReworkClassification = same ? 'insufficient-evidence' : intent.classification;
      const nextIntent: ReworkIntent = {
        ...requestedIntent, target: CLASSIFICATION_TARGET[classification], classification
      };
      const now = nextIntent.declaredAt;
      const superseded = parsed.intents.map((candidate) => candidate.status === 'pending'
        ? { ...candidate, status: 'superseded' as const, consumedAt: now } : candidate);
      const next = upsertReworkIntent(superseded, nextIntent);
      if (!next.changed) return { status: 'no-op', changed: false, intent: intent.kind, taskId: resolved.taskId, entityId: intent.intentId, before: null, after: null, operations: [], error: null };
      const result = writeTask({ taskRef: intent.taskRef, expectedState: 'active', dryRun: intent.dryRun, mutations: [reworkIntentMutation(content, next.intents)] }, { ...options, taskLocation: { repoRoot: resolved.repoRoot, taskId: resolved.taskId, taskMdPath: resolved.taskMdPath, state: resolved.state } });
      if (result.status === 'failed') return failed(intent, result.error.code, result.error.message, result.taskId, intent.intentId);
      return { status: result.status, changed: result.changed, intent: intent.kind, taskId: result.taskId, entityId: intent.intentId, before: null, after: null, operations: result.operations, error: null };
    } catch (error) {
      return failed(intent, 'LEDGER_IDENTITY_CONFLICT', error instanceof Error ? error.message : String(error), resolved.taskId, intent.intentId);
    }
  }

  if (intent.kind === 'rework-intent-rebuild') {
    const beforeSha256 = createHash('sha256').update(content).digest('hex');
    const supplied = [intent.findingId, intent.sourceArtifact, intent.sourceSha256, intent.classification].filter((value) => value !== undefined).length;
    if (supplied !== 0 && supplied !== 4) return failed(intent, 'LEDGER_PAYLOAD_INVALID', 'rebuild binding options must be provided together', resolved.taskId);
    const current = parseReworkIntentDocument(content);
    if (current.ok && current.present) {
      if (supplied !== 0) return failed(intent, 'LEDGER_PAYLOAD_INVALID', 'current rework intent format does not accept rebuild binding options', resolved.taskId);
      return {
        status: 'no-op', changed: false, intent: intent.kind, taskId: resolved.taskId, entityId: null,
        before: null, after: null, operations: [], error: null,
        rebuild: { mode: 'format-only', beforeSha256, afterSha256: beforeSha256, converted: current.intents.length, newIntentId: null }
      };
    }
    const legacy = parseLegacyReworkIntentDocument(content);
    if (!legacy.ok) return failed(intent, legacy.code, legacy.message, resolved.taskId);
    const pending = legacy.intents.filter((row) => row.status === 'pending');
    if (pending.length === 0 && supplied !== 0) return failed(intent, 'LEDGER_PAYLOAD_INVALID', 'format-only rebuild does not accept finding or classification options', resolved.taskId);
    if (pending.length > 0 && supplied !== 4) return failed(intent, 'LEDGER_PAYLOAD_INVALID', 'legacy pending intents require finding, review, hash, and classification', resolved.taskId);
    const now = new Date().toISOString();
    let next = legacy.intents.map((row) => row.status === 'pending' ? { ...row, status: 'superseded' as const, consumedAt: now } : row);
    let entityId: string | null = null;
    if (pending.length > 0) {
      const finding = rows.find((row) => row.id === intent.findingId);
      if (!finding || finding.severity === 'decision' || finding.evidence.split('#')[0] !== intent.sourceArtifact) return failed(intent, 'LEDGER_IDENTITY_CONFLICT', 'rebuild binding does not match a review finding', resolved.taskId);
      if (intent.classification === 'human-decision' && finding.status !== 'needs-human-decision') {
        return failed(intent, 'LEDGER_TRANSITION_INVALID', 'human-decision classification requires a needs-human-decision finding', resolved.taskId);
      }
      const sourceIdentity = parseArtifactName(intent.sourceArtifact!);
      const expectedFamily = `review-${finding.stage}`;
      const latestSource = fs.readdirSync(resolved.taskDir)
        .map((name) => parseArtifactName(name))
        .filter((identity) => identity?.family === expectedFamily)
        .sort((left, right) => right!.round - left!.round || left!.name.localeCompare(right!.name))[0];
      if (!sourceIdentity || sourceIdentity.family !== expectedFamily || latestSource?.name !== sourceIdentity.name) {
        return failed(intent, 'LEDGER_IDENTITY_CONFLICT', 'rebuild source artifact is not the latest review for the finding stage', resolved.taskId);
      }
      const sourcePath = path.join(resolved.taskDir, intent.sourceArtifact!);
      const actualHash = createHash('sha256').update(fs.readFileSync(sourcePath)).digest('hex');
      if (actualHash !== intent.sourceSha256) return failed(intent, 'LEDGER_IDENTITY_CONFLICT', 'rebuild source artifact hash does not match', resolved.taskId);
      const max = next.reduce((value, row) => Math.max(value, Number(row.intentId.slice(3))), 0);
      entityId = `RI-${max + 1}`;
      const reviewContent = fs.readFileSync(sourcePath, 'utf8');
      const classification = intent.classification!;
      if (!(classification in CLASSIFICATION_TARGET)) return failed(intent, 'LEDGER_PAYLOAD_INVALID', 'rebuild classification is invalid', resolved.taskId);
      const evidenceBlock = findingEvidence(reviewContent, finding.evidence);
      if (!evidenceBlock) return failed(intent, 'LEDGER_EVIDENCE_INVALID', `finding evidence anchor '${finding.evidence}' was not found`, resolved.taskId);
      next = [...next, {
        intentId: entityId, findingId: intent.findingId!, sourceArtifact: intent.sourceArtifact!, sourceSha256: intent.sourceSha256!,
        target: CLASSIFICATION_TARGET[classification], classification,
        evidenceDigest: semanticDigest(evidenceBlock),
        taskFactDigest: taskFactDigest(resolved.taskDir, content), status: 'pending', declaredAt: now, consumedAt: ''
      }];
    }
    const result = writeTask({ taskRef: intent.taskRef, expectedState: 'active', dryRun: intent.dryRun, mutations: [reworkIntentMutation(content, next)] }, { ...options, taskLocation: { repoRoot: resolved.repoRoot, taskId: resolved.taskId, taskMdPath: resolved.taskMdPath, state: resolved.state } });
    if (result.status === 'failed') return failed(intent, result.error.code, result.error.message, result.taskId, entityId);
    const afterContent = result.status === 'applied' || result.status === 'no-op' ? fs.readFileSync(resolved.taskMdPath, 'utf8') : content;
    return {
      status: result.status, changed: result.changed, intent: intent.kind, taskId: result.taskId, entityId,
      before: null, after: null, operations: result.operations, error: null,
      rebuild: {
        mode: pending.length > 0 ? 'pending-reclassification' : 'format-only',
        beforeSha256,
        afterSha256: createHash('sha256').update(afterContent).digest('hex'),
        converted: legacy.intents.length,
        newIntentId: entityId
      }
    };
  }

  let before: LedgerRow | null = null;
  let after: LedgerRow;
  if (intent.kind === 'finding-upsert') {
    const identity = parseArtifactName(intent.reviewArtifact);
    if (identity?.family !== `review-${intent.stage}` || !Number.isInteger(intent.ordinal) || intent.ordinal < 1 || !['blocker', 'major', 'minor'].includes(intent.severity)) {
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
        id, stage: intent.stage, round: String(identity.round),
        severity: intent.severity, status: 'open', evidence, sourceLine: -1
      };
    }
  } else if (intent.kind === 'decision-upsert') {
    if (!/^HD-[1-9]\d*$/.test(intent.id) || !['analysis', 'plan', 'code'].includes(intent.stage) || parseArtifactName(intent.artifact)?.family !== intent.stage) {
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
        if ((!sameRoundMinorClose && !allowed.has(intent.status))
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
    mutations: [rowMutation(after), ...(implementationMutation ? [implementationMutation] : [])],
    dryRun: 'dryRun' in intent ? intent.dryRun : false
  }, { ...options, taskLocation: { repoRoot: resolved.repoRoot, taskId: resolved.taskId, taskMdPath: resolved.taskMdPath, state: resolved.state } });
  return mapWrite(intent, after.id, before, after, result);
}

export { applyLedgerIntent };
export type { LedgerIntent, LedgerIntentResult, LedgerIntentError, ReviewSeverity, ExecutorResponse, ReviewDisposition };
