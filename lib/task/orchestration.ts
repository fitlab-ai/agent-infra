import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';

import { parseTypedTaskFrontmatter } from './frontmatter.ts';
import { parseReviewSummary } from './review-artifacts.ts';
import { inspectArtifactDirectory } from './artifact-lifecycle.ts';
import { parseLedger, summarizeLedgerStage, validateLedgerRows } from './ledger.ts';
import { resolveTaskRef } from './resolve-ref.ts';
import {
  activateDelegation,
  completeDelegationStage,
  consumeDelegation,
  managedDelegationRole,
  prepareDelegation,
  sealDelegation
} from './delegation-receipts.ts';
import type { DelegationReceipt, DelegationRole, DelegationStage } from './delegation-receipts.ts';
import { normalizeAgentClients } from '../agent-clients/config.ts';
import { inspectPlatformPullRequest } from '../platform/pull-requests.ts';
import {
  getAgentClientCapability,
  getAgentClientDelegationEvidence,
  getAgentClientModelSelection
} from '../agent-clients/registry.ts';
import { isAgentClientId } from '../agent-clients/types.ts';
import type {
  AgentClientId,
  OrchestrationModelPolicy,
  OrchestrationRolePolicy
} from '../agent-clients/types.ts';
import {
  captureRepositorySnapshot,
  captureWorkspaceSnapshot,
  diffWorkspaceSnapshots
} from './workspace-snapshot.ts';
import type { RepositorySnapshot } from './workspace-snapshot.ts';
import { TaskExecutionLockError, withTaskExecutionLock } from './task-execution-lock.ts';
import {
  CommitIntentError,
  commitIntentPath,
  createCommitIntent,
  digest,
  readCommitIntent,
  removeCommitIntent,
  serialize,
  updateCommitIntent
} from './commit-intent.ts';
import type { CommitIntent, PushEvidence } from './commit-intent.ts';

type OrchestrationStatus = 'running' | 'paused' | 'completed';
type LegacyOrchestrationModelPolicy = Readonly<{
  executor: string;
  reviewer: string;
}>;
type ModelPolicySource = Readonly<{
  kind: 'explicit' | 'project-config';
  client: AgentClientId;
  resolvedAt: string;
}>;
type OrchestrationRecovery = Readonly<{
  code: 'MODEL_POLICY_SUPPLEMENTED';
  recoveredAt: string;
  previousSchemaVersion: 1;
  previousStatus: OrchestrationStatus;
  previousPause: Readonly<{ code: string; message: string; recoverable: boolean }> | null;
  policySource: ModelPolicySource;
  receiptCount: 0;
  pendingDelegation: false;
  resultingStatus: OrchestrationStatus;
}>;
type CleanCompletionEvidence = Readonly<{
  kind: 'reviewed-head-clean';
  observedAt: string;
  head: string;
  headTree: string;
  worktreeTree: string;
  lastReviewedCommit: string;
  prNumber: number;
  prHead: string;
}>;
type OrchestrationRun = Readonly<{
  schemaVersion: 1 | 2;
  taskId: string;
  runId: string;
  status: OrchestrationStatus;
  nextStage: DelegationStage | null;
  stepCount: number;
  maxSteps: number;
  modelPolicy?: OrchestrationModelPolicy | LegacyOrchestrationModelPolicy;
  modelPolicySource?: ModelPolicySource;
  recoveryHistory?: readonly OrchestrationRecovery[];
  baseline: string;
  pendingDelegation: DelegationReceipt | null;
  receipts: readonly DelegationReceipt[];
  pause: Readonly<{ code: string; message: string; recoverable: boolean }> | null;
  commitAuthorization: Readonly<{ issuedAt: string | null; consumedAt: string | null }>;
  completionEvidence?: CleanCompletionEvidence | null;
  createdAt: string;
  updatedAt: string;
}>;
type OrchestrationNext = Readonly<{
  action: 'analyze-task' | 'review-analysis' | 'plan-task' | 'review-plan' | 'code-task' | 'review-code' | 'commit';
  role: DelegationRole;
  stage: DelegationStage;
  round: number;
  artifact: string;
  requestedModel: string | null;
  requestedReasoningEffort: string | null;
}>;
type OrchestrationResult = Readonly<{
  status: OrchestrationStatus | 'failed';
  changed: boolean;
  taskId: string | null;
  run: OrchestrationRun | null;
  next: OrchestrationNext | null;
  error: Readonly<{
    code: string;
    message: string;
    client?: AgentClientId;
    missingFields?: readonly string[];
    modelSelectionContext?: ReturnType<typeof getAgentClientModelSelection>;
  }> | null;
}>;
type OrchestrationStageIdentity = Readonly<{
  stage: DelegationStage;
  round: number;
  artifact: string;
  role: DelegationRole;
}>;
type OrchestrationStageCompletion = Readonly<{
  taskId: string;
  taskDir: string;
  updatedRun: OrchestrationRun;
}>;
type OrchestrationCompletionPlanResult = Readonly<{
  result: OrchestrationResult;
  plan: OrchestrationStageCompletion | null;
}>;
type OrchestrationOptions = {
  repoRoot?: string;
  id?: () => string;
  now?: () => string;
  maxSteps?: number;
  client?: AgentClientId;
  modelPolicy?: OrchestrationModelPolicy;
  captureWorkspace?: (repoRoot: string, taskId: string | null) => string;
  captureRepository?: (repoRoot: string) => RepositorySnapshot;
  inspectPullRequest?: (taskId: string, options: { cwd: string }) => Readonly<{
    status: string;
    task?: Readonly<{ prNumber?: number | null }>;
    prNumber?: number | null;
    pullRequest?: Readonly<{ head?: Readonly<{ sha?: string }> }> | null;
    error?: Readonly<{ message?: string }> | null;
  }>;
  diffWorkspace?: (repoRoot: string, before: string, after: string) => string[];
  supportsLifecycleDelegation?: (client: AgentClientId) => boolean;
  token?: () => string;
};

type CommitIntentResult = Readonly<{
  status: 'ready' | 'failed';
  changed: boolean;
  taskId: string | null;
  intent: Readonly<{
    mode: CommitIntent['mode'];
    phase: CommitIntent['phase'];
    baselineHead: string;
    currentHead: string;
    committedHead: string | null;
    pushEvidence: PushEvidence | null;
    runId: string | null;
    receiptId: string | null;
  }> | null;
  token?: string;
  error: Readonly<{ code: string; message: string }> | null;
}>;

function supportsLifecycleDelegation(client: AgentClientId): boolean {
  return getAgentClientCapability(client, 'subagents').level !== 'unsupported'
    && getAgentClientCapability(client, 'orchestration').level !== 'unsupported'
    && getAgentClientDelegationEvidence(client).actualModel !== 'unavailable'
    && getAgentClientDelegationEvidence(client).actualReasoningEffort !== 'unavailable';
}

function orchestrationPath(taskDir: string): string {
  return path.join(taskDir, 'orchestration.json');
}

function readRun(taskDir: string): OrchestrationRun | null {
  const file = orchestrationPath(taskDir);
  if (!fs.existsSync(file)) return null;
  const run = JSON.parse(fs.readFileSync(file, 'utf8')) as OrchestrationRun;
  if (run.schemaVersion !== 2 || !isV2Policy(run.modelPolicy)) return run;
  return {
    ...run,
    modelPolicy: {
      executor: {
        model: run.modelPolicy.executor.model,
        reasoningEffort: run.modelPolicy.executor.reasoningEffort
      },
      reviewer: {
        model: run.modelPolicy.reviewer.model,
        reasoningEffort: run.modelPolicy.reviewer.reasoningEffort
      }
    }
  };
}

function atomicWrite(file: string, value: unknown): void {
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  fs.renameSync(temp, file);
}

function saveRun(taskDir: string, run: OrchestrationRun): void {
  atomicWrite(orchestrationPath(taskDir), run);
}

