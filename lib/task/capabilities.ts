import fs from 'node:fs';
import path from 'node:path';

import { parseArtifactName } from './artifact-name.ts';
import type { InvalidationDocument } from './invalidation.ts';
import { invalidationBlocks, isArtifactInvalidated, parseInvalidationDocument } from './invalidation.ts';
import { parseArtifactReceipts, receiptForOutput } from './artifact-receipts.ts';
import { parseTypedTaskFrontmatter } from './frontmatter.ts';
import { parseLedgerDocument, summarizeLedgerStage, validateLedgerRows } from './ledger.ts';
import { parseReviewSummary, resolveCanonicalVerdict } from './review-artifacts.ts';
import { parseReworkIntentDocument } from './rework-intent.ts';
import type { ReworkIntent, ReworkTarget } from './rework-intent.ts';
import { sha256File } from './artifact-receipts.ts';
import { hasOpenLifecycleExecution } from './activity-log.ts';
import { parseQualificationAudit, parseTaskQualification } from './qualification-audit.ts';
import type { QualificationAudit, TaskQualification } from './qualification-audit.ts';
import { parseLifecyclePathDecision, pathIncludes } from './lifecycle-path.ts';
import type { LifecyclePathState } from './lifecycle-path.ts';
import { parseImplementationInputs } from './implementation-inputs.ts';

const ARTIFACT_AUDIT_FAMILIES = new Set(['analysis', 'review-analysis', 'plan', 'review-plan', 'code', 'review-code']);

type LifecycleAction =
  | 'analysis' | 'review-analysis' | 'plan' | 'review-plan'
  | 'code' | 'review-code' | 'manual-validation' | 'validation-run';
type TriggerInitiator = 'human' | 'model' | 'orchestrator';
type TriggerReason = 'user-request' | 'new-requirement' | 'upstream-fact-doubt' | 'review-finding' | 'retry' | 'validation-rerun';
type ExplicitTrigger = {
  initiator: TriggerInitiator;
  requestId: string;
  requestedAction: LifecycleAction;
  reasonCode: TriggerReason;
  sourceFinding?: string;
  sourceArtifact?: string;
  sourceSha256?: string;
  implementationInput?: string;
  /** False marks the ordinary recommended workflow event; it is not an authorization fact. */
  explicitRequest?: boolean;
};
type LifecycleFacts = {
  taskState: string;
  currentStep: string;
  artifacts: Partial<Record<LifecycleAction, readonly string[]>>;
  staleArtifacts?: Partial<Record<LifecycleAction, readonly string[]>>;
  reviewedInputs?: Partial<Record<'review-analysis' | 'review-plan' | 'review-code', string>>;
  artifactHashes: Readonly<Record<string, string>>;
  reviews: Partial<Record<'review-analysis' | 'review-plan' | 'review-code', 'approved' | 'changes-requested' | 'rejected'>>;
  invalidation: InvalidationDocument;
  reworkIntents?: readonly ReworkIntent[];
  unresolvedLedger: Record<'analysis' | 'plan' | 'code', number>;
  executionBusy: boolean;
  recommendedAction?: LifecycleAction | null;
  qualificationStale?: boolean;
  qualificationStaleArtifacts?: readonly string[];
  pathState?: LifecyclePathState;
  reworkClassificationRequired?: readonly ('analysis' | 'plan' | 'code')[];
  resolvedHumanDecisions?: Partial<Record<'analysis' | 'plan' | 'code', 'review' | 'implementation'>>;
};
type CapabilityResult = {
  allowed: boolean;
  reasonCode: string;
  evidence: readonly string[];
};
type LifecycleRecommendation = {
  action: LifecycleAction | null;
  reasonCode: string;
  evidence: readonly string[];
};
type LifecycleFactsResult =
  | { ok: true; facts: LifecycleFacts }
  | { ok: false; code: 'TASK_CAPABILITY_FACTS_INVALID'; message: string };

const REASONS = new Set<TriggerReason>([
  'user-request', 'new-requirement', 'upstream-fact-doubt', 'review-finding', 'retry', 'validation-rerun'
]);

