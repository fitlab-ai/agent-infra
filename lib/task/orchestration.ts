import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { parseTypedTaskFrontmatter } from './frontmatter.ts';
import { parseReviewSummary } from './review-artifacts.ts';
import { inspectArtifactDirectory } from './artifact-lifecycle.ts';
import { parseLedger, summarizeLedgerStage, validateLedgerRows } from './ledger.ts';
import { resolveTaskRef } from './resolve-ref.ts';
import {
  activateDelegation,
  abortPreparedDelegation,
  completeDelegationStage,
  consumeDelegation,
  dispatchDelegation,
  foldBlankToNull,
  isDelegationReceipt,
  managedDelegationRole,
  prepareDelegation,
  sealDelegation
} from './delegation-receipts.ts';
import type {
  DelegationLifecycleProvenance,
  DelegationReceipt,
  DelegationRole,
  DelegationStage
} from './delegation-receipts.ts';
import { normalizeAgentClients } from '../agent-clients/config.ts';
import { resolveAgentRuntimeStoreRoot } from '../runtime/agent-runtime.ts';
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
import type { WorkspaceSnapshotContext } from './workspace-snapshot.ts';
import { assertGitRepositoryBinding } from '../git/worktree-identity.ts';
import { TaskExecutionLockError, withTaskExecutionLock } from './task-execution-lock.ts';
import { hasActiveCodexLifecycleEvidence } from '../agent-clients/adapters/codex-lifecycle/store.ts';
import type { CodexCapabilityProvenanceDetail } from '../agent-clients/adapters/codex-lifecycle/capability-store.ts';

type OrchestrationStatus = 'running' | 'paused' | 'completed';
type ModelPolicySource = Readonly<{
  kind: 'explicit' | 'project-config';
  client: AgentClientId;
  resolvedAt: string;
}>;
type ClaudeCodeCapabilityRecovery = Readonly<{
  code: 'CLIENT_CAPABILITY_ENABLED';
  recoveredAt: string;
  previousStatus: 'paused';
  previousPause: Readonly<{ code: 'ORCHESTRATION_CLIENT_UNSUPPORTED'; message: string; recoverable: boolean }>;
  client: 'claude-code';
  guards: Readonly<{
    stepCount: 0;
    nextStage: null;
    baselineEmpty: true;
    receiptCount: 0;
    pendingDelegation: false;
    commitAuthorizationUnused: true;
    completionEvidenceAbsent: true;
  }>;
  resultingStatus: 'running';
}>;
type OrchestrationRecovery = ClaudeCodeCapabilityRecovery;
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
  taskId: string;
  runId: string;
  status: OrchestrationStatus;
  nextStage: DelegationStage | null;
  stepCount: number;
  maxSteps: number;
  modelPolicy: OrchestrationModelPolicy;
  modelPolicySource: ModelPolicySource;
  recoveryHistory: readonly OrchestrationRecovery[];
  baseline: string;
  pendingDelegation: DelegationReceipt | null;
  receipts: readonly DelegationReceipt[];
  pause: Readonly<{ code: string; message: string; recoverable: boolean }> | null;
  commitAuthorization: Readonly<{ issuedAt: string | null; consumedAt: string | null }>;
  completionEvidence: CleanCompletionEvidence | null;
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
  warnings?: readonly Readonly<{ code: string; message: string; action: string }>[];
  error: Readonly<{
    code: string;
    message: string;
    client?: AgentClientId;
    missingFields?: readonly string[];
    modelSelectionContext?: ReturnType<typeof getAgentClientModelSelection>;
    detail?: CodexCapabilityProvenanceDetail;
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
  gitWorktreeRoot?: string;
  id?: () => string;
  now?: () => string;
  maxSteps?: number;
  client?: AgentClientId;
  modelPolicy?: OrchestrationModelPolicy;
  captureWorkspace?: (context: WorkspaceSnapshotContext) => string;
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
  validateLifecycleCapability?: () => Exclude<OrchestrationResult['error'], null> | null;
  consumeLifecycleCapability?: () => Exclude<OrchestrationResult['error'], null> | null;
  token?: () => string;
  monotonicNow?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  hasActiveLifecycleEvidence?: (receipt: DelegationReceipt) => boolean;
};

function supportsLifecycleDelegation(client: AgentClientId): boolean {
  return getAgentClientCapability(client, 'subagents').level !== 'unsupported'
    && getAgentClientCapability(client, 'orchestration').level !== 'unsupported'
    && getAgentClientDelegationEvidence(client).actualModel !== 'unavailable'
    && getAgentClientDelegationEvidence(client).actualReasoningEffort !== 'unavailable';
}

function orchestrationPath(taskDir: string): string {
  return path.join(taskDir, 'orchestration.json');
}