function withUpdatedRun(run: OrchestrationRun, updates: Partial<OrchestrationRun>, now?: () => string): OrchestrationRun {
  return Object.freeze({ ...run, ...updates, updatedAt: (now ?? (() => new Date().toISOString()))() });
}

function failed(
  code: string,
  message: string,
  taskId: string | null = null,
  details: Omit<NonNullable<OrchestrationResult['error']>, 'code' | 'message'> = {}
): OrchestrationResult {
  return { status: 'failed', changed: false, taskId, run: null, next: null, error: { code, message, ...details } };
}

function commitIntentFailed(code: string, message: string, taskId: string | null = null): CommitIntentResult {
  return { status: 'failed', changed: false, taskId, intent: null, error: { code, message } };
}

function repositoryHead(repoRoot: string): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim();
}

function isAncestor(repoRoot: string, ancestor: string, descendant: string): boolean {
  return spawnSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], {
    cwd: repoRoot,
    stdio: 'ignore'
  }).status === 0;
}

function commitIntentView(intent: CommitIntent, currentHead: string): NonNullable<CommitIntentResult['intent']> {
  return {
    mode: intent.mode,
    phase: intent.phase,
    baselineHead: intent.baselineHead,
    currentHead,
    committedHead: intent.committedHead,
    pushEvidence: intent.pushEvidence,
    runId: intent.orchestration?.runId ?? null,
    receiptId: intent.orchestration?.receiptId ?? null
  };
}

function validCommitRun(run: OrchestrationRun | null, taskId: string): run is OrchestrationRun {
  return run !== null
    && [1, 2].includes(run.schemaVersion)
    && run.taskId === taskId
    && ['running', 'paused', 'completed'].includes(run.status)
    && Array.isArray(run.receipts)
    && Object.prototype.hasOwnProperty.call(run, 'pendingDelegation')
    && typeof run.commitAuthorization === 'object'
    && run.commitAuthorization !== null
    && Object.prototype.hasOwnProperty.call(run.commitAuthorization, 'issuedAt')
    && Object.prototype.hasOwnProperty.call(run.commitAuthorization, 'consumedAt');
}

function mapCommitIntentError(error: unknown, taskId: string | null): CommitIntentResult {
  if (error instanceof CommitIntentError) return commitIntentFailed(error.code, error.message, taskId);
  if (error instanceof TaskExecutionLockError) return commitIntentFailed(error.code, error.message, taskId);
  return commitIntentFailed(
    'ORCHESTRATION_COMMIT_INTENT_INVALID',
    error instanceof Error ? error.message : String(error),
    taskId
  );
}

function validModel(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim() === value;
}

function validateModelPolicy(policy: OrchestrationModelPolicy | undefined): Readonly<{ code: string; message: string }> | null {
  if (
    !policy
    || !validModel(policy.executor?.model)
    || !validModel(policy.executor?.reasoningEffort)
    || !validModel(policy.reviewer?.model)
    || !validModel(policy.reviewer?.reasoningEffort)
  ) {
    return { code: 'ORCHESTRATION_MODEL_POLICY_REQUIRED', message: 'executor and reviewer model and reasoning effort are required' };
  }
  return null;
}

function sameModelPolicy(left: OrchestrationModelPolicy, right: OrchestrationModelPolicy): boolean {
  return left.executor.model === right.executor.model
    && left.executor.reasoningEffort === right.executor.reasoningEffort
    && left.reviewer.model === right.reviewer.model
    && left.reviewer.reasoningEffort === right.reviewer.reasoningEffort;
}

function isV2Policy(policy: OrchestrationRun['modelPolicy']): policy is OrchestrationModelPolicy {
  return typeof policy?.executor === 'object' && typeof policy?.reviewer === 'object';
}

function rolePolicy(run: OrchestrationRun, role: DelegationRole): OrchestrationRolePolicy | null {
  return isV2Policy(run.modelPolicy) ? run.modelPolicy[role] : null;
}

function resolveProjectPolicy(repoRoot: string, client: AgentClientId): OrchestrationModelPolicy | undefined {
  const configPath = path.join(repoRoot, '.agents', '.airc.json');
  if (!fs.existsSync(configPath)) return undefined;
  const raw = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>;
  return normalizeAgentClients(raw).state[client].orchestration;
}