function deny(reasonCode: string, ...evidence: string[]): CapabilityResult {
  return { allowed: false, reasonCode, evidence };
}

function allow(...evidence: string[]): CapabilityResult {
  return { allowed: true, reasonCode: 'CAPABILITY_ALLOWED', evidence };
}

function hasArtifact(facts: LifecycleFacts, action: LifecycleAction): boolean {
  return (facts.artifacts[action]?.length ?? 0) > 0;
}

function effectiveReworkTarget(target: ReworkTarget, pathState: LifecyclePathState | undefined): ReworkTarget {
  if (target === 'plan' && pathState?.status === 'valid' && !pathIncludes(pathState, 'plan')) return 'analysis';
  return target;
}

function canStart(action: LifecycleAction, facts: LifecycleFacts, trigger: ExplicitTrigger): CapabilityResult {
  if (!trigger || trigger.requestedAction !== action) return deny('TRIGGER_ACTION_MISMATCH', `requested=${trigger?.requestedAction ?? 'missing'}`);
  if (!trigger.requestId || !trigger.requestId.trim()) return deny('TRIGGER_REQUEST_ID_REQUIRED');
  if (!REASONS.has(trigger.reasonCode)) return deny('TRIGGER_REASON_INVALID');
  if (trigger.sourceArtifact && !trigger.sourceSha256) return deny('SOURCE_ARTIFACT_HASH_REQUIRED');
  if (trigger.sourceSha256 && !trigger.sourceArtifact) return deny('SOURCE_ARTIFACT_REQUIRED');
  if (trigger.sourceArtifact && trigger.sourceSha256) {
    const actual = facts.artifactHashes[trigger.sourceArtifact];
    if (!actual) return deny('SOURCE_ARTIFACT_MISSING', trigger.sourceArtifact);
    if (actual !== trigger.sourceSha256) return deny('SOURCE_ARTIFACT_HASH_MISMATCH', trigger.sourceArtifact);
  }
  if (facts.taskState !== 'active') return deny('TASK_NOT_ACTIVE', `state=${facts.taskState}`);
  if (invalidationBlocks(facts.invalidation)) return deny('INVALIDATION_INCOMPLETE');
  if (facts.qualificationStale && facts.recommendedAction !== action) {
    return deny('QUALIFICATION_STALE', ...(facts.qualificationStaleArtifacts ?? ['qualification audit is stale']));
  }
  if (facts.executionBusy) return deny('EXECUTION_BUSY');

  const pendingIntent = (facts.reworkIntents ?? []).find((intent) => intent.status === 'pending');
  if (pendingIntent) {
    const target = effectiveReworkTarget(pendingIntent.target, facts.pathState);
    const requirementRestart = action === 'analysis' && trigger.reasonCode === 'new-requirement';
    if (!requirementRestart && (target === 'pause' || target !== action)) {
      return deny(target === 'pause' ? 'REWORK_PAUSED' : 'REWORK_INTENT_TARGET_MISMATCH', pendingIntent.intentId);
    }
  }

  if (facts.pathState && facts.pathState.status !== 'valid') {
    return action === 'analysis'
      ? allow(`lifecycle-path-${facts.pathState.status}`)
      : deny('LIFECYCLE_PATH_INVALID', facts.pathState.message);
  }
  if (facts.pathState?.status === 'valid'
    && ['analysis', 'review-analysis', 'plan', 'review-plan', 'code', 'review-code'].includes(action)
    && !pathIncludes(facts.pathState, action as never)) {
    return deny('ARTIFACT_STAGE_NOT_SELECTED', `path=${facts.pathState.decision.path}`, `stage=${action}`);
  }
  if (facts.reworkClassificationRequired?.includes(action as 'analysis' | 'plan' | 'code')
    && !(facts.reworkIntents ?? []).some((intent) => intent.status === 'pending')) {
    return deny('REWORK_CLASSIFICATION_REQUIRED', `stage=${action}`);
  }

  const implicit = trigger.explicitRequest === false;
  if (action === 'analysis') {
    if (!implicit || hasArtifact(facts, 'analysis') || facts.recommendedAction === 'analysis') return allow('analysis-capability');
    return deny('ANALYSIS_REQUEST_REQUIRES_EXPLICIT_TRIGGER');
  }
  if (action === 'review-analysis') {
    return hasArtifact(facts, 'analysis') ? allow('analysis-artifact') : deny('ANALYSIS_ARTIFACT_REQUIRED');
  }
  if (action === 'plan') {
    if (facts.pathState?.status === 'valid' && facts.pathState.decision.path === 'standard') {
      return hasArtifact(facts, 'analysis') ? allow('analysis-artifact') : deny('ANALYSIS_ARTIFACT_REQUIRED');
    }
    if (!hasArtifact(facts, 'review-analysis')) return deny('ANALYSIS_REVIEW_REQUIRED');
    if (!reviewMatchesLatest(facts, 'analysis', 'review-analysis')) return deny('ANALYSIS_REVIEW_NOT_LATEST');
    if (facts.reviews['review-analysis'] !== 'approved') return deny('ANALYSIS_REVIEW_NOT_APPROVED');
    if (facts.unresolvedLedger.analysis > 0) return deny('ANALYSIS_LEDGER_BLOCKED', `unresolved=${facts.unresolvedLedger.analysis}`);
    return allow('analysis-review-approved');
  }
  if (action === 'review-plan') {
    return hasArtifact(facts, 'plan') ? allow('plan-artifact') : deny('PLAN_ARTIFACT_REQUIRED');
  }
  if (action === 'code') {
    if (trigger.implementationInput) {
      if (facts.resolvedHumanDecisions?.code === 'implementation') return allow('human-decision-implementation-input');
      if (!hasArtifact(facts, 'review-code')) return deny('CODE_REVIEW_REQUIRED');
      if (!reviewMatchesLatest(facts, 'code', 'review-code')) return deny('CODE_REVIEW_NOT_LATEST');
      if (facts.reviews['review-code'] !== 'approved') return deny('CODE_REVIEW_NOT_APPROVED');
      return allow('implementation-input');
    }
    if (facts.pathState?.status === 'valid' && facts.pathState.decision.path === 'streamlined') {
      if (!hasArtifact(facts, 'analysis')) return deny('ANALYSIS_ARTIFACT_REQUIRED');
      if (facts.unresolvedLedger.analysis > 0) return deny('ANALYSIS_LEDGER_BLOCKED', `unresolved=${facts.unresolvedLedger.analysis}`);
      return allow('analysis-path-approved');
    }
    if (facts.pathState?.status === 'valid' && facts.pathState.decision.path === 'standard') {
      if (!hasArtifact(facts, 'plan')) return deny('PLAN_ARTIFACT_REQUIRED');
      if (facts.unresolvedLedger.plan > 0) return deny('PLAN_LEDGER_BLOCKED', `unresolved=${facts.unresolvedLedger.plan}`);
      return allow('plan-path-approved');
    }
    if (!hasArtifact(facts, 'review-plan')) return deny('PLAN_REVIEW_REQUIRED');
    if (!reviewMatchesLatest(facts, 'plan', 'review-plan')) return deny('PLAN_REVIEW_NOT_LATEST');
    if (facts.reviews['review-plan'] !== 'approved') return deny('PLAN_REVIEW_NOT_APPROVED');
    if (facts.unresolvedLedger.plan > 0) return deny('PLAN_LEDGER_BLOCKED', `unresolved=${facts.unresolvedLedger.plan}`);
    return allow('plan-review-approved');
  }
  if (action === 'review-code') {
    return hasArtifact(facts, 'code') ? allow('code-artifact') : deny('CODE_ARTIFACT_REQUIRED');
  }
  if (action === 'manual-validation' || action === 'validation-run') {
    if (!hasArtifact(facts, 'review-code')) return deny('CODE_REVIEW_REQUIRED');
    if (!reviewMatchesLatest(facts, 'code', 'review-code')) return deny('CODE_REVIEW_NOT_LATEST');
    if (facts.reviews['review-code'] !== 'approved') return deny('CODE_REVIEW_NOT_APPROVED');
    if (facts.unresolvedLedger.code > 0) return deny('CODE_LEDGER_BLOCKED', `unresolved=${facts.unresolvedLedger.code}`);
    return allow('code-review-approved');
  }
  return deny('CAPABILITY_ACTION_UNKNOWN');
}