const ORCHESTRATION_STATE_INVALID_MESSAGE = 'orchestration.json does not match the current runtime structure; the file was left unchanged; rebuild the sandbox or manually repair the state before retrying';

class OrchestrationStateError extends Error {
  readonly code = 'ORCHESTRATION_STATE_INVALID';
  readonly taskId: string | null;

  constructor(taskId: string | null = null) {
    super(ORCHESTRATION_STATE_INVALID_MESSAGE);
    this.name = 'OrchestrationStateError';
    this.taskId = taskId;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function exactText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim() === value;
}

function nullableText(value: unknown): value is string | null {
  return value === null || exactText(value);
}

function isPause(value: unknown): value is NonNullable<OrchestrationRun['pause']> {
  return hasExactKeys(value, ['code', 'message', 'recoverable'])
    && exactText(value.code)
    && exactText(value.message)
    && typeof value.recoverable === 'boolean';
}

function isModelPolicySource(value: unknown): value is ModelPolicySource {
  return hasExactKeys(value, ['kind', 'client', 'resolvedAt'])
    && ['explicit', 'project-config'].includes(value.kind as string)
    && isAgentClientId(value.client)
    && exactText(value.resolvedAt);
}

function isModelPolicy(value: unknown): value is OrchestrationModelPolicy {
  if (!hasExactKeys(value, ['executor', 'reviewer'])) return false;
  return [value.executor, value.reviewer].every((role) => hasExactKeys(role, ['model', 'reasoningEffort'])
    && exactText(role.model)
    && exactText(role.reasoningEffort));
}

const RECOVERY_GUARD_KEYS = [
  'stepCount', 'nextStage', 'baselineEmpty', 'receiptCount', 'pendingDelegation',
  'commitAuthorizationUnused', 'completionEvidenceAbsent'
] as const;

function isRecovery(value: unknown): value is OrchestrationRecovery {
  if (!hasExactKeys(value, [
    'code', 'recoveredAt', 'previousStatus', 'previousPause', 'client', 'guards', 'resultingStatus'
  ])) return false;
  const guards = value.guards;
  return value.code === 'CLIENT_CAPABILITY_ENABLED'
    && exactText(value.recoveredAt)
    && value.previousStatus === 'paused'
    && isPause(value.previousPause)
    && value.previousPause.code === 'ORCHESTRATION_CLIENT_UNSUPPORTED'
    && value.client === 'claude-code'
    && hasExactKeys(guards, RECOVERY_GUARD_KEYS)
    && guards.stepCount === 0
    && guards.nextStage === null
    && guards.baselineEmpty === true
    && guards.receiptCount === 0
    && guards.pendingDelegation === false
    && guards.commitAuthorizationUnused === true
    && guards.completionEvidenceAbsent === true
    && value.resultingStatus === 'running';
}

function isCompletionEvidence(value: unknown): value is CleanCompletionEvidence {
  return hasExactKeys(value, [
    'kind', 'observedAt', 'head', 'headTree', 'worktreeTree', 'lastReviewedCommit', 'prNumber', 'prHead'
  ])
    && value.kind === 'reviewed-head-clean'
    && exactText(value.observedAt)
    && exactText(value.head)
    && exactText(value.headTree)
    && exactText(value.worktreeTree)
    && exactText(value.lastReviewedCommit)
    && Number.isSafeInteger(value.prNumber)
    && (value.prNumber as number) > 0
    && exactText(value.prHead);
}

const ORCHESTRATION_RUN_KEYS = [
  'taskId', 'runId', 'status', 'nextStage', 'stepCount', 'maxSteps', 'modelPolicy',
  'modelPolicySource', 'recoveryHistory', 'baseline', 'pendingDelegation', 'receipts',
  'pause', 'commitAuthorization', 'completionEvidence', 'createdAt', 'updatedAt'
] as const;

function parseOrchestrationRun(value: unknown, expectedTaskId?: string): OrchestrationRun {
  if (!hasExactKeys(value, ORCHESTRATION_RUN_KEYS)
    || !exactText(value.taskId)
    || (expectedTaskId !== undefined && value.taskId !== expectedTaskId)
    || !exactText(value.runId)
    || !['running', 'paused', 'completed'].includes(value.status as string)
    || !(value.nextStage === null || ['analysis', 'review-analysis', 'plan', 'review-plan', 'code', 'review-code', 'commit'].includes(value.nextStage as string))
    || !Number.isSafeInteger(value.stepCount) || (value.stepCount as number) < 0
    || !Number.isSafeInteger(value.maxSteps) || (value.maxSteps as number) < 1
    || !isModelPolicy(value.modelPolicy)
    || !isModelPolicySource(value.modelPolicySource)
    || !Array.isArray(value.recoveryHistory) || !value.recoveryHistory.every(isRecovery)
    || typeof value.baseline !== 'string'
    || !(value.pendingDelegation === null || isDelegationReceipt(value.pendingDelegation))
    || !Array.isArray(value.receipts) || !value.receipts.every(isDelegationReceipt)
    || !(value.pause === null || isPause(value.pause))
    || !hasExactKeys(value.commitAuthorization, ['issuedAt', 'consumedAt'])
    || !nullableText(value.commitAuthorization.issuedAt)
    || !nullableText(value.commitAuthorization.consumedAt)
    || !(value.completionEvidence === null || isCompletionEvidence(value.completionEvidence))
    || !exactText(value.createdAt)
    || !exactText(value.updatedAt)) {
    throw new OrchestrationStateError();
  }
  const receipts = [...value.receipts, ...(value.pendingDelegation ? [value.pendingDelegation] : [])];
  if (receipts.some((receipt) => receipt.taskId !== value.taskId || receipt.runId !== value.runId)) {
    throw new OrchestrationStateError();
  }
  return value as OrchestrationRun;
}

function readRun(taskDir: string): OrchestrationRun | null {
  const file = orchestrationPath(taskDir);
  if (!fs.existsSync(file)) return null;
  const taskId = path.basename(taskDir);
  try {
    return parseOrchestrationRun(JSON.parse(fs.readFileSync(file, 'utf8')), taskId);
  } catch (error) {
    if (error instanceof OrchestrationStateError) throw new OrchestrationStateError(taskId);
    throw new OrchestrationStateError(taskId);
  }
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

function gitRootFor(stateRoot: string, options: OrchestrationOptions): string {
  if (!options.gitWorktreeRoot) return stateRoot;
  return assertGitRepositoryBinding(stateRoot, options.gitWorktreeRoot).worktreeRoot;
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

function rolePolicy(run: OrchestrationRun, role: DelegationRole): OrchestrationRolePolicy | null {
  return run.modelPolicy[role];
}

function resolveProjectPolicy(repoRoot: string, client: AgentClientId): OrchestrationModelPolicy | undefined {
  const configPath = path.join(repoRoot, '.agents', '.airc.json');
  if (!fs.existsSync(configPath)) return undefined;
  const raw = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>;
  return normalizeAgentClients(raw).state[client].orchestration;
}

function canRecoverClaudeCodeUnsupportedPause(run: OrchestrationRun, taskDir: string): boolean {
  return run.status === 'paused'
    && run.pause?.code === 'ORCHESTRATION_CLIENT_UNSUPPORTED'
    && run.modelPolicySource?.client === 'claude-code'
    && run.stepCount === 0
    && run.nextStage === null
    && run.baseline === ''
    && run.pendingDelegation === null
    && run.receipts.length === 0
    && run.commitAuthorization?.issuedAt === null
    && run.commitAuthorization?.consumedAt === null
    && run.completionEvidence == null
    && run.recoveryHistory.length === 0;
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
    if (existing.status === 'completed') {
      return { status: 'completed', changed: false, taskId: resolved.taskId, run: existing, next: null, error: null };
    }
    if (existing.modelPolicySource.client !== options.client) {
      return failed('ORCHESTRATION_CLIENT_MISMATCH', 'provided client does not match the persisted run policy source', resolved.taskId);
    }
    if (options.modelPolicy) {
      const suppliedError = validateModelPolicy(options.modelPolicy);
      if (suppliedError) return failed(suppliedError.code, suppliedError.message, resolved.taskId);
      if (!sameModelPolicy(existing.modelPolicy, options.modelPolicy)) {
        return failed('ORCHESTRATION_MODEL_POLICY_MISMATCH', 'provided model policy does not match the persisted run policy', resolved.taskId);
      }
    }
    if (existing.status === 'paused' && existing.pause?.code === 'ORCHESTRATION_CLIENT_UNSUPPORTED') {
      if (existing.modelPolicySource.client !== 'claude-code'
        || !canRecoverClaudeCodeUnsupportedPause(existing, resolved.taskDir)) {
        return { status: 'paused', changed: false, taskId: resolved.taskId, run: existing, next: null, error: null };
      }
      const now = (options.now ?? (() => new Date().toISOString()))();
      const recovery: ClaudeCodeCapabilityRecovery = {
        code: 'CLIENT_CAPABILITY_ENABLED',
        recoveredAt: now,
        previousStatus: 'paused',
        previousPause: existing.pause as ClaudeCodeCapabilityRecovery['previousPause'],
        client: 'claude-code',
        guards: {
          stepCount: 0,
          nextStage: null,
          baselineEmpty: true,
          receiptCount: 0,
          pendingDelegation: false,
          commitAuthorizationUnused: true,
          completionEvidenceAbsent: true
        },
        resultingStatus: 'running'
      };
      const resumed = withUpdatedRun(existing, {
        status: 'running',
        pause: null,
        recoveryHistory: Object.freeze([...existing.recoveryHistory, recovery])
      }, () => now);
      saveRun(resolved.taskDir, resumed);
      return { status: 'running', changed: true, taskId: resolved.taskId, run: resumed, next: null, error: null };
    }
    if (existing.status === 'paused' && existing.pause?.recoverable && existing.pendingDelegation === null) {
      const resumed = withUpdatedRun(existing, { status: 'running', pause: null }, options.now);
      saveRun(resolved.taskDir, resumed);
      return { status: 'running', changed: true, taskId: resolved.taskId, run: resumed, next: null, error: null };
    }
    return { status: existing.status, changed: false, taskId: resolved.taskId, run: existing, next: null, error: null };
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
  let gitRoot: string;
  try {
    gitRoot = gitRootFor(resolved.repoRoot, options);
  } catch (error) {
    return failed('ORCHESTRATION_WORKTREE_INVALID', error instanceof Error ? error.message : String(error), resolved.taskId);
  }
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
      before = capture(gitRoot);
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
      inspection = inspect(resolved.taskId, { cwd: gitRoot });
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
      after = capture(gitRoot);
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

function statusOrchestration(taskRef: string, options: OrchestrationOptions = {}): OrchestrationResult {
  const resolved = resolveTaskRef(taskRef, { repoRoot: options.repoRoot });
  if (!resolved.ok) return failed(resolved.code, resolved.message, resolved.taskId);
  const run = readRun(resolved.taskDir);
  if (!run) return failed('ORCHESTRATION_RUN_MISSING', 'no orchestration run exists', resolved.taskId);
  return { status: run.status, changed: false, taskId: resolved.taskId, run, next: null, error: null };
}

function prepareOrchestrationDelegationUnlocked(
  taskRef: string,
  input: Readonly<{
    client: AgentClientId;
    requestedModel?: string;
    requestedReasoningEffort?: string;
    lifecycleProvenance?: DelegationLifecycleProvenance;
  }>,
  options: OrchestrationOptions = {}
): OrchestrationResult {
  const resolved = resolveTaskRef(taskRef, { repoRoot: options.repoRoot });
  if (!resolved.ok) return failed(resolved.code, resolved.message, resolved.taskId);
  if (!(options.supportsLifecycleDelegation ?? supportsLifecycleDelegation)(input.client)) {
    return failed('ORCHESTRATION_CLIENT_UNSUPPORTED', `client '${input.client}' does not support lifecycle orchestration`, resolved.taskId);
  }
  const run = readRun(resolved.taskDir);
  if (!run || run.status !== 'running') return failed('ORCHESTRATION_RUN_NOT_RUNNING', 'a running orchestration is required', resolved.taskId);
  if (run.pendingDelegation) return failed('ORCHESTRATION_DELEGATION_BUSY', 'the run already has a pending delegation', resolved.taskId);
  const repositoryPending = matchingDelegations(() => true, options);
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
  if (input.client === 'codex' && !input.lifecycleProvenance) {
    return failed('ORCHESTRATION_CODEX_PROVENANCE_REQUIRED', 'Codex prepare requires lifecycle provenance', resolved.taskId);
  }
  const expectedPolicy = run.modelPolicy[next.role];
  if (input.requestedModel !== expectedPolicy.model) {
    return failed('ORCHESTRATION_REQUESTED_MODEL_MISMATCH', `requested model does not match the persisted ${next.role} model`, resolved.taskId);
  }
  if (input.requestedReasoningEffort !== expectedPolicy.reasoningEffort) {
    return failed('ORCHESTRATION_REQUESTED_REASONING_EFFORT_MISMATCH', `requested reasoning effort does not match the persisted ${next.role} policy`, resolved.taskId);
  }
  const capabilityValidationError = options.validateLifecycleCapability?.();
  if (capabilityValidationError) {
    return failed(
      capabilityValidationError.code,
      capabilityValidationError.message,
      resolved.taskId,
      capabilityValidationError.detail ? { detail: capabilityValidationError.detail } : {}
    );
  }
  let beforeFingerprint: string;
  try {
    beforeFingerprint = (options.captureWorkspace ?? captureWorkspaceSnapshot)({
      gitRoot: gitRootFor(resolved.repoRoot, options),
      stateRoot: resolved.repoRoot,
      taskId: resolved.taskId
    });
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
    lifecycleProvenance: input.lifecycleProvenance ?? null,
    beforeFingerprint
  }, { id: options.id, now: options.now, monotonicNow: options.monotonicNow });
  const capabilityError = options.consumeLifecycleCapability?.();
  if (capabilityError) {
    return failed(
      capabilityError.code,
      capabilityError.message,
      resolved.taskId,
      capabilityError.detail ? { detail: capabilityError.detail } : {}
    );
  }
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
  input: Readonly<{
    client: AgentClientId;
    requestedModel?: string;
    requestedReasoningEffort?: string;
    lifecycleProvenance?: DelegationLifecycleProvenance;
  }>,
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

function dispatchOrchestrationDelegationUnlocked(
  taskRef: string,
  options: OrchestrationOptions = {}
): OrchestrationResult {
  const resolved = resolveTaskRef(taskRef, { repoRoot: options.repoRoot });
  if (!resolved.ok) return failed(resolved.code, resolved.message, resolved.taskId);
  const run = readRun(resolved.taskDir);
  if (!run?.pendingDelegation) return failed('ORCHESTRATION_DELEGATION_MISSING', 'no pending delegation exists', resolved.taskId);
  if (run.status !== 'running') {
    return failed('ORCHESTRATION_STATE_INVALID', 'spawn dispatch requires a running orchestration', resolved.taskId);
  }
  const result = dispatchDelegation(run.pendingDelegation, {
    now: options.now,
    monotonicNow: options.monotonicNow
  });
  if (!result.ok) return pauseOrchestration(taskRef, result.code, result.message, true, options);
  const updated = withUpdatedRun(run, { pendingDelegation: result.receipt });
  saveRun(resolved.taskDir, updated);
  return { status: 'running', changed: true, taskId: resolved.taskId, run: updated, next: null, error: null };
}

function dispatchOrchestrationDelegation(
  taskRef: string,
  options: OrchestrationOptions = {}
): OrchestrationResult {
  const resolved = resolveTaskRef(taskRef, { repoRoot: options.repoRoot });
  if (!resolved.ok) return failed(resolved.code, resolved.message, resolved.taskId);
  try {
    return withTaskExecutionLock(
      resolved.repoRoot,
      '__repository__',
      'task-orchestration.dispatch.repository',
      () => withTaskExecutionLock(
        resolved.repoRoot,
        resolved.taskId,
        'task-orchestration.dispatch.task',
        () => dispatchOrchestrationDelegationUnlocked(taskRef, options)
      )
    );
  } catch (error) {
    if (error instanceof TaskExecutionLockError) return failed(error.code, error.message, resolved.taskId);
    throw error;
  }
}

function matchingDelegations(
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
      if (!run || run.status !== 'running' || !run.pendingDelegation) return [];
      const receipt = run.pendingDelegation;
      return predicate(receipt)
        ? [{ taskId: entry.name, run }]
        : [];
    });
}

function uniqueMatchingDelegation(
  client: AgentClientId,
  predicate: (receipt: DelegationReceipt) => boolean,
  options: OrchestrationOptions
): { taskId: string; run: OrchestrationRun } | OrchestrationResult {
  const matches = matchingDelegations(
    (receipt) => receipt.client === client && predicate(receipt),
    options
  );
  if (matches.length === 0) return failed('ORCHESTRATION_DELEGATION_MISSING', 'no matching lifecycle delegation exists');
  if (matches.length > 1) return failed('ORCHESTRATION_DELEGATION_AMBIGUOUS', 'multiple lifecycle delegations match the native hook event');
  return matches[0]!;
}

function hasActivatableOrchestrationDelegation(
  client: AgentClientId,
  childId: string,
  options: OrchestrationOptions = {}
): boolean {
  return matchingDelegations(
    (receipt) => receipt.client === client && (
      receipt.status === 'prepared'
      || (receipt.childId === childId && ['activated', 'stage-completed'].includes(receipt.status))
    ),
    options
  ).length > 0;
}

function hasSealableOrchestrationDelegation(
  client: AgentClientId,
  childId: string,
  options: OrchestrationOptions = {}
): boolean {
  return matchingDelegations(
    (receipt) => receipt.client === client
      && receipt.childId === childId
      && ['stage-completed', 'sealed'].includes(receipt.status),
    options
  ).length > 0;
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
  if ('status' in matched) {
    if (matched.error?.code !== 'ORCHESTRATION_DELEGATION_MISSING') return matched;
    const replay = uniqueMatchingDelegation(
      client,
      (receipt) => receipt.childId === event.childId && ['activated', 'stage-completed'].includes(receipt.status),
      options
    );
    if ('status' in replay) return matched;
    const receipt = replay.run.pendingDelegation!;
    const sameEvidence = receipt.parentId === event.parentId
      && (receipt.spawnMode ?? null) === (event.spawnMode ?? null)
      && (receipt.actualModel ?? null) === foldBlankToNull(event.actualModel)
      && (receipt.actualReasoningEffort ?? null) === foldBlankToNull(event.actualReasoningEffort)
      && receipt.modelFallbackReason === (event.modelFallbackReason ?? null)
      && receipt.reasoningEffortFallbackReason === (event.reasoningEffortFallbackReason ?? null)
      && receipt.hostEvidence?.hookDefinitionHash === event.hostEvidence?.hookDefinitionHash;
    if (!sameEvidence) {
      return pauseOrchestration(replay.taskId, 'DELEGATION_REPLAY_CONFLICT', 'replayed native start evidence conflicts with the active receipt', true, options);
    }
    return { status: replay.run.status, changed: false, taskId: replay.taskId, run: replay.run, next: null, error: null };
  }
  if (matched.run.receipts.some((receipt) => receipt.childId === event.childId)) {
    return pauseOrchestration(matched.taskId, 'DELEGATION_IDENTITY_REUSED', 'native child identity was already used by this run', true, options);
  }
  return activateOrchestrationDelegation(matched.taskId, event, options);
}

function pauseMatchingOrchestrationDelegation(
  client: AgentClientId,
  code: string,
  message: string,
  options: OrchestrationOptions = {}
): OrchestrationResult {
  const matched = uniqueMatchingDelegation(client, () => true, options);
  if ('status' in matched) return matched;
  return pauseOrchestration(matched.taskId, code, message, true, options);
}

function sealMatchingOrchestrationDelegation(
  client: AgentClientId,
  event: Readonly<{
    nativeAgent: string;
    childId: string;
    actualModel?: string;
    actualReasoningEffort?: string;
    modelFallbackReason?: string;
    reasoningEffortFallbackReason?: string;
  }>,
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
    const gitRoot = gitRootFor(repoRoot, options);
    const snapshotTaskId = receipt.workspaceSnapshotScope === 'task' ? receipt.taskId : null;
    const afterFingerprint = (options.captureWorkspace ?? captureWorkspaceSnapshot)({
      gitRoot,
      stateRoot: repoRoot,
      taskId: snapshotTaskId
    });
    const changedPaths = (options.diffWorkspace ?? diffWorkspaceSnapshots)(gitRoot, receipt.beforeFingerprint, afterFingerprint);
    return sealOrchestrationDelegation(matched.taskId, {
      childId: event.childId,
      exitCode: 0,
      afterFingerprint,
      changedPaths,
      actualModel: event.actualModel,
      actualReasoningEffort: event.actualReasoningEffort,
      modelFallbackReason: event.modelFallbackReason,
      reasoningEffortFallbackReason: event.reasoningEffortFallbackReason
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

function sealMatchingOrchestrationDelegationWithHostEvidence(
  client: AgentClientId,
  event: Readonly<{ nativeAgent: string; childId: string }>,
  consumeEvidence: (receipt: DelegationReceipt) => Readonly<{
    stopRevision: number;
    consumer: string;
    consumedAt: string;
  }>,
  options: OrchestrationOptions = {}
): OrchestrationResult {
  const role = managedDelegationRole(event.nativeAgent);
  if (!role) return failed('DELEGATION_IGNORED', `subagent '${event.nativeAgent}' is not lifecycle-managed`);
  const matched = uniqueMatchingDelegation(
    client,
    (receipt) => (
      (receipt.status === 'stage-completed' || receipt.status === 'sealed')
      && receipt.childId === event.childId
    ),
    options
  );
  if ('status' in matched) return matched;
  const receipt = matched.run.pendingDelegation!;
  if (receipt.status === 'sealed') {
    return reconcileMatchingOrchestrationDelegation(client, event.childId, options);
  }
  if (receipt.role !== role) {
    return pauseOrchestration(matched.taskId, 'DELEGATION_ROLE_MISMATCH', `managed role ${role} does not match ${receipt.role}`, true, options);
  }
  const repoRoot = options.repoRoot ?? process.cwd();
  try {
    const gitRoot = gitRootFor(repoRoot, options);
    const snapshotTaskId = receipt.workspaceSnapshotScope === 'task' ? receipt.taskId : null;
    const afterFingerprint = (options.captureWorkspace ?? captureWorkspaceSnapshot)({
      gitRoot,
      stateRoot: repoRoot,
      taskId: snapshotTaskId
    });
    const changedPaths = (options.diffWorkspace ?? diffWorkspaceSnapshots)(gitRoot, receipt.beforeFingerprint, afterFingerprint);
    const baseEvent = { childId: event.childId, exitCode: 0, afterFingerprint, changedPaths };
    const validated = sealDelegation(receipt, baseEvent, { now: options.now, requireHostEvidence: false });
    if (!validated.ok) {
      return pauseOrchestration(matched.taskId, validated.code, validated.message, true, options);
    }
    const hostEvidence = consumeEvidence(receipt);
    const sealed = sealDelegation(receipt, { ...baseEvent, hostEvidence }, { now: options.now });
    if (!sealed.ok) return pauseOrchestration(matched.taskId, sealed.code, sealed.message, true, options);
    const resolved = resolveTaskRef(matched.taskId, { repoRoot });
    if (!resolved.ok) return failed(resolved.code, resolved.message, resolved.taskId);
    const updated = withUpdatedRun(matched.run, { pendingDelegation: sealed.receipt }, options.now);
    saveRun(resolved.taskDir, updated);
    return { status: 'running', changed: true, taskId: matched.taskId, run: updated, next: null, error: null };
  } catch (error) {
    return pauseOrchestration(
      matched.taskId,
      'ORCHESTRATION_CODEX_EVIDENCE_FAILED',
      error instanceof Error ? error.message : String(error),
      true,
      options
    );
  }
}

function reconcileMatchingOrchestrationDelegation(
  client: AgentClientId,
  childId: string,
  options: OrchestrationOptions = {}
): OrchestrationResult {
  const matched = uniqueMatchingDelegation(
    client,
    (receipt) => receipt.childId === childId,
    options
  );
  if ('status' in matched) return matched;
  const receipt = matched.run.pendingDelegation!;
  if (
    receipt.status !== 'sealed'
    || receipt.hostEvidence?.consumer !== receipt.id
    || receipt.hostEvidence.consumedAt === null
  ) {
    return pauseOrchestration(
      matched.taskId,
      'ORCHESTRATION_CODEX_RECONCILIATION_FAILED',
      'Codex native spawn did not produce one sealed receipt with consumed host evidence',
      true,
      options
    );
  }
  return { status: matched.run.status, changed: false, taskId: matched.taskId, run: matched.run, next: null, error: null };
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
  if (run.status !== 'running') {
    return { status: run.status, changed: false, taskId: resolved.taskId, run, next: null, error: null };
  }
  const result = activateDelegation(run.pendingDelegation, event, {
    now: options.now,
    monotonicNow: options.monotonicNow
  });
  if (!result.ok) {
    if (result.code === 'DELEGATION_IGNORED') return { status: run.status, changed: false, taskId: resolved.taskId, run, next: null, error: null };
    return pauseOrchestration(taskRef, result.code, result.message, true, options);
  }
  const updated = withUpdatedRun(run, { pendingDelegation: result.receipt });
  saveRun(resolved.taskDir, updated);
  return {
    status: 'running',
    changed: true,
    taskId: resolved.taskId,
    run: updated,
    next: null,
    ...(result.warnings ? { warnings: result.warnings } : {}),
    error: null
  };
}

async function awaitOrchestrationDelegationActivation(
  taskRef: string,
  event: OrchestrationStageIdentity,
  options: OrchestrationOptions = {}
): Promise<OrchestrationResult> {
  const sleep = options.sleep
    ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  while (true) {
    const resolved = resolveTaskRef(taskRef, { repoRoot: options.repoRoot });
    if (!resolved.ok) return failed(resolved.code, resolved.message, resolved.taskId);
    const run = readRun(resolved.taskDir);
    if (!run?.pendingDelegation) {
      return failed('ORCHESTRATION_DELEGATION_MISSING', 'no pending delegation exists', resolved.taskId);
    }
    const receipt = run.pendingDelegation;
    const matches = receipt.stage === event.stage
      && receipt.round === event.round
      && receipt.artifact === event.artifact
      && receipt.role === event.role;
    if (!matches) {
      return pauseOrchestration(
        taskRef,
        'ORCHESTRATION_PROVENANCE_MISMATCH',
        'activation barrier identity does not match the pending delegation',
        true,
        options
      );
    }
    if (receipt.status === 'activated' || receipt.status === 'stage-completed') {
      return { status: run.status, changed: false, taskId: resolved.taskId, run, next: null, error: null };
    }
    if (run.status !== 'running') {
      return { status: run.status, changed: false, taskId: resolved.taskId, run, next: null, error: null };
    }
    if (receipt.status !== 'prepared') {
      return pauseOrchestration(
        taskRef,
        'ORCHESTRATION_ACTIVATION_STATE_INVALID',
        `activation barrier found receipt status '${receipt.status}'`,
        true,
        options
      );
    }
    if (
      receipt.activationDeadlineAt == null
      || !Number.isFinite(Date.parse(receipt.activationDeadlineAt))
    ) {
      return pauseOrchestration(
        taskRef,
        'ORCHESTRATION_DELEGATION_NOT_DISPATCHED',
        'activation barrier was entered before the native spawn dispatch boundary',
        true,
        options
      );
    }
    if (Date.parse((options.now ?? (() => new Date().toISOString()))()) >= Date.parse(receipt.activationDeadlineAt)) {
      return pauseOrchestration(
        taskRef,
        'ORCHESTRATION_ACTIVATION_TIMEOUT',
        'fresh child did not receive trusted activation evidence before the deadline',
        true,
        options
      );
    }
    await sleep(100);
  }
}

function recoverPreparedOrchestrationDelegation(
  taskRef: string,
  options: OrchestrationOptions = {}
): OrchestrationResult {
  const resolved = resolveTaskRef(taskRef, { repoRoot: options.repoRoot });
  if (!resolved.ok) return failed(resolved.code, resolved.message, resolved.taskId);
  try {
    return withTaskExecutionLock(resolved.repoRoot, resolved.taskId, 'task-orchestration.recover-prepared', () => {
      const run = readRun(resolved.taskDir);
      const receipt = run?.pendingDelegation;
      if (!run || !receipt) {
        return failed('ORCHESTRATION_DELEGATION_MISSING', 'no pending delegation exists', resolved.taskId);
      }
      if (receipt.status !== 'prepared') {
        return failed('ORCHESTRATION_PREPARED_RECOVERY_UNSAFE', 'only a never-activated prepared receipt can recover', resolved.taskId);
      }
      const wallNow = Date.parse((options.now ?? (() => new Date().toISOString()))());
      if (
        receipt.activationDeadlineAt != null
        && Number.isFinite(Date.parse(receipt.activationDeadlineAt))
        && wallNow <= Date.parse(receipt.activationDeadlineAt)
      ) {
        return failed('ORCHESTRATION_PREPARED_RECOVERY_EARLY', 'prepared receipt activation deadline has not elapsed', resolved.taskId);
      }
      const activeLifecycleEvidence = options.hasActiveLifecycleEvidence?.(receipt)
        ?? (
          receipt.client === 'codex'
          && receipt.lifecycleProvenance
          && hasActiveCodexLifecycleEvidence(
          resolveAgentRuntimeStoreRoot({ repoRoot: resolved.repoRoot, store: 'lifecycle' }),
            {
              nativeAgent: `agent-infra-lifecycle-${receipt.role}`,
              hookDefinitionHash: receipt.lifecycleProvenance.hookDefinitionHash
            }
          )
        );
      if (activeLifecycleEvidence) {
        return failed(
          'ORCHESTRATION_PREPARED_RECOVERY_ACTIVE_EVIDENCE',
          'active Codex lifecycle evidence blocks prepared receipt recovery',
          resolved.taskId
        );
      }
      const current = (options.captureWorkspace ?? captureWorkspaceSnapshot)({
        gitRoot: gitRootFor(resolved.repoRoot, options),
        stateRoot: resolved.repoRoot,
        taskId: receipt.workspaceSnapshotScope === 'task' ? receipt.taskId : null
      });
      if (current !== receipt.beforeFingerprint) {
        return failed('ORCHESTRATION_PREPARED_RECOVERY_DRIFT', 'workspace changed after delegation preparation', resolved.taskId);
      }
      const aborted = abortPreparedDelegation(receipt);
      if (!aborted.ok) return failed(aborted.code, aborted.message, resolved.taskId);
      const updated = withUpdatedRun(run, {
        status: 'running',
        pause: null,
        nextStage: null,
        pendingDelegation: null,
        receipts: Object.freeze([...run.receipts, aborted.receipt])
      }, options.now);
      saveRun(resolved.taskDir, updated);
      return { status: 'running', changed: true, taskId: resolved.taskId, run: updated, next: null, error: null };
    });
  } catch (error) {
    if (error instanceof TaskExecutionLockError) return failed(error.code, error.message, resolved.taskId);
    return failed(
      'ORCHESTRATION_PREPARED_RECOVERY_FAILED',
      error instanceof Error ? error.message : String(error),
      resolved.taskId
    );
  }
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
  awaitOrchestrationDelegationActivation,
  advanceOrchestration,
  beginOrResumeOrchestration,
  commitOrchestrationStageCompletion,
  completeOrchestrationStage,
  dispatchOrchestrationDelegation,
  inspectOrchestrationStage,
  hasActivatableOrchestrationDelegation,
  hasSealableOrchestrationDelegation,
  OrchestrationStateError,
  orchestrationPath,
  pauseMatchingOrchestrationDelegation,
  pauseOrchestration,
  planOrchestrationStageCompletion,
  prepareOrchestrationDelegation,
  readRun,
  reconcileMatchingOrchestrationDelegation,
  recoverPreparedOrchestrationDelegation,
  routeOrchestration,
  sealMatchingOrchestrationDelegation,
  sealMatchingOrchestrationDelegationWithHostEvidence,
  sealOrchestrationDelegation,
  statusOrchestration,
};
export type {
  OrchestrationCompletionPlanResult,
  OrchestrationModelPolicy,
  OrchestrationNext,
  OrchestrationResult,
  OrchestrationRun,
  OrchestrationStageCompletion,
  OrchestrationStageIdentity,
  OrchestrationStatus,
  OrchestrationOptions
};