function beginOrResumeOrchestration(taskRef: string, options: OrchestrationOptions = {}): OrchestrationResult {
  const resolved = resolveTaskRef(taskRef, { repoRoot: options.repoRoot });
  if (!resolved.ok) return failed(resolved.code, resolved.message, resolved.taskId);
  if (!isAgentClientId(options.client)) {
    return failed('ORCHESTRATION_PAYLOAD_INVALID', 'begin-or-resume requires a known client', resolved.taskId);
  }
  let existing: OrchestrationRun | null;
  try {
    existing = readRun(resolved.taskDir);
  } catch (error) {
    return failed('ORCHESTRATION_STATE_INVALID', error instanceof Error ? error.message : String(error), resolved.taskId);
  }
  if (existing) {
    if (
      ![1, 2].includes(existing.schemaVersion)
      || !Array.isArray(existing.receipts)
      || !Object.prototype.hasOwnProperty.call(existing, 'pendingDelegation')
    ) {
      return failed('ORCHESTRATION_STATE_INVALID', 'orchestration state has an invalid schema', resolved.taskId);
    }
    if (existing.status === 'completed' && existing.schemaVersion === 1) {
      return { status: 'completed', changed: false, taskId: resolved.taskId, run: existing, next: null, error: null };
    }
    if (existing.schemaVersion === 2) {
      const policyError = validateModelPolicy(isV2Policy(existing.modelPolicy) ? existing.modelPolicy : undefined);
      if (
        policyError
        || !existing.modelPolicySource
        || !isAgentClientId(existing.modelPolicySource.client)
        || !Array.isArray(existing.recoveryHistory)
      ) {
        return failed('ORCHESTRATION_STATE_INVALID', 'schemaVersion 2 orchestration state is incomplete', resolved.taskId);
      }
      if (existing.status === 'completed') {
        return { status: 'completed', changed: false, taskId: resolved.taskId, run: existing, next: null, error: null };
      }
      if (existing.modelPolicySource.client !== options.client) {
        return failed('ORCHESTRATION_CLIENT_MISMATCH', 'provided client does not match the persisted run policy source', resolved.taskId);
      }
      if (options.modelPolicy) {
        const suppliedError = validateModelPolicy(options.modelPolicy);
        if (suppliedError) return failed(suppliedError.code, suppliedError.message, resolved.taskId);
        if (!sameModelPolicy(existing.modelPolicy as OrchestrationModelPolicy, options.modelPolicy)) {
          return failed('ORCHESTRATION_MODEL_POLICY_MISMATCH', 'provided model policy does not match the persisted run policy', resolved.taskId);
        }
      }
      if (existing.status === 'paused' && existing.pause?.recoverable && existing.pendingDelegation === null) {
        const resumed = withUpdatedRun(existing, { status: 'running', pause: null });
        saveRun(resolved.taskDir, resumed);
        return { status: 'running', changed: true, taskId: resolved.taskId, run: resumed, next: null, error: null };
      }
      return { status: existing.status, changed: false, taskId: resolved.taskId, run: existing, next: null, error: null };
    }

    let policy: OrchestrationModelPolicy | undefined = options.modelPolicy;
    let sourceKind: ModelPolicySource['kind'] = 'explicit';
    if (!policy) {
      try {
        policy = resolveProjectPolicy(resolved.repoRoot, options.client);
        sourceKind = 'project-config';
      } catch (error) {
        return failed('ORCHESTRATION_CONFIG_INVALID', error instanceof Error ? error.message : String(error), resolved.taskId);
      }
    }
    const policyError = validateModelPolicy(policy);
    if (policyError) {
      return failed(policyError.code, policyError.message, resolved.taskId, {
        client: options.client,
        missingFields: ['executor.model', 'executor.reasoningEffort', 'reviewer.model', 'reviewer.reasoningEffort'],
        modelSelectionContext: getAgentClientModelSelection(options.client)
      });
    }
    if (existing.pendingDelegation !== null) {
      const alreadyPaused = existing.status === 'paused' && existing.pause?.code === 'ORCHESTRATION_DELEGATION_BUSY';
      if (alreadyPaused) return { status: 'paused', changed: false, taskId: resolved.taskId, run: existing, next: null, error: null };
      const paused = withUpdatedRun(existing, {
        status: 'paused',
        pause: { code: 'ORCHESTRATION_DELEGATION_BUSY', message: 'legacy run has a pending delegation', recoverable: false }
      });
      saveRun(resolved.taskDir, paused);
      return { status: 'paused', changed: true, taskId: resolved.taskId, run: paused, next: null, error: null };
    }
    if (existing.receipts.length > 0) {
      const alreadyPaused = existing.status === 'paused' && existing.pause?.code === 'ORCHESTRATION_HISTORICAL_EFFORT_UNVERIFIED';
      if (alreadyPaused) return { status: 'paused', changed: false, taskId: resolved.taskId, run: existing, next: null, error: null };
      const paused = withUpdatedRun(existing, {
        status: 'paused',
        pause: {
          code: 'ORCHESTRATION_HISTORICAL_EFFORT_UNVERIFIED',
          message: 'legacy receipts do not contain actual reasoning-effort evidence',
          recoverable: false
        }
      });
      saveRun(resolved.taskDir, paused);
      return { status: 'paused', changed: true, taskId: resolved.taskId, run: paused, next: null, error: null };
    }
    if (
      existing.modelPolicy
      && typeof existing.modelPolicy.executor === 'string'
      && (
        existing.modelPolicy.executor !== policy!.executor.model
        || existing.modelPolicy.reviewer !== policy!.reviewer.model
      )
    ) {
        return failed('ORCHESTRATION_MODEL_POLICY_MISMATCH', 'provided model policy does not match the persisted run policy', resolved.taskId);
    }
    const now = (options.now ?? (() => new Date().toISOString()))();
    const source: ModelPolicySource = { kind: sourceKind, client: options.client, resolvedAt: now };
    const clearsModelPause = existing.pause?.code === 'ORCHESTRATION_MODEL_EVIDENCE_MISSING';
    const resultingStatus = clearsModelPause ? 'running' : existing.status;
    const recovery: OrchestrationRecovery = {
      code: 'MODEL_POLICY_SUPPLEMENTED',
      recoveredAt: now,
      previousSchemaVersion: 1,
      previousStatus: existing.status,
      previousPause: existing.pause,
      policySource: source,
      receiptCount: 0,
      pendingDelegation: false,
      resultingStatus
    };
    const recovered: OrchestrationRun = Object.freeze({
      ...existing,
      schemaVersion: 2,
      status: resultingStatus,
      modelPolicy: policy!,
      modelPolicySource: source,
      recoveryHistory: Object.freeze([recovery]),
      pause: clearsModelPause ? null : existing.pause,
      updatedAt: now
    });
    saveRun(resolved.taskDir, recovered);
    return { status: resultingStatus, changed: true, taskId: resolved.taskId, run: recovered, next: null, error: null };
  }

  let policy = options.modelPolicy;
  let sourceKind: ModelPolicySource['kind'] = 'explicit';
  if (!policy) {
    try {
      policy = resolveProjectPolicy(resolved.repoRoot, options.client);
      sourceKind = 'project-config';
    } catch (error) {
      return failed('ORCHESTRATION_CONFIG_INVALID', error instanceof Error ? error.message : String(error), resolved.taskId);
    }
  }
  const policyError = validateModelPolicy(policy);
  if (policyError) return failed(policyError.code, policyError.message, resolved.taskId, {
    client: options.client,
    missingFields: ['executor.model', 'executor.reasoningEffort', 'reviewer.model', 'reviewer.reasoningEffort'],
    modelSelectionContext: getAgentClientModelSelection(options.client)
  });
  const now = (options.now ?? (() => new Date().toISOString()))();
  const source: ModelPolicySource = { kind: sourceKind, client: options.client, resolvedAt: now };
  const run: OrchestrationRun = {
    schemaVersion: 2,
    taskId: resolved.taskId,
    runId: (options.id ?? randomUUID)(),
    status: 'running',
    nextStage: null,
    stepCount: 0,
    maxSteps: options.maxSteps ?? 24,
    modelPolicy: policy!,
    modelPolicySource: source,
    recoveryHistory: [],
    baseline: '',
    pendingDelegation: null,
    receipts: [],
    pause: null,
    commitAuthorization: { issuedAt: null, consumedAt: null },
    completionEvidence: null,
    createdAt: now,
    updatedAt: now
  };
  atomicWrite(orchestrationPath(resolved.taskDir), run);
  return { status: 'running', changed: true, taskId: resolved.taskId, run, next: null, error: null };
}

function highestRound(taskDir: string, family: string): number {
  const pattern = new RegExp(`^${family}(?:-r(\\d+))?\\.md$`);
  return fs.readdirSync(taskDir).reduce((max, name) => {
    const match = pattern.exec(name);
    return match ? Math.max(max, match[1] ? Number(match[1]) : 1) : max;
  }, 0);
}

function artifactName(family: string, round: number): string {
  return round === 1 ? `${family}.md` : `${family}-r${round}.md`;
}

function hasReviewAfterArtifact(taskDir: string, family: string, reviewFamily: string): boolean {
  const artifact = inspectArtifactDirectory(taskDir, family as 'analysis' | 'plan' | 'code');
  const review = inspectArtifactDirectory(taskDir, reviewFamily as 'review-analysis' | 'review-plan' | 'review-code');
  return artifact.status === 'ready'
    && review.status === 'ready'
    && artifact.latest !== null
    && review.reviewedInput?.name === artifact.latest.name;
}

function latestReviewApproved(taskDir: string, family: 'review-analysis' | 'review-plan' | 'review-code'): boolean {
  const round = highestRound(taskDir, family);
  if (round === 0) return false;
  const parsed = parseReviewSummary(fs.readFileSync(path.join(taskDir, artifactName(family, round)), 'utf8'));
  return parsed.ok && parsed.summary.verdict === 'Approved' && parsed.summary.counts !== null;
}

function routeFromFacts(taskDir: string): Omit<OrchestrationNext, 'requestedModel' | 'requestedReasoningEffort'> | null {
  const analysisRound = highestRound(taskDir, 'analysis');
  const analysisReviewRound = highestRound(taskDir, 'review-analysis');
  const planRound = highestRound(taskDir, 'plan');
  const planReviewRound = highestRound(taskDir, 'review-plan');
  const codeRound = highestRound(taskDir, 'code');
  const codeReviewRound = highestRound(taskDir, 'review-code');
  if (analysisRound === 0) {
    const round = analysisRound + 1;
    return { action: 'analyze-task', role: 'executor', stage: 'analysis', round, artifact: artifactName('analysis', round) };
  }
  if (!hasReviewAfterArtifact(taskDir, 'analysis', 'review-analysis')) {
    const round = analysisReviewRound + 1;
    return { action: 'review-analysis', role: 'reviewer', stage: 'review-analysis', round, artifact: artifactName('review-analysis', round) };
  }
  if (!latestReviewApproved(taskDir, 'review-analysis')) {
    const round = analysisRound + 1;
    return { action: 'analyze-task', role: 'executor', stage: 'analysis', round, artifact: artifactName('analysis', round) };
  }
  if (planRound === 0) {
    const round = planRound + 1;
    return { action: 'plan-task', role: 'executor', stage: 'plan', round, artifact: artifactName('plan', round) };
  }
  if (!hasReviewAfterArtifact(taskDir, 'plan', 'review-plan')) {
    const round = planReviewRound + 1;
    return { action: 'review-plan', role: 'reviewer', stage: 'review-plan', round, artifact: artifactName('review-plan', round) };
  }
  if (!latestReviewApproved(taskDir, 'review-plan')) {
    const round = planRound + 1;
    return { action: 'plan-task', role: 'executor', stage: 'plan', round, artifact: artifactName('plan', round) };
  }
  if (codeRound === 0) {
    const round = codeRound + 1;
    return { action: 'code-task', role: 'executor', stage: 'code', round, artifact: artifactName('code', round) };
  }
  if (!hasReviewAfterArtifact(taskDir, 'code', 'review-code')) {
    const round = codeReviewRound + 1;
    return { action: 'review-code', role: 'reviewer', stage: 'review-code', round, artifact: artifactName('review-code', round) };
  }
  if (!latestReviewApproved(taskDir, 'review-code')) {
    const round = codeRound + 1;
    return { action: 'code-task', role: 'executor', stage: 'code', round, artifact: artifactName('code', round) };
  }
  return { action: 'commit', role: 'executor', stage: 'commit', round: 1, artifact: 'commit' };
}