function latestArtifact(names: readonly string[]): string | null {
  return names.map(parseArtifactName).filter((identity) => identity !== null)
    .sort((left, right) => right.round - left.round || left.name.localeCompare(right.name))[0]?.name ?? null;
}

function reviewedInputName(content: string, expectedFamily: 'analysis' | 'plan' | 'code'): string | null {
  const header = content.split(/\r?\n/).findIndex((line) => /\*\*(?:审查输入|Review Input)\*\*[:：]/.test(line));
  if (header < 0) return null;
  const referenceBlock = content.split(/\r?\n/).slice(header, header + 12).join('\n');
  const expected = new RegExp('`' + expectedFamily + '(?:-r[2-9]|-r[1-9]\\d+)?\\.md`');
  return expected.exec(referenceBlock)?.[0].slice(1, -1) ?? null;
}

function reviewMatchesLatest(facts: LifecycleFacts, source: 'analysis' | 'plan' | 'code', review: 'review-analysis' | 'review-plan' | 'review-code'): boolean {
  const latestSource = latestArtifact(facts.artifacts[source] ?? []);
  return Boolean(latestSource && facts.reviewedInputs?.[review] === latestSource);
}

function qualificationCandidateSnapshotMatches(
  audit: QualificationAudit,
  qualification: TaskQualification
): boolean {
  const current = new Map(qualification.candidates.map((candidate) => [candidate.candidateId, candidate]));
  return audit.candidateQualifications.length === current.size && audit.candidateQualifications.every((row) => {
    const candidate = current.get(row.candidateId);
    return Boolean(candidate && candidate.status === row.status && candidate.impact === row.impact
      && candidate.evidence === row.evidence && candidate.constraintIds.join(',') === row.constraintIds.join(','));
  });
}

