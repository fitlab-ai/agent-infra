import fs from 'node:fs';
import path from 'node:path';

import type { InvalidationDocument } from './invalidation.ts';
import { invalidationBlocks, isArtifactInvalidated, parseInvalidationDocument } from './invalidation.ts';
import { receiptForOutput } from './artifact-receipts.ts';
import { parseTypedTaskFrontmatter } from './frontmatter.ts';
import { parseLedgerDocument, summarizeLedgerStage, validateLedgerRows } from './ledger.ts';
import { parseReviewSummary, resolveCanonicalVerdict } from './review-artifacts.ts';
import { parseReworkIntentDocument } from './rework-intent.ts';
import type { ReworkIntent } from './rework-intent.ts';
import { sha256File } from './artifact-receipts.ts';
import { hasOpenLifecycleExecution } from './activity-log.ts';

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
  if (facts.executionBusy) return deny('EXECUTION_BUSY');

  const implicit = trigger.explicitRequest === false;
  if (action === 'analysis') {
    if (!implicit || hasArtifact(facts, 'analysis') || facts.recommendedAction === 'analysis') return allow('analysis-capability');
    return deny('ANALYSIS_REQUEST_REQUIRES_EXPLICIT_TRIGGER');
  }
  if (action === 'review-analysis') {
    return hasArtifact(facts, 'analysis') ? allow('analysis-artifact') : deny('ANALYSIS_ARTIFACT_REQUIRED');
  }
  if (action === 'plan') {
    if (!hasArtifact(facts, 'review-analysis')) return deny('ANALYSIS_REVIEW_REQUIRED');
    if (facts.reviews['review-analysis'] !== 'approved') return deny('ANALYSIS_REVIEW_NOT_APPROVED');
    if (facts.unresolvedLedger.analysis > 0) return deny('ANALYSIS_LEDGER_BLOCKED', `unresolved=${facts.unresolvedLedger.analysis}`);
    return allow('analysis-review-approved');
  }
  if (action === 'review-plan') {
    return hasArtifact(facts, 'plan') ? allow('plan-artifact') : deny('PLAN_ARTIFACT_REQUIRED');
  }
  if (action === 'code') {
    if (trigger.implementationInput) {
      if (!hasArtifact(facts, 'review-code')) return deny('CODE_REVIEW_REQUIRED');
      if (facts.reviews['review-code'] !== 'approved') return deny('CODE_REVIEW_NOT_APPROVED');
      return allow('implementation-input');
    }
    if (!hasArtifact(facts, 'review-plan')) return deny('PLAN_REVIEW_REQUIRED');
    if (facts.reviews['review-plan'] !== 'approved') return deny('PLAN_REVIEW_NOT_APPROVED');
    if (facts.unresolvedLedger.plan > 0) return deny('PLAN_LEDGER_BLOCKED', `unresolved=${facts.unresolvedLedger.plan}`);
    return allow('plan-review-approved');
  }
  if (action === 'review-code') {
    return hasArtifact(facts, 'code') ? allow('code-artifact') : deny('CODE_ARTIFACT_REQUIRED');
  }
  if (action === 'manual-validation' || action === 'validation-run') {
    if (!hasArtifact(facts, 'review-code')) return deny('CODE_REVIEW_REQUIRED');
    if (facts.reviews['review-code'] !== 'approved') return deny('CODE_REVIEW_NOT_APPROVED');
    if (facts.unresolvedLedger.code > 0) return deny('CODE_LEDGER_BLOCKED', `unresolved=${facts.unresolvedLedger.code}`);
    return allow('code-review-approved');
  }
  return deny('CAPABILITY_ACTION_UNKNOWN');
}

function artifactRound(name: string): number {
  const match = /-r(\d+)\.md$/.exec(name);
  return match ? Number(match[1]) : 1;
}

function latestArtifact(names: readonly string[]): string | null {
  return [...names].sort((left, right) => artifactRound(right) - artifactRound(left) || left.localeCompare(right))[0] ?? null;
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

function recommendNext(facts: LifecycleFacts): LifecycleRecommendation {
  if (invalidationBlocks(facts.invalidation)) return { action: null, reasonCode: 'INVALIDATION_INCOMPLETE', evidence: ['reconcile task invalidation before routing'] };
  const pendingIntent = (facts.reworkIntents ?? []).find((intent) => intent.status === 'pending');
  if (pendingIntent) return { action: pendingIntent.target, reasonCode: 'REWORK_INTENT_PENDING', evidence: [pendingIntent.intentId, pendingIntent.findingId] };
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
    const artifactFamilies = {
      analysis: /^analysis(?:-r\d+)?\.md$/,
      'review-analysis': /^review-analysis(?:-r\d+)?\.md$/,
      plan: /^plan(?:-r\d+)?\.md$/,
      'review-plan': /^review-plan(?:-r\d+)?\.md$/,
      code: /^code(?:-r\d+)?\.md$/,
      'review-code': /^review-code(?:-r\d+)?\.md$/
    } as const;
    const familyFor = (name: string): keyof typeof artifactFamilies | null =>
      (Object.keys(artifactFamilies) as Array<keyof typeof artifactFamilies>)
        .find((family) => artifactFamilies[family].test(name)) ?? null;
    const activeFiles = files.filter((name) => {
      const family = familyFor(name);
      return !family || !isArtifactInvalidated(invalidation.document, family, name);
    });
    const artifactHashes: Record<string, string> = {};
    for (const name of activeFiles) artifactHashes[name] = sha256File(path.join(taskDir, name));
    const artifacts: Partial<Record<LifecycleAction, readonly string[]>> = Object.fromEntries(
      (Object.keys(artifactFamilies) as Array<keyof typeof artifactFamilies>).map((family) => [
        family, activeFiles.filter((name) => artifactFamilies[family].test(name))
      ])
    ) as Partial<Record<LifecycleAction, readonly string[]>>;
    const staleArtifacts: Partial<Record<LifecycleAction, readonly string[]>> = Object.fromEntries(
      (Object.keys(artifactFamilies) as Array<keyof typeof artifactFamilies>).map((family) => [
        family, files.filter((name) => artifactFamilies[family].test(name) && isArtifactInvalidated(invalidation.document, family, name))
      ])
    ) as Partial<Record<LifecycleAction, readonly string[]>>;
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
    const unresolvedLedger = { analysis: 0, plan: 0, code: 0 };
    if (ledger.present) {
      for (const stage of ['analysis', 'plan', 'code'] as const) unresolvedLedger[stage] = summarizeLedgerStage(ledger.rows, stage).unresolved.length;
    }
    const facts: LifecycleFacts = {
      taskState, currentStep: String(metadata.current_step ?? ''), artifacts, reviews,
      staleArtifacts, reviewedInputs, artifactHashes,
      invalidation: invalidation.document, reworkIntents: rework.intents,
      unresolvedLedger, executionBusy: executionBusy || hasOpenLifecycleExecution(content), recommendedAction: null
    };
    facts.recommendedAction = recommendNext(facts).action;
    return { ok: true, facts };
  } catch (error) {
    return { ok: false, code: 'TASK_CAPABILITY_FACTS_INVALID', message: error instanceof Error ? error.message : String(error) };
  }
}

export { buildLifecycleFacts, canStart, recommendNext };
export type { CapabilityResult, ExplicitTrigger, LifecycleAction, LifecycleFacts, LifecycleFactsResult, LifecycleRecommendation, TriggerInitiator, TriggerReason };