function routeOrchestration(taskRef: string, options: OrchestrationOptions = {}): OrchestrationResult {
  const resolved = resolveTaskRef(taskRef, { repoRoot: options.repoRoot });
  if (!resolved.ok) return failed(resolved.code, resolved.message, resolved.taskId);
  let content: string;
  try {
    content = fs.readFileSync(resolved.taskMdPath, 'utf8');
  } catch (error) {
    return failed('ORCHESTRATION_TASK_READ_FAILED', String(error), resolved.taskId);
  }
  let metadata: ReturnType<typeof parseTypedTaskFrontmatter>;
  try {
    metadata = parseTypedTaskFrontmatter(content);
  } catch (error) {
    return failed('ORCHESTRATION_TASK_INVALID', error instanceof Error ? error.message : String(error), resolved.taskId);
  }
  const routed = routeFromFacts(resolved.taskDir);
  if (!routed) return failed('ORCHESTRATION_ROUTE_UNKNOWN', 'cannot determine a unique lifecycle action', resolved.taskId);
  const run = readRun(resolved.taskDir);
  const policy = run ? rolePolicy(run, routed.role) : null;
  const next: OrchestrationNext = {
    ...routed,
    requestedModel: policy?.model ?? null,
    requestedReasoningEffort: policy?.reasoningEffort ?? null
  };
  if (next.stage === 'commit') {
    const reviewRound = highestRound(resolved.taskDir, 'review-code');
    const review = parseReviewSummary(fs.readFileSync(
      path.join(resolved.taskDir, artifactName('review-code', reviewRound)),
      'utf8'
    ));
    if (!review.ok || review.summary.manualValidation === null) {
      return failed('ORCHESTRATION_REVIEW_INVALID', 'latest code review has no numeric manual-validation count', resolved.taskId);
    }
    const rows = parseLedger(content);
    const ledgerError = validateLedgerRows(rows);
    if (ledgerError) return failed('ORCHESTRATION_LEDGER_INVALID', ledgerError.message, resolved.taskId);
    if (!summarizeLedgerStage(rows, 'code').canAdvance) {
      return failed('ORCHESTRATION_LEDGER_BLOCKED', 'code review ledger has unresolved findings or human decisions', resolved.taskId);
    }
    if (run?.status === 'completed') {
      return { status: 'completed', changed: false, taskId: resolved.taskId, run, next: null, error: null };
    }

    let config: unknown;
    try {
      config = JSON.parse(fs.readFileSync(path.join(resolved.repoRoot, '.agents', '.airc.json'), 'utf8'));
    } catch (error) {
      return failed('ORCHESTRATION_CONFIG_INVALID', error instanceof Error ? error.message : String(error), resolved.taskId);
    }
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      return failed('ORCHESTRATION_CONFIG_INVALID', 'project configuration must be an object', resolved.taskId);
    }
    const projectConfig = config as Record<string, unknown>;
    if (!Object.hasOwn(projectConfig, 'prFlow') || projectConfig.prFlow === 'disabled') {
      return { status: 'running', changed: false, taskId: resolved.taskId, run, next, error: null };
    }
    if (projectConfig.prFlow !== 'required') {
      return failed('ORCHESTRATION_CONFIG_INVALID', "project configuration 'prFlow' must be 'required' or 'disabled'", resolved.taskId);
    }
    const prNumber = Number(metadata.pr_number);
    if (!Number.isInteger(prNumber) || prNumber <= 0) {
      return { status: 'running', changed: false, taskId: resolved.taskId, run, next, error: null };
    }
    if (!run) {
      return { status: 'running', changed: false, taskId: resolved.taskId, run, next, error: null };
    }
    if (run.status !== 'running' || run.pendingDelegation !== null) {
      return failed('ORCHESTRATION_RUN_NOT_RUNNING', 'clean completion requires an idle running orchestration', resolved.taskId);
    }

    const capture = options.captureRepository ?? captureRepositorySnapshot;
    let before: RepositorySnapshot;
    try {
      before = capture(resolved.repoRoot);
    } catch (error) {
      return failed('ORCHESTRATION_SNAPSHOT_FAILED', error instanceof Error ? error.message : String(error), resolved.taskId);
    }
    if (before.headTree !== before.worktreeTree) {
      return { status: 'running', changed: false, taskId: resolved.taskId, run, next, error: null };
    }
    const lastReviewedCommit = String(metadata.last_reviewed_commit ?? '');
    if (before.head !== lastReviewedCommit) {
      return failed('ORCHESTRATION_REVIEWED_HEAD_MISMATCH', 'local HEAD does not match last_reviewed_commit', resolved.taskId);
    }

    const inspect: NonNullable<OrchestrationOptions['inspectPullRequest']> =
      options.inspectPullRequest ?? inspectPlatformPullRequest;
    let inspection: ReturnType<NonNullable<OrchestrationOptions['inspectPullRequest']>>;
    try {
      inspection = inspect(resolved.taskId, { cwd: resolved.repoRoot });
    } catch (error) {
      return failed('ORCHESTRATION_PR_INSPECTION_FAILED', error instanceof Error ? error.message : String(error), resolved.taskId);
    }
    if (inspection.status === 'blocked') {
      return failed('ORCHESTRATION_PR_INSPECTION_BLOCKED', inspection.error?.message ?? 'pull request inspection is blocked', resolved.taskId);
    }
    if (inspection.status === 'failed') {
      return failed('ORCHESTRATION_PR_INSPECTION_FAILED', inspection.error?.message ?? 'pull request inspection failed', resolved.taskId);
    }
    const inspectedPrNumber = inspection.task?.prNumber ?? inspection.prNumber;
    const prHead = inspection.pullRequest?.head?.sha;
    if (typeof prHead !== 'string') {
      return failed('ORCHESTRATION_PR_INSPECTION_INVALID', 'pull request inspection returned incomplete identity evidence', resolved.taskId);
    }
    if (inspectedPrNumber !== prNumber || prHead !== before.head) {
      return failed('ORCHESTRATION_PR_HEAD_MISMATCH', 'pull request identity does not match the reviewed local HEAD', resolved.taskId);
    }

    let after: RepositorySnapshot;
    try {
      after = capture(resolved.repoRoot);
    } catch (error) {
      return failed('ORCHESTRATION_SNAPSHOT_FAILED', error instanceof Error ? error.message : String(error), resolved.taskId);
    }
    if (after.headTree !== after.worktreeTree) {
      return { status: 'running', changed: false, taskId: resolved.taskId, run, next, error: null };
    }
    if (after.head !== before.head || after.headTree !== before.headTree) {
      return failed('ORCHESTRATION_REPOSITORY_CHANGED', 'repository changed while clean completion evidence was collected', resolved.taskId);
    }

    const observedAt = (options.now ?? (() => new Date().toISOString()))();
    const completionEvidence: CleanCompletionEvidence = {
      kind: 'reviewed-head-clean',
      observedAt,
      head: after.head,
      headTree: after.headTree,
      worktreeTree: after.worktreeTree,
      lastReviewedCommit,
      prNumber,
      prHead
    };
    const completed = withUpdatedRun(run, {
      status: 'completed',
      nextStage: null,
      pause: null,
      completionEvidence
    });
    saveRun(resolved.taskDir, completed);
    return { status: 'completed', changed: true, taskId: resolved.taskId, run: completed, next: null, error: null };
  }
  return { status: 'running', changed: false, taskId: resolved.taskId, run, next, error: null };
}