const QUALIFICATION_RECOVERY_ORDER: ReadonlyArray<{ action: LifecycleAction; pattern: RegExp }> = [
  { action: 'analysis', pattern: /^analysis(?:-r\d+)?\.md$/ },
  { action: 'review-analysis', pattern: /^review-analysis(?:-r\d+)?\.md$/ },
  { action: 'plan', pattern: /^plan(?:-r\d+)?\.md$/ },
  { action: 'review-plan', pattern: /^review-plan(?:-r\d+)?\.md$/ },
  { action: 'code', pattern: /^code(?:-r\d+)?\.md$/ },
  { action: 'review-code', pattern: /^review-code(?:-r\d+)?\.md$/ }
];

function qualificationRecoveryAction(facts: LifecycleFacts): LifecycleAction | null {
  const stale = facts.qualificationStaleArtifacts ?? [];
  return QUALIFICATION_RECOVERY_ORDER.find(({ pattern }) => stale.some((name) => pattern.test(name)))?.action ?? null;
}

function recommendNext(facts: LifecycleFacts): LifecycleRecommendation {
  if (facts.qualificationStale) {
    const action = qualificationRecoveryAction(facts);
    return {
      action,
      reasonCode: 'QUALIFICATION_RECOVERY_REQUIRED',
      evidence: facts.qualificationStaleArtifacts ?? ['qualification audit is stale']
    };
  }
  if ((facts.reworkClassificationRequired?.length ?? 0) > 0
    && !(facts.reworkIntents ?? []).some((intent) => intent.status === 'pending')) {
    return { action: null, reasonCode: 'REWORK_CLASSIFICATION_REQUIRED', evidence: facts.reworkClassificationRequired ?? [] };
  }
  const pendingIntent = (facts.reworkIntents ?? []).find((intent) => intent.status === 'pending');
  if (pendingIntent) {
    const target = effectiveReworkTarget(pendingIntent.target, facts.pathState);
    return { action: target === 'pause' ? null : target, reasonCode: target === 'pause' ? 'REWORK_PAUSED' : 'REWORK_INTENT_PENDING', evidence: [pendingIntent.intentId, pendingIntent.findingId] };
  }
  if (facts.pathState && facts.pathState.status !== 'valid') {
    return { action: 'analysis', reasonCode: facts.pathState.status === 'missing' ? 'LIFECYCLE_PATH_MISSING' : 'LIFECYCLE_PATH_INVALID', evidence: [facts.pathState.message] };
  }
  if (facts.pathState?.status === 'valid') {
    for (const stage of facts.pathState.decision.stages) {
      if (stage === 'analysis' && !hasArtifact(facts, stage)) return { action: stage, reasonCode: 'ANALYSIS_ARTIFACT_MISSING', evidence: ['analysis artifact is absent'] };
      if (stage === 'review-analysis' && (!reviewMatchesLatest(facts, 'analysis', stage) || facts.reviews[stage] !== 'approved')) {
        if (facts.reviews[stage] === 'changes-requested' && facts.resolvedHumanDecisions?.analysis === 'review') {
          return { action: stage, reasonCode: 'HUMAN_DECISION_REVIEW_REQUIRED', evidence: ['analysis decision was resolved'] };
        }
        return facts.reviews[stage] === 'changes-requested'
          ? { action: 'analysis', reasonCode: 'ANALYSIS_REWORK_REQUIRED', evidence: ['analysis review is not approved'] }
          : { action: stage, reasonCode: 'ANALYSIS_REVIEW_MISSING', evidence: ['analysis review does not bind the latest analysis artifact'] };
      }
      if (stage === 'plan' && !hasArtifact(facts, stage)) return { action: stage, reasonCode: 'PLAN_ARTIFACT_MISSING', evidence: ['plan artifact is absent'] };
      if (stage === 'review-plan' && (!reviewMatchesLatest(facts, 'plan', stage) || facts.reviews[stage] !== 'approved')) {
        if (facts.reviews[stage] === 'changes-requested' && facts.resolvedHumanDecisions?.plan === 'review') {
          return { action: stage, reasonCode: 'HUMAN_DECISION_REVIEW_REQUIRED', evidence: ['plan decision was resolved'] };
        }
        return facts.reviews[stage] === 'changes-requested'
          ? { action: 'plan', reasonCode: 'PLAN_REWORK_REQUIRED', evidence: ['plan review is not approved'] }
          : { action: stage, reasonCode: 'PLAN_REVIEW_MISSING', evidence: ['plan review does not bind the latest plan artifact'] };
      }
      if (stage === 'code' && !hasArtifact(facts, stage)) return { action: stage, reasonCode: 'CODE_ARTIFACT_MISSING', evidence: ['code artifact is absent'] };
      if (stage === 'review-code' && (!reviewMatchesLatest(facts, 'code', stage) || facts.reviews[stage] !== 'approved')) {
        if (facts.reviews[stage] === 'changes-requested' && facts.resolvedHumanDecisions?.code) {
          return facts.resolvedHumanDecisions.code === 'implementation'
            ? { action: 'code', reasonCode: 'HUMAN_DECISION_IMPLEMENTATION_REQUIRED', evidence: ['code decision requires implementation'] }
            : { action: stage, reasonCode: 'HUMAN_DECISION_REVIEW_REQUIRED', evidence: ['code decision requires no implementation'] };
        }
        return facts.reviews[stage] === 'changes-requested'
          ? { action: 'code', reasonCode: 'CODE_REWORK_REQUIRED', evidence: ['code review is not approved'] }
          : { action: stage, reasonCode: 'CODE_REVIEW_MISSING', evidence: ['code review does not bind the latest code artifact'] };
      }
    }
    return { action: null, reasonCode: 'LIFECYCLE_REVIEWED', evidence: ['selected lifecycle path is complete'] };
  }
  if (!hasArtifact(facts, 'analysis')) return { action: 'analysis', reasonCode: 'ANALYSIS_ARTIFACT_MISSING', evidence: ['analysis artifact is absent'] };
  if (!hasArtifact(facts, 'review-analysis') || !reviewMatchesLatest(facts, 'analysis', 'review-analysis')) {
    return { action: 'review-analysis', reasonCode: 'ANALYSIS_REVIEW_MISSING', evidence: ['analysis review does not bind the latest analysis artifact'] };
  }
  if (facts.reviews['review-analysis'] !== 'approved' || facts.unresolvedLedger.analysis > 0) {
    return { action: 'analysis', reasonCode: 'ANALYSIS_REWORK_REQUIRED', evidence: ['analysis review or ledger is not clear'] };
  }
  if (!hasArtifact(facts, 'plan')) return { action: 'plan', reasonCode: 'PLAN_ARTIFACT_MISSING', evidence: ['plan artifact is absent'] };
  if (!hasArtifact(facts, 'review-plan') || !reviewMatchesLatest(facts, 'plan', 'review-plan')) {
    return { action: 'review-plan', reasonCode: 'PLAN_REVIEW_MISSING', evidence: ['plan review does not bind the latest plan artifact'] };
  }
  if (facts.reviews['review-plan'] !== 'approved' || facts.unresolvedLedger.plan > 0) {
    return { action: 'plan', reasonCode: 'PLAN_REWORK_REQUIRED', evidence: ['plan review or ledger is not clear'] };
  }
  if (!hasArtifact(facts, 'code')) return { action: 'code', reasonCode: 'CODE_ARTIFACT_MISSING', evidence: ['code artifact is absent'] };
  if (!hasArtifact(facts, 'review-code') || !reviewMatchesLatest(facts, 'code', 'review-code')) {
    return { action: 'review-code', reasonCode: 'CODE_REVIEW_MISSING', evidence: ['code review does not bind the latest code artifact'] };
  }
  if (facts.reviews['review-code'] !== 'approved') {
    return { action: 'code', reasonCode: 'CODE_REWORK_REQUIRED', evidence: ['code review or ledger is not clear'] };
  }
  return { action: null, reasonCode: 'LIFECYCLE_REVIEWED', evidence: ['latest code review is approved'] };
}