function beginCommitIntent(
  taskRef: string,
  input: Readonly<{ agent: string; orchestrated: boolean; baselineHead: string }>,
  options: OrchestrationOptions = {}
): CommitIntentResult {
  const resolved = resolveTaskRef(taskRef, { repoRoot: options.repoRoot });
  if (!resolved.ok) return commitIntentFailed(resolved.code, resolved.message, resolved.taskId);
  try {
    return withTaskExecutionLock(resolved.repoRoot, resolved.taskId, 'commit-intent.begin', () => {
      const currentHead = repositoryHead(resolved.repoRoot);
      if (currentHead !== input.baselineHead) {
        return commitIntentFailed('ORCHESTRATION_COMMIT_BASELINE_MISMATCH', 'baseline HEAD does not match the repository HEAD', resolved.taskId);
      }
      if (fs.existsSync(commitIntentPath(resolved.taskDir))) {
        try {
          readCommitIntent(resolved.taskDir, resolved.taskId);
        } catch (error) {
          return mapCommitIntentError(error, resolved.taskId);
        }
        return commitIntentFailed('ORCHESTRATION_COMMIT_INTENT_BUSY', 'an active commit intent already exists', resolved.taskId);
      }

      const runFile = orchestrationPath(resolved.taskDir);
      let run: OrchestrationRun | null = null;
      let sourceRunBytes: string | null = null;
      if (fs.existsSync(runFile)) {
        sourceRunBytes = fs.readFileSync(runFile, 'utf8');
        try {
          run = readRun(resolved.taskDir);
        } catch (error) {
          return commitIntentFailed('ORCHESTRATION_STATE_INVALID', error instanceof Error ? error.message : String(error), resolved.taskId);
        }
        if (!validCommitRun(run, resolved.taskId)) {
          return commitIntentFailed('ORCHESTRATION_STATE_INVALID', 'orchestration state has an invalid schema', resolved.taskId);
        }
      }

      const now = (options.now ?? (() => new Date().toISOString()))();
      const failAndPause = (code: string, message: string): CommitIntentResult => {
        if (run?.status === 'running') {
          saveRun(resolved.taskDir, withUpdatedRun(run, {
            status: 'paused', pause: { code, message, recoverable: true }
          }, () => now));
        }
        return commitIntentFailed(code, message, resolved.taskId);
      };
      let orchestration: CommitIntent['orchestration'] = null;
      if (!input.orchestrated) {
        if (run?.pendingDelegation) {
          return commitIntentFailed(
            'ORCHESTRATION_STANDALONE_BUSY',
            'standalone commit is blocked by a pending orchestration delegation',
            resolved.taskId
          );
        }
      } else {
        if (!run || run.status !== 'running') {
          return commitIntentFailed('ORCHESTRATION_RUN_NOT_RUNNING', 'orchestrated commit requires a running orchestration', resolved.taskId);
        }
        const receipt = run.pendingDelegation;
        if (
          !receipt
          || receipt.status !== 'activated'
          || receipt.stage !== 'commit'
          || receipt.round !== 1
          || receipt.artifact !== 'commit'
          || receipt.role !== 'executor'
        ) {
          return failAndPause(
            'ORCHESTRATION_PROVENANCE_MISMATCH',
            'orchestrated commit requires one matching activated commit delegation'
          );
        }
        if (!run.commitAuthorization.issuedAt || run.commitAuthorization.consumedAt) {
          return failAndPause(
            'ORCHESTRATION_COMMIT_AUTHORIZATION_INVALID',
            'orchestrated commit requires an unconsumed one-use authorization'
          );
        }
        const planned = planOrchestrationStageCompletion(taskRef, {
          stage: 'commit', round: 1, artifact: 'commit', role: 'executor', agent: input.agent
        }, { ...options, now: () => now });
        if (planned.result.status === 'failed' || !planned.plan?.updatedRun.pendingDelegation) {
          return failAndPause(
            planned.result.error?.code ?? 'ORCHESTRATION_PROVENANCE_MISMATCH',
            planned.result.error?.message ?? 'commit delegation could not be completed'
          );
        }
        const plannedRunBytes = serialize(planned.plan.updatedRun);
        orchestration = {
          runId: run.runId,
          receiptId: receipt.id,
          authorizationIssuedAt: run.commitAuthorization.issuedAt,
          sourceRunDigest: digest(sourceRunBytes!),
          plannedRunDigest: digest(plannedRunBytes),
          completionUpdatedAt: planned.plan.updatedRun.updatedAt,
          plannedReceipt: planned.plan.updatedRun.pendingDelegation
        };
      }

      const created = createCommitIntent(resolved.taskDir, {
        taskId: resolved.taskId,
        mode: input.orchestrated ? 'orchestrated' : 'standalone',
        phase: 'prepared',
        baselineHead: input.baselineHead,
        committedHead: null,
        pushEvidence: null,
        orchestration,
        createdAt: now,
        updatedAt: now
      }, { token: options.token });
      return {
        status: 'ready', changed: true, taskId: resolved.taskId,
        intent: commitIntentView(created.intent, currentHead), token: created.token, error: null
      };
    });
  } catch (error) {
    return mapCommitIntentError(error, resolved.taskId);
  }
}

function checkpointCommitIntent(
  taskRef: string,
  input: Readonly<{
    token: string;
    kind: 'committed' | 'pushed';
    head: string;
    remote?: string;
    ref?: string;
  }>,
  options: OrchestrationOptions = {}
): CommitIntentResult {
  const resolved = resolveTaskRef(taskRef, { repoRoot: options.repoRoot });
  if (!resolved.ok) return commitIntentFailed(resolved.code, resolved.message, resolved.taskId);
  try {
    return withTaskExecutionLock(resolved.repoRoot, resolved.taskId, 'commit-intent.checkpoint', () => {
      const intent = readCommitIntent(resolved.taskDir, resolved.taskId, input.token);
      const currentHead = repositoryHead(resolved.repoRoot);
      if (currentHead !== input.head) {
        return commitIntentFailed('ORCHESTRATION_COMMIT_RECOVERY_REQUIRED', 'checkpoint HEAD does not match the repository HEAD', resolved.taskId);
      }
      if (input.kind === 'committed' && !isAncestor(resolved.repoRoot, intent.baselineHead, input.head)) {
        return commitIntentFailed('ORCHESTRATION_COMMIT_RECOVERY_REQUIRED', 'committed HEAD does not descend from the baseline', resolved.taskId);
      }
      if (input.kind === 'pushed') {
        const expectedHead = intent.committedHead ?? intent.baselineHead;
        if (input.head !== expectedHead || !input.remote || !input.ref) {
          return commitIntentFailed('ORCHESTRATION_COMMIT_INTENT_STATE_INVALID', 'pushed checkpoint requires matching remote, ref and HEAD', resolved.taskId);
        }
      }
      const now = (options.now ?? (() => new Date().toISOString()))();
      const updated = updateCommitIntent(resolved.taskDir, resolved.taskId, input.token, input.kind === 'committed'
        ? { phase: 'committed', committedHead: input.head, updatedAt: now }
        : {
            phase: 'pushed', updatedAt: now,
            pushEvidence: { remote: input.remote!, ref: input.ref!, head: input.head }
          });
      return {
        status: 'ready', changed: true, taskId: resolved.taskId,
        intent: commitIntentView(updated, currentHead), error: null
      };
    });
  } catch (error) {
    return mapCommitIntentError(error, resolved.taskId);
  }
}

function completeCommitIntent(
  taskRef: string,
  input: Readonly<{ token: string; agent: string }>,
  options: OrchestrationOptions = {}
): CommitIntentResult {
  const resolved = resolveTaskRef(taskRef, { repoRoot: options.repoRoot });
  if (!resolved.ok) return commitIntentFailed(resolved.code, resolved.message, resolved.taskId);
  try {
    return withTaskExecutionLock(resolved.repoRoot, resolved.taskId, 'commit-intent.complete', () => {
      const intent = readCommitIntent(resolved.taskDir, resolved.taskId, input.token);
      const currentHead = repositoryHead(resolved.repoRoot);
      if (intent.orchestration === null) {
        removeCommitIntent(resolved.taskDir, resolved.taskId, input.token);
        return { status: 'ready', changed: true, taskId: resolved.taskId, intent: null, error: null };
      }
      if (intent.orchestration.plannedReceipt.agent !== input.agent) {
        return commitIntentFailed('ORCHESTRATION_PROVENANCE_MISMATCH', 'completion agent does not match the planned receipt', resolved.taskId);
      }
      const runFile = orchestrationPath(resolved.taskDir);
      const currentBytes = fs.readFileSync(runFile, 'utf8');
      const currentDigest = digest(currentBytes);
      if (currentDigest === intent.orchestration.sourceRunDigest) {
        const run = readRun(resolved.taskDir);
        if (!run) return commitIntentFailed('ORCHESTRATION_RUN_MISSING', 'orchestration run disappeared', resolved.taskId);
        const plannedRun: OrchestrationRun = Object.freeze({
          ...run,
          pendingDelegation: intent.orchestration.plannedReceipt,
          updatedAt: intent.orchestration.completionUpdatedAt
        });
        if (digest(serialize(plannedRun)) !== intent.orchestration.plannedRunDigest) {
          return commitIntentFailed('ORCHESTRATION_COMMIT_RECOVERY_REQUIRED', 'planned orchestration bytes no longer match the intent', resolved.taskId);
        }
        atomicWrite(runFile, plannedRun);
        if (digest(fs.readFileSync(runFile)) !== intent.orchestration.plannedRunDigest) {
          return commitIntentFailed('ORCHESTRATION_COMMIT_COMPLETE_PARTIAL', 'orchestration completion could not be verified', resolved.taskId);
        }
      } else if (currentDigest !== intent.orchestration.plannedRunDigest) {
        return commitIntentFailed('ORCHESTRATION_COMMIT_RECOVERY_REQUIRED', 'orchestration state changed after commit begin', resolved.taskId);
      }
      try {
        removeCommitIntent(resolved.taskDir, resolved.taskId, input.token);
      } catch (error) {
        return commitIntentFailed(
          'ORCHESTRATION_COMMIT_COMPLETE_PARTIAL',
          error instanceof Error ? error.message : String(error),
          resolved.taskId
        );
      }
      return { status: 'ready', changed: true, taskId: resolved.taskId, intent: null, error: null };
    });
  } catch (error) {
    return mapCommitIntentError(error, resolved.taskId);
  }
}

function abortCommitIntent(
  taskRef: string,
  input: Readonly<{ token: string; expectedHead: string }>,
  options: OrchestrationOptions = {}
): CommitIntentResult {
  const resolved = resolveTaskRef(taskRef, { repoRoot: options.repoRoot });
  if (!resolved.ok) return commitIntentFailed(resolved.code, resolved.message, resolved.taskId);
  try {
    return withTaskExecutionLock(resolved.repoRoot, resolved.taskId, 'commit-intent.abort', () => {
      const intent = readCommitIntent(resolved.taskDir, resolved.taskId, input.token);
      const currentHead = repositoryHead(resolved.repoRoot);
      if (
        intent.phase !== 'prepared'
        || intent.pushEvidence !== null
        || input.expectedHead !== intent.baselineHead
        || currentHead !== intent.baselineHead
      ) {
        return commitIntentFailed('ORCHESTRATION_COMMIT_RECOVERY_REQUIRED', 'commit intent has side effects or repository drift', resolved.taskId);
      }
      removeCommitIntent(resolved.taskDir, resolved.taskId, input.token);
      return { status: 'ready', changed: true, taskId: resolved.taskId, intent: null, error: null };
    });
  } catch (error) {
    return mapCommitIntentError(error, resolved.taskId);
  }
}

function statusCommitIntent(taskRef: string, options: OrchestrationOptions = {}): CommitIntentResult {
  const resolved = resolveTaskRef(taskRef, { repoRoot: options.repoRoot });
  if (!resolved.ok) return commitIntentFailed(resolved.code, resolved.message, resolved.taskId);
  try {
    const intent = readCommitIntent(resolved.taskDir, resolved.taskId);
    return {
      status: 'ready', changed: false, taskId: resolved.taskId,
      intent: commitIntentView(intent, repositoryHead(resolved.repoRoot)), error: null
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { status: 'ready', changed: false, taskId: resolved.taskId, intent: null, error: null };
    }
    return mapCommitIntentError(error, resolved.taskId);
  }
}

function statusOrchestration(taskRef: string, options: OrchestrationOptions = {}): OrchestrationResult {
  const resolved = resolveTaskRef(taskRef, { repoRoot: options.repoRoot });
  if (!resolved.ok) return failed(resolved.code, resolved.message, resolved.taskId);
  const run = readRun(resolved.taskDir);
  if (!run) return failed('ORCHESTRATION_RUN_MISSING', 'no orchestration run exists', resolved.taskId);
  return { status: run.status, changed: false, taskId: resolved.taskId, run, next: null, error: null };
}

function prepareOrchestrationDelegationUnlocked(
  taskRef: string,
  input: Readonly<{ client: AgentClientId; requestedModel?: string; requestedReasoningEffort?: string }>,
  options: OrchestrationOptions = {}
): OrchestrationResult {
  const resolved = resolveTaskRef(taskRef, { repoRoot: options.repoRoot });
  if (!resolved.ok) return failed(resolved.code, resolved.message, resolved.taskId);
  if (fs.existsSync(commitIntentPath(resolved.taskDir))) {
    try {
      readCommitIntent(resolved.taskDir, resolved.taskId);
    } catch (error) {
      return failed(
        'ORCHESTRATION_COMMIT_INTENT_INVALID',
        error instanceof Error ? error.message : String(error),
        resolved.taskId
      );
    }
    return failed('ORCHESTRATION_COMMIT_INTENT_BUSY', 'an active commit intent blocks delegation preparation', resolved.taskId);
  }
  if (!(options.supportsLifecycleDelegation ?? supportsLifecycleDelegation)(input.client)) {
    return failed('ORCHESTRATION_CLIENT_UNSUPPORTED', `client '${input.client}' does not support lifecycle orchestration`, resolved.taskId);
  }
  const run = readRun(resolved.taskDir);
  if (!run || run.status !== 'running') return failed('ORCHESTRATION_RUN_NOT_RUNNING', 'a running orchestration is required', resolved.taskId);
  if (!isV2Policy(run.modelPolicy)) return failed('ORCHESTRATION_MODEL_EVIDENCE_MISSING', 'running orchestration has no persisted model policy', resolved.taskId);
  if (run.pendingDelegation) return failed('ORCHESTRATION_DELEGATION_BUSY', 'the run already has a pending delegation', resolved.taskId);
  const repositoryPending = (['claude-code', 'codex'] as AgentClientId[])
    .flatMap((client) => matchingDelegations(client, () => true, options));
  if (repositoryPending.length > 0) {
    return failed('ORCHESTRATION_DELEGATION_BUSY', 'the repository already has a pending lifecycle delegation', resolved.taskId);
  }
  if (run.stepCount >= run.maxSteps) return pauseOrchestration(taskRef, 'ORCHESTRATION_MAX_STEPS', 'maximum orchestration steps reached', true, options);
  const routed = routeOrchestration(taskRef, options);
  if (!routed.next) return routed;
  const next = routed.next;
  if (!validModel(input.requestedModel)) {
    return failed('ORCHESTRATION_REQUESTED_MODEL_REQUIRED', 'prepare requires the exact requested model identity', resolved.taskId);
  }
  if (!validModel(input.requestedReasoningEffort)) {
    return failed('ORCHESTRATION_REQUESTED_REASONING_EFFORT_REQUIRED', 'prepare requires the exact requested reasoning effort', resolved.taskId);
  }
  const expectedPolicy = run.modelPolicy[next.role];
  if (input.requestedModel !== expectedPolicy.model) {
    return failed('ORCHESTRATION_REQUESTED_MODEL_MISMATCH', `requested model does not match the persisted ${next.role} model`, resolved.taskId);
  }
  if (input.requestedReasoningEffort !== expectedPolicy.reasoningEffort) {
    return failed('ORCHESTRATION_REQUESTED_REASONING_EFFORT_MISMATCH', `requested reasoning effort does not match the persisted ${next.role} policy`, resolved.taskId);
  }
  let beforeFingerprint: string;
  try {
    beforeFingerprint = (options.captureWorkspace ?? captureWorkspaceSnapshot)(resolved.repoRoot, resolved.taskId);
  } catch (error) {
    return failed('ORCHESTRATION_SNAPSHOT_FAILED', error instanceof Error ? error.message : String(error), resolved.taskId);
  }
  const receipt = prepareDelegation({
    taskId: resolved.taskId,
    runId: run.runId,
    role: next.role,
    stage: next.stage,
    round: next.round,
    artifact: next.artifact,
    client: input.client,
    requestedModel: input.requestedModel,
    requestedReasoningEffort: input.requestedReasoningEffort,
    workspaceSnapshotScope: 'task',
    beforeFingerprint
  }, { id: options.id, now: options.now });
  const updated = withUpdatedRun(run, {
    nextStage: next.stage,
    pendingDelegation: receipt,
    commitAuthorization: next.stage === 'commit' && run.commitAuthorization.issuedAt === null
      ? { issuedAt: (options.now ?? (() => new Date().toISOString()))(), consumedAt: null }
      : run.commitAuthorization
  });
  saveRun(resolved.taskDir, updated);
  return { status: 'running', changed: true, taskId: resolved.taskId, run: updated, next, error: null };
}