function buildLifecycleFacts(taskDir: string, content: string, taskState = 'active', executionBusy = false): LifecycleFactsResult {
  try {
    const metadata = parseTypedTaskFrontmatter(content);
    const invalidation = parseInvalidationDocument(content);
    if (!invalidation.ok) return { ok: false, code: 'TASK_CAPABILITY_FACTS_INVALID', message: invalidation.message };
    const rework = parseReworkIntentDocument(content);
    if (!rework.ok) return { ok: false, code: 'TASK_CAPABILITY_FACTS_INVALID', message: rework.message };
    const ledger = parseLedgerDocument(content);
    if (ledger.present) {
      const invalid = validateLedgerRows(ledger.rows);
      if (invalid) return { ok: false, code: 'TASK_CAPABILITY_FACTS_INVALID', message: invalid.message };
    }
    const files = fs.readdirSync(taskDir).filter((name) => {
      if (!name.endsWith('.md')) return false;
      const stat = fs.lstatSync(path.join(taskDir, name));
      return stat.isFile() && !stat.isSymbolicLink();
    });
    const artifactFamilies = ['analysis', 'review-analysis', 'plan', 'review-plan', 'code', 'review-code'] as const;
    const familyFor = (name: string) => {
      const family = parseArtifactName(name)?.family;
      return artifactFamilies.find((candidate) => candidate === family) ?? null;
    };
    const activeFiles = files.filter((name) => {
      const family = familyFor(name);
      return !family || !isArtifactInvalidated(invalidation.document, family, name);
    });
    const allArtifactHashes: Record<string, string> = {};
    for (const name of files) allArtifactHashes[name] = sha256File(path.join(taskDir, name));
    const artifactHashes: Record<string, string> = {};
    for (const name of activeFiles) artifactHashes[name] = allArtifactHashes[name]!;
    const artifacts: Partial<Record<LifecycleAction, readonly string[]>> = Object.fromEntries(
      artifactFamilies.map((family) => [
        family, activeFiles.filter((name) => familyFor(name) === family)
      ])
    ) as Partial<Record<LifecycleAction, readonly string[]>>;
    const staleArtifacts: Partial<Record<LifecycleAction, readonly string[]>> = Object.fromEntries(
      artifactFamilies.map((family) => [
        family, files.filter((name) => familyFor(name) === family && isArtifactInvalidated(invalidation.document, family, name))
      ])
    ) as Partial<Record<LifecycleAction, readonly string[]>>;
    const qualification = parseTaskQualification(content);
    if (!qualification.ok) return { ok: false, code: 'TASK_CAPABILITY_FACTS_INVALID', message: qualification.message };
    const qualificationStaleArtifacts: string[] = [];
    if (qualification.qualification.present) {
      const constraints = new Map(qualification.qualification.constraints.map((row) => [row.constraintId, row.digest]));
      for (const family of artifactFamilies) {
        if (!ARTIFACT_AUDIT_FAMILIES.has(family)) continue;
        const name = latestArtifact(artifacts[family] ?? []);
        if (!name) continue;
        let auditContent: string;
        try { auditContent = fs.readFileSync(path.join(taskDir, name), 'utf8'); }
        catch { qualificationStaleArtifacts.push(name); continue; }
        const audit = parseQualificationAudit(auditContent);
        if (!audit.ok || !audit.audit.present || !audit.audit.snapshot) { qualificationStaleArtifacts.push(name); continue; }
        const constraintsChanged = audit.audit.constraintDependencies.some((dependency) => constraints.get(dependency.constraintId) !== dependency.constraintDigest);
        const taskInputChanged = audit.audit.snapshot.taskInputDigest !== qualification.qualification.taskInputDigest;
        if (audit.audit.snapshot.nonConstraintInputDigest !== qualification.qualification.nonConstraintInputDigest
          || constraintsChanged
          || (taskInputChanged && !constraintsChanged)
          || (taskInputChanged && !qualificationCandidateSnapshotMatches(audit.audit, qualification.qualification))) qualificationStaleArtifacts.push(name);
      }
    }
    const reviews: LifecycleFacts['reviews'] = {};
    const reviewedInputs: NonNullable<LifecycleFacts['reviewedInputs']> = {};
    for (const family of ['review-analysis', 'review-plan', 'review-code'] as const) {
      const latest = latestArtifact(artifacts[family] ?? []);
      if (!latest) continue;
      const reviewContent = fs.readFileSync(path.join(taskDir, latest), 'utf8');
      const expectedFamily = family === 'review-analysis' ? 'analysis' : family === 'review-plan' ? 'plan' : 'code';
      const input = reviewedInputName(reviewContent, expectedFamily);
      const receipt = input ? receiptForOutput(content, latest) : null;
      if (input && receipt?.input === input && artifactHashes[input] === receipt.inputSha256) reviewedInputs[family] = input;
      const parsed = parseReviewSummary(reviewContent);
      if (!parsed.ok) continue;
      const verdict = resolveCanonicalVerdict(parsed.summary);
      if (verdict.ok) reviews[family] = verdict.verdict === 'Approved' ? 'approved' : verdict.verdict === 'Changes Requested' ? 'changes-requested' : 'rejected';
    }
    const reworkClassificationRequired: Array<'analysis' | 'plan' | 'code'> = [];
    const receipts = parseArtifactReceipts(content).rows;
    for (const [reviewFamily, stage] of [['review-analysis', 'analysis'], ['review-plan', 'plan'], ['review-code', 'code']] as const) {
      const cycles = receipts.filter((receipt) => receipt.event === `${reviewFamily}.completed` && files.includes(receipt.output)
        && allArtifactHashes[receipt.input] === receipt.inputSha256).map((receipt) => {
        const parsed = parseReviewSummary(fs.readFileSync(path.join(taskDir, receipt.output), 'utf8'));
        const verdict = parsed.ok ? resolveCanonicalVerdict(parsed.summary) : null;
        return {
          input: receipt.input,
          output: receipt.output,
          outputRound: parseArtifactName(receipt.output)?.round ?? 0,
          inputRound: parseArtifactName(receipt.input)?.round ?? 0,
          verdict: verdict?.ok ? verdict.verdict : null
        };
      }).sort((left, right) => left.inputRound - right.inputRound || left.outputRound - right.outputRound || left.output.localeCompare(right.output));
      const latest = cycles.at(-1);
      const trailingInputRounds = new Set<number>();
      for (let index = cycles.length - 1; index >= 0 && cycles[index]!.verdict === 'Changes Requested'; index -= 1) {
        trailingInputRounds.add(cycles[index]!.inputRound);
      }
      const handled = latest && (rework.intents ?? []).some((intent) => intent.sourceArtifact === latest.output
        && intent.sourceSha256 === allArtifactHashes[latest.output]);
      const latestActiveReview = latestArtifact(artifacts[reviewFamily] ?? []);
      const latestActiveInput = latestArtifact(artifacts[stage] ?? []);
      const latestCycleIsActive = latest?.output === latestActiveReview && latest.input === latestActiveInput;
      if (latestCycleIsActive && latest.verdict === 'Changes Requested' && trailingInputRounds.size >= 2 && !handled) reworkClassificationRequired.push(stage);
    }
    const unresolvedLedger = { analysis: 0, plan: 0, code: 0 };
    if (ledger.present) {
      for (const stage of ['analysis', 'plan', 'code'] as const) unresolvedLedger[stage] = summarizeLedgerStage(ledger.rows, stage).unresolved.length;
    }
    const latestAnalysis = latestArtifact(artifacts.analysis ?? []);
    const pathState = latestAnalysis
      ? parseLifecyclePathDecision(fs.readFileSync(path.join(taskDir, latestAnalysis), 'utf8'), latestAnalysis, artifactHashes[latestAnalysis] ?? '')
      : { status: 'missing' as const, decision: null, message: 'analysis artifact is missing' };
    const resolvedHumanDecisions: NonNullable<LifecycleFacts['resolvedHumanDecisions']> = {};
    const implementationInputs = parseImplementationInputs(content).rows;
    for (const stage of ['analysis', 'plan', 'code'] as const) {
      const reviewFamily = `review-${stage}` as 'review-analysis' | 'review-plan' | 'review-code';
      const latestReview = latestArtifact(artifacts[reviewFamily] ?? []);
      if (!latestReview || reviews[reviewFamily] !== 'changes-requested') continue;
      const latestHash = artifactHashes[latestReview];
      const decision = rework.intents.find((intent) => intent.status === 'consumed'
        && intent.classification === 'human-decision' && intent.sourceArtifact === latestReview && intent.sourceSha256 === latestHash);
      if (!decision) continue;
      const implementationInput = implementationInputs.find((input) => input.ledgerId === decision.findingId);
      resolvedHumanDecisions[stage] = stage === 'code' && implementationInput?.status === 'pending' ? 'implementation' : 'review';
    }
    const facts: LifecycleFacts = {
      taskState, currentStep: String(metadata.current_step ?? ''), artifacts, reviews,
      staleArtifacts, reviewedInputs, artifactHashes,
      invalidation: invalidation.document, reworkIntents: rework.intents,
      unresolvedLedger,
      executionBusy: executionBusy || hasOpenLifecycleExecution(content),
      recommendedAction: null,
      qualificationStale: qualificationStaleArtifacts.length > 0,
      qualificationStaleArtifacts
      , pathState
      , reworkClassificationRequired
      , resolvedHumanDecisions
    };
    facts.recommendedAction = recommendNext(facts).action;
    return { ok: true, facts };
  } catch (error) {
    return { ok: false, code: 'TASK_CAPABILITY_FACTS_INVALID', message: error instanceof Error ? error.message : String(error) };
  }
}

export { buildLifecycleFacts, canStart, effectiveReworkTarget, recommendNext };
export type { CapabilityResult, ExplicitTrigger, LifecycleAction, LifecycleFacts, LifecycleFactsResult, LifecycleRecommendation, TriggerInitiator, TriggerReason };