function prepareOrchestrationDelegation(
  taskRef: string,
  input: Readonly<{ client: AgentClientId; requestedModel?: string; requestedReasoningEffort?: string }>,
  options: OrchestrationOptions = {}
): OrchestrationResult {
  const resolved = resolveTaskRef(taskRef, { repoRoot: options.repoRoot });
  if (!resolved.ok) return failed(resolved.code, resolved.message, resolved.taskId);
  try {
    return withTaskExecutionLock(
      resolved.repoRoot,
      '__repository__',
      'task-orchestration.prepare.repository',
      () => withTaskExecutionLock(
        resolved.repoRoot,
        resolved.taskId,
        'task-orchestration.prepare.task',
        () => prepareOrchestrationDelegationUnlocked(taskRef, input, options)
      )
    );
  } catch (error) {
    if (error instanceof TaskExecutionLockError) return failed(error.code, error.message, resolved.taskId);
    throw error;
  }
}

function matchingDelegations(
  client: AgentClientId,
  predicate: (receipt: DelegationReceipt) => boolean,
  options: OrchestrationOptions
): Array<{ taskId: string; run: OrchestrationRun }> {
  const repoRoot = options.repoRoot ?? process.cwd();
  const activeRoot = path.join(repoRoot, '.agents', 'workspace', 'active');
  if (!fs.existsSync(activeRoot)) return [];
  return fs.readdirSync(activeRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const run = readRun(path.join(activeRoot, entry.name));
      if (!run?.pendingDelegation) return [];
      const receipt = run.pendingDelegation;
      return receipt.client === client && predicate(receipt)
        ? [{ taskId: entry.name, run }]
        : [];
    });
}

function uniqueMatchingDelegation(
  client: AgentClientId,
  predicate: (receipt: DelegationReceipt) => boolean,
  options: OrchestrationOptions
): { taskId: string; run: OrchestrationRun } | OrchestrationResult {
  const matches = matchingDelegations(client, predicate, options);
  if (matches.length === 0) return failed('ORCHESTRATION_DELEGATION_MISSING', 'no matching lifecycle delegation exists');
  if (matches.length > 1) return failed('ORCHESTRATION_DELEGATION_AMBIGUOUS', 'multiple lifecycle delegations match the native hook event');
  return matches[0]!;
}

function activateMatchingOrchestrationDelegation(
  client: AgentClientId,
  event: Parameters<typeof activateDelegation>[1],
  options: OrchestrationOptions = {}
): OrchestrationResult {
  const role = managedDelegationRole(event.nativeAgent);
  if (!role) return failed('DELEGATION_IGNORED', `subagent '${event.nativeAgent}' is not lifecycle-managed`);
  const matched = uniqueMatchingDelegation(
    client,
    (receipt) => receipt.status === 'prepared',
    options
  );
  if ('status' in matched) return matched;
  if (matched.run.receipts.some((receipt) => receipt.childId === event.childId)) {
    return pauseOrchestration(matched.taskId, 'DELEGATION_IDENTITY_REUSED', 'native child identity was already used by this run', true, options);
  }
  return activateOrchestrationDelegation(matched.taskId, event, options);
}

function sealMatchingOrchestrationDelegation(
  client: AgentClientId,
  event: Readonly<{ nativeAgent: string; childId: string }>,
  options: OrchestrationOptions = {}
): OrchestrationResult {
  const role = managedDelegationRole(event.nativeAgent);
  if (!role) return failed('DELEGATION_IGNORED', `subagent '${event.nativeAgent}' is not lifecycle-managed`);
  const matched = uniqueMatchingDelegation(
    client,
    (receipt) => receipt.status !== 'prepared',
    options
  );
  if ('status' in matched) return matched;
  const receipt = matched.run.pendingDelegation!;
  if (receipt.role !== role) {
    return pauseOrchestration(matched.taskId, 'DELEGATION_ROLE_MISMATCH', `managed role ${role} does not match ${receipt.role}`, true, options);
  }
  const repoRoot = options.repoRoot ?? process.cwd();
  try {
    const snapshotTaskId = receipt.workspaceSnapshotScope === 'task' ? receipt.taskId : null;
    const afterFingerprint = (options.captureWorkspace ?? captureWorkspaceSnapshot)(repoRoot, snapshotTaskId);
    const changedPaths = (options.diffWorkspace ?? diffWorkspaceSnapshots)(repoRoot, receipt.beforeFingerprint, afterFingerprint);
    return sealOrchestrationDelegation(matched.taskId, {
      childId: event.childId,
      exitCode: 0,
      afterFingerprint,
      changedPaths
    }, options);
  } catch (error) {
    return pauseOrchestration(
      matched.taskId,
      'ORCHESTRATION_SNAPSHOT_FAILED',
      error instanceof Error ? error.message : String(error),
      true,
      options
    );
  }
}

function activateOrchestrationDelegation(
  taskRef: string,
  event: Parameters<typeof activateDelegation>[1],
  options: OrchestrationOptions = {}
): OrchestrationResult {
  const resolved = resolveTaskRef(taskRef, { repoRoot: options.repoRoot });
  if (!resolved.ok) return failed(resolved.code, resolved.message, resolved.taskId);
  const run = readRun(resolved.taskDir);
  if (!run?.pendingDelegation) return failed('ORCHESTRATION_DELEGATION_MISSING', 'no pending delegation exists', resolved.taskId);
  const result = activateDelegation(run.pendingDelegation, event, { now: options.now });
  if (!result.ok) {
    if (result.code === 'DELEGATION_IGNORED') return { status: run.status, changed: false, taskId: resolved.taskId, run, next: null, error: null };
    return pauseOrchestration(taskRef, result.code, result.message, true, options);
  }
  const updated = withUpdatedRun(run, { pendingDelegation: result.receipt });
  saveRun(resolved.taskDir, updated);
  return { status: 'running', changed: true, taskId: resolved.taskId, run: updated, next: null, error: null };
}

function completeOrchestrationStage(
  taskRef: string,
  event: Parameters<typeof completeDelegationStage>[1],
  options: OrchestrationOptions = {}
): OrchestrationResult {
  const resolved = resolveTaskRef(taskRef, { repoRoot: options.repoRoot });
  if (!resolved.ok) return failed(resolved.code, resolved.message, resolved.taskId);
  const run = readRun(resolved.taskDir);
  if (!run) return { status: 'running', changed: false, taskId: resolved.taskId, run: null, next: null, error: null };
  if (!run.pendingDelegation) return failed('ORCHESTRATION_DELEGATION_MISSING', 'active run has no pending delegation', resolved.taskId);
  const result = completeDelegationStage(run.pendingDelegation, event);
  if (!result.ok) return pauseOrchestration(taskRef, result.code, result.message, true, options);
  const updated = withUpdatedRun(run, { pendingDelegation: result.receipt });
  saveRun(resolved.taskDir, updated);
  return { status: 'running', changed: true, taskId: resolved.taskId, run: updated, next: null, error: null };
}

function inspectOrchestrationStage(
  taskRef: string,
  event: OrchestrationStageIdentity,
  options: OrchestrationOptions = {}
): OrchestrationResult {
  const resolved = resolveTaskRef(taskRef, { repoRoot: options.repoRoot });
  if (!resolved.ok) return failed(resolved.code, resolved.message, resolved.taskId);
  let run: OrchestrationRun | null;
  try {
    run = readRun(resolved.taskDir);
  } catch (error) {
    return failed('ORCHESTRATION_STATE_INVALID', error instanceof Error ? error.message : String(error), resolved.taskId);
  }
  if (!run) return failed('ORCHESTRATION_RUN_MISSING', 'no orchestration run exists', resolved.taskId);
  const receipt = run.pendingDelegation;
  if (
    !receipt
    || receipt.status !== 'activated'
    || receipt.stage !== event.stage
    || receipt.round !== event.round
    || receipt.artifact !== event.artifact
    || receipt.role !== event.role
  ) {
    return failed(
      'ORCHESTRATION_PROVENANCE_MISMATCH',
      'active run does not have one matching activated delegation',
      resolved.taskId
    );
  }
  return { status: 'running', changed: false, taskId: resolved.taskId, run, next: null, error: null };
}

function planOrchestrationStageCompletion(
  taskRef: string,
  event: Readonly<{ stage: DelegationStage; round: number; artifact: string; role: DelegationRole; agent: string }>,
  options: OrchestrationOptions = {}
): OrchestrationCompletionPlanResult {
  const inspected = inspectOrchestrationStage(taskRef, event, options);
  if (inspected.status === 'failed' || !inspected.run?.pendingDelegation) {
    return { result: inspected, plan: null };
  }
  const receipt = inspected.run.pendingDelegation;
  const completed = completeDelegationStage(receipt, event);
  if (!completed.ok) {
    return { result: failed(completed.code, completed.message, inspected.taskId), plan: null };
  }
  const resolved = resolveTaskRef(taskRef, { repoRoot: options.repoRoot });
  if (!resolved.ok) return { result: failed(resolved.code, resolved.message, resolved.taskId), plan: null };
  const updatedRun = withUpdatedRun(inspected.run, { pendingDelegation: completed.receipt }, options.now);
  return {
    result: { status: 'running', changed: true, taskId: resolved.taskId, run: updatedRun, next: null, error: null },
    plan: {
      taskId: resolved.taskId,
      taskDir: resolved.taskDir,
      updatedRun
    }
  };
}

function commitOrchestrationStageCompletion(plan: OrchestrationStageCompletion): void {
  saveRun(plan.taskDir, plan.updatedRun);
}

function sealOrchestrationDelegation(
  taskRef: string,
  event: Parameters<typeof sealDelegation>[1],
  options: OrchestrationOptions = {}
): OrchestrationResult {
  const resolved = resolveTaskRef(taskRef, { repoRoot: options.repoRoot });
  if (!resolved.ok) return failed(resolved.code, resolved.message, resolved.taskId);
  const run = readRun(resolved.taskDir);
  if (!run?.pendingDelegation) return failed('ORCHESTRATION_DELEGATION_MISSING', 'no pending delegation exists', resolved.taskId);
  const result = sealDelegation(run.pendingDelegation, event, { now: options.now });
  if (!result.ok) return pauseOrchestration(taskRef, result.code, result.message, true, options);
  const updated = withUpdatedRun(run, { pendingDelegation: result.receipt });
  saveRun(resolved.taskDir, updated);
  return { status: 'running', changed: true, taskId: resolved.taskId, run: updated, next: null, error: null };
}

function advanceOrchestration(taskRef: string, options: OrchestrationOptions = {}): OrchestrationResult {
  const resolved = resolveTaskRef(taskRef, { repoRoot: options.repoRoot });
  if (!resolved.ok) return failed(resolved.code, resolved.message, resolved.taskId);
  const run = readRun(resolved.taskDir);
  if (!run?.pendingDelegation) return failed('ORCHESTRATION_DELEGATION_MISSING', 'no pending delegation exists', resolved.taskId);
  const result = consumeDelegation(run.pendingDelegation, { now: options.now });
  if (!result.ok) return pauseOrchestration(taskRef, result.code, result.message, true, options);
  const completed = result.receipt.stage === 'commit';
  const updated = withUpdatedRun(run, {
    status: completed ? 'completed' : 'running',
    nextStage: null,
    stepCount: run.stepCount + 1,
    pendingDelegation: null,
    receipts: Object.freeze([...run.receipts, result.receipt]),
    commitAuthorization: completed
      ? { ...run.commitAuthorization, consumedAt: (options.now ?? (() => new Date().toISOString()))() }
      : run.commitAuthorization
  });
  saveRun(resolved.taskDir, updated);
  return { status: updated.status, changed: true, taskId: resolved.taskId, run: updated, next: null, error: null };
}

function pauseOrchestration(
  taskRef: string,
  code: string,
  message: string,
  recoverable: boolean,
  options: OrchestrationOptions = {}
): OrchestrationResult {
  const resolved = resolveTaskRef(taskRef, { repoRoot: options.repoRoot });
  if (!resolved.ok) return failed(resolved.code, resolved.message, resolved.taskId);
  const run = readRun(resolved.taskDir);
  if (!run) return failed('ORCHESTRATION_RUN_MISSING', 'no orchestration run exists', resolved.taskId);
  const updated = withUpdatedRun(run, { status: 'paused', pause: { code, message, recoverable } });
  saveRun(resolved.taskDir, updated);
  return { status: 'paused', changed: true, taskId: resolved.taskId, run: updated, next: null, error: null };
}

export {
  activateMatchingOrchestrationDelegation,
  activateOrchestrationDelegation,
  advanceOrchestration,
  abortCommitIntent,
  beginCommitIntent,
  beginOrResumeOrchestration,
  checkpointCommitIntent,
  commitOrchestrationStageCompletion,
  completeCommitIntent,
  completeOrchestrationStage,
  inspectOrchestrationStage,
  orchestrationPath,
  pauseOrchestration,
  planOrchestrationStageCompletion,
  prepareOrchestrationDelegation,
  readRun,
  routeOrchestration,
  sealMatchingOrchestrationDelegation,
  sealOrchestrationDelegation,
  statusCommitIntent,
  statusOrchestration
};
export type {
  CommitIntentResult,
  OrchestrationCompletionPlanResult,
  OrchestrationModelPolicy,
  OrchestrationNext,
  OrchestrationResult,
  OrchestrationRun,
  OrchestrationStageCompletion,
  OrchestrationStageIdentity,
  OrchestrationStatus
};
