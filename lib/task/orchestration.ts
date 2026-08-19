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
  abortPreparedDelegation,
  completeDelegationStage,
  consumeDelegation,
  dispatchDelegation,
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
import {
  CommitIntentError,
  commitIntentPath,
  createCommitIntent,
  digest,
  readCommitIntent,
  removeCommitIntent,
  removeCommitIntentByDigest,
  serialize,
  updateCommitIntent
} from './commit-intent.ts';
import type { CommitIntent, PushEvidence } from './commit-intent.ts';
import {
  inspectCommitFinalization,
  planCommitTaskFinalization
} from './commit-finalization.ts';
import type { CommitFinalizationInspection } from './commit-finalization.ts';
import { captureTaskWriteMetadata, writeTask } from './write.ts';
import {
  appendActivityEntry,
  commitAttemptStartedNote,
  locateActivityLog,
  pairEntries
} from './activity-log.ts';

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
type ModelPolicyRecovery = Readonly<{
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
type ClientCapabilityRecovery = Readonly<{
  code: 'CLIENT_CAPABILITY_ENABLED';
  recoveredAt: string;
  previousSchemaVersion: 2;
  previousStatus: 'paused';
  previousPause: Readonly<{ code: 'ORCHESTRATION_CLIENT_UNSUPPORTED'; message: string; recoverable: boolean }>;
  client: 'codex';
  guards: Readonly<{
    stepCount: 0;
    nextStage: null;
    baselineEmpty: true;
    receiptCount: 0;
    pendingDelegation: false;
    commitAuthorizationUnused: true;
    completionEvidenceAbsent: true;
    commitIntentAbsent: true;
  }>;
  resultingStatus: 'running';
}>;
type SchemaMigrationRecovery = Readonly<{
  code: 'SCHEMA_V3_MIGRATED';
  recoveredAt: string;
  previousSchemaVersion: 2;
  previousStatus: 'paused';
  previousPause: Readonly<{ code: string; message: string; recoverable: boolean }>;
  guards: Readonly<{
    stepCount: 0;
    nextStage: null;
    baselineEmpty: true;
    receiptCount: 0;
    pendingDelegation: false;
    commitAuthorizationUnused: true;
    completionEvidenceAbsent: true;
    commitIntentAbsent: true;
  }>;
  resultingStatus: 'running';
}>;
type OrchestrationRecovery = ModelPolicyRecovery | ClientCapabilityRecovery | SchemaMigrationRecovery;
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
  schemaVersion: 1 | 2 | 3;
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
  token?: () => string;
  monotonicNow?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  hasActiveLifecycleEvidence?: (receipt: DelegationReceipt) => boolean;
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
  finalization?: Readonly<{
    disposition: CommitFinalizationInspection['disposition'];
    code: CommitFinalizationInspection['code'];
    message: string;
    currentHead: string;
    committedHead: string | null;
    needsAnchor: boolean;
    needsLog: boolean;
    attempt: Readonly<{ attempt: string; baseline: string; agent: string }> | null;
  }>;
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
  if (![2, 3].includes(run.schemaVersion) || !isV2Policy(run.modelPolicy)) return run;
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

function gitRootFor(stateRoot: string, options: OrchestrationOptions): string {
  if (!options.gitWorktreeRoot) return stateRoot;
  return assertGitRepositoryBinding(stateRoot, options.gitWorktreeRoot).worktreeRoot;
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

function commitFinalizationView(inspection: CommitFinalizationInspection): NonNullable<CommitIntentResult['finalization']> {
  return {
    disposition: inspection.disposition,
    code: inspection.code,
    message: inspection.message,
    currentHead: inspection.currentHead,
    committedHead: inspection.committedHead,
    needsAnchor: inspection.needsAnchor,
    needsLog: inspection.needsLog,
    attempt: inspection.attempt
  };
}

function validCommitRun(run: OrchestrationRun | null, taskId: string): run is OrchestrationRun {
  return run !== null
    && [1, 2, 3].includes(run.schemaVersion)
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

function canRecoverCodexUnsupportedPause(run: OrchestrationRun, taskDir: string): boolean {
  return run.schemaVersion === 2
    && run.status === 'paused'
    && run.pause?.code === 'ORCHESTRATION_CLIENT_UNSUPPORTED'
    && run.modelPolicySource?.client === 'codex'
    && run.stepCount === 0
    && run.nextStage === null
    && run.baseline === ''
    && run.pendingDelegation === null
    && run.receipts.length === 0
    && run.commitAuthorization?.issuedAt === null
    && run.commitAuthorization?.consumedAt === null
    && run.completionEvidence == null
    && !fs.existsSync(commitIntentPath(taskDir))
    && (run.recoveryHistory ?? []).every((entry) => entry.code === 'MODEL_POLICY_SUPPLEMENTED');
}

function canMigrateRecoverableV2Pause(run: OrchestrationRun, taskDir: string): boolean {
  return run.schemaVersion === 2
    && run.status === 'paused'
    && run.pause?.recoverable === true
    && run.stepCount === 0
    && run.nextStage === null
    && run.baseline === ''
    && run.pendingDelegation === null
    && run.receipts.length === 0
    && run.commitAuthorization?.issuedAt === null
    && run.commitAuthorization?.consumedAt === null
    && run.completionEvidence == null
    && !fs.existsSync(commitIntentPath(taskDir));
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
      ![1, 2, 3].includes(existing.schemaVersion)
      || !Array.isArray(existing.receipts)
      || !Object.prototype.hasOwnProperty.call(existing, 'pendingDelegation')
    ) {
      return failed('ORCHESTRATION_STATE_INVALID', 'orchestration state has an invalid schema', resolved.taskId);
    }
    if (existing.status === 'completed' && existing.schemaVersion === 1) {
      return { status: 'completed', changed: false, taskId: resolved.taskId, run: existing, next: null, error: null };
    }
    if (existing.schemaVersion === 2 || existing.schemaVersion === 3) {
      const policyError = validateModelPolicy(isV2Policy(existing.modelPolicy) ? existing.modelPolicy : undefined);
      if (
        policyError
        || !existing.modelPolicySource
        || !isAgentClientId(existing.modelPolicySource.client)
        || !Array.isArray(existing.recoveryHistory)
      ) {
        return failed('ORCHESTRATION_STATE_INVALID', `schemaVersion ${existing.schemaVersion} orchestration state is incomplete`, resolved.taskId);
      }
      if (existing.status === 'completed') {
        return { status: 'completed', changed: false, taskId: resolved.taskId, run: existing, next: null, error: null };
      }
      if (existing.schemaVersion === 2 && existing.status === 'running') {
        return failed(
          'ORCHESTRATION_STATE_INVALID',
          'active schemaVersion 2 runs cannot be advanced by lifecycle protocol v3',
          resolved.taskId
        );
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
      if (existing.status === 'paused' && existing.pause?.code === 'ORCHESTRATION_CLIENT_UNSUPPORTED') {
        if (!canRecoverCodexUnsupportedPause(existing, resolved.taskDir)) {
          return { status: 'paused', changed: false, taskId: resolved.taskId, run: existing, next: null, error: null };
        }
        const now = (options.now ?? (() => new Date().toISOString()))();
        const previousPause = existing.pause as ClientCapabilityRecovery['previousPause'];
        const recovery: ClientCapabilityRecovery = {
          code: 'CLIENT_CAPABILITY_ENABLED',
          recoveredAt: now,
          previousSchemaVersion: 2,
          previousStatus: 'paused',
          previousPause,
          client: 'codex',
          guards: {
            stepCount: 0,
            nextStage: null,
            baselineEmpty: true,
            receiptCount: 0,
            pendingDelegation: false,
            commitAuthorizationUnused: true,
            completionEvidenceAbsent: true,
            commitIntentAbsent: true
          },
          resultingStatus: 'running'
        };
        const resumed = withUpdatedRun(existing, {
          schemaVersion: 3,
          status: 'running',
          pause: null,
          recoveryHistory: Object.freeze([...(existing.recoveryHistory ?? []), recovery])
        }, () => now);
        saveRun(resolved.taskDir, resumed);
        return { status: 'running', changed: true, taskId: resolved.taskId, run: resumed, next: null, error: null };
      }
      if (existing.status === 'paused' && existing.pause?.recoverable && existing.pendingDelegation === null) {
        if (existing.schemaVersion === 2 && !canMigrateRecoverableV2Pause(existing, resolved.taskDir)) {
          const paused = withUpdatedRun(existing, {
            pause: {
              code: 'ORCHESTRATION_SCHEMA_MIGRATION_REQUIRED',
              message: 'schemaVersion 2 recoverable pause contains execution evidence and cannot migrate automatically',
              recoverable: false
            }
          });
          saveRun(resolved.taskDir, paused);
          return { status: 'paused', changed: true, taskId: resolved.taskId, run: paused, next: null, error: null };
        }
        const now = (options.now ?? (() => new Date().toISOString()))();
        const recovery: SchemaMigrationRecovery | null = existing.schemaVersion === 2 ? {
          code: 'SCHEMA_V3_MIGRATED',
          recoveredAt: now,
          previousSchemaVersion: 2,
          previousStatus: 'paused',
          previousPause: existing.pause,
          guards: {
            stepCount: 0,
            nextStage: null,
            baselineEmpty: true,
            receiptCount: 0,
            pendingDelegation: false,
            commitAuthorizationUnused: true,
            completionEvidenceAbsent: true,
            commitIntentAbsent: true
          },
          resultingStatus: 'running'
        } : null;
        const resumed = withUpdatedRun(existing, {
          schemaVersion: 3,
          status: 'running',
          pause: null,
          ...(recovery ? { recoveryHistory: Object.freeze([...(existing.recoveryHistory ?? []), recovery]) } : {})
        }, () => now);
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
      schemaVersion: 3,
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
    schemaVersion: 3,
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

function appendCommitActivity(
  resolved: Extract<ReturnType<typeof resolveTaskRef>, { ok: true }>,
  step: string,
  agent: string,
  note: string
): Readonly<{ code: string; message: string }> | null {
  const taskContent = fs.readFileSync(resolved.taskMdPath, 'utf8');
  const activity = locateActivityLog(taskContent);
  if (!activity) return { code: 'ORCHESTRATION_TASK_INVALID', message: 'task activity log is missing or ambiguous' };
  const metadata = captureTaskWriteMetadata();
  const written = writeTask({
    taskRef: resolved.taskId,
    expectedState: 'active',
    mutations: [{
      kind: 'section',
      aliases: ['活动日志', 'Activity Log'],
      heading: activity.heading,
      body: appendActivityEntry(activity, { time: metadata.timestamp, step, agent, note })
    }]
  }, { repoRoot: resolved.repoRoot, metadataProvider: () => metadata });
  return written.status === 'failed' ? written.error : null;
}

function startCommitAttempt(
  taskRef: string,
  input: Readonly<{ agent: string }>,
  options: OrchestrationOptions = {}
): CommitIntentResult {
  const resolved = resolveTaskRef(taskRef, { repoRoot: options.repoRoot });
  if (!resolved.ok) return commitIntentFailed(resolved.code, resolved.message, resolved.taskId);
  try {
    const gitRoot = gitRootFor(resolved.repoRoot, options);
    return withTaskExecutionLock(resolved.repoRoot, resolved.taskId, 'commit-attempt.start', () => {
      if (fs.existsSync(commitIntentPath(resolved.taskDir))) {
        return commitIntentFailed('ORCHESTRATION_COMMIT_INTENT_BUSY', 'an active commit intent already exists', resolved.taskId);
      }
      const taskContent = fs.readFileSync(resolved.taskMdPath, 'utf8');
      const activity = locateActivityLog(taskContent);
      if (!activity) return commitIntentFailed('ORCHESTRATION_TASK_INVALID', 'task activity log is missing or ambiguous', resolved.taskId);
      const open = pairEntries(activity.entries).filter((row) => row.step === 'Commit' && row.started !== '' && row.done === '');
      if (open.length > 0) {
        return commitIntentFailed('ORCHESTRATION_COMMIT_ATTEMPT_BUSY', 'an open Commit activity entry already exists', resolved.taskId);
      }
      const currentHead = repositoryHead(gitRoot);
      const attempt = (options.id ?? randomUUID)();
      const error = appendCommitActivity(resolved, 'Commit [started]', input.agent, commitAttemptStartedNote({
        attempt,
        baseline: currentHead,
        agent: input.agent
      }));
      if (error) return commitIntentFailed(error.code, error.message, resolved.taskId);
      const inspection = inspectCommitFinalization(resolved.taskDir, gitRoot, resolved.taskId);
      return {
        status: 'ready', changed: true, taskId: resolved.taskId, intent: null,
        finalization: commitFinalizationView(inspection), error: null
      };
    });
  } catch (error) {
    return mapCommitIntentError(error, resolved.taskId);
  }
}

function terminateCommitAttempt(
  taskRef: string,
  input: Readonly<{ attempt: string; agent: string; code: string }>,
  options: OrchestrationOptions = {}
): CommitIntentResult {
  const resolved = resolveTaskRef(taskRef, { repoRoot: options.repoRoot });
  if (!resolved.ok) return commitIntentFailed(resolved.code, resolved.message, resolved.taskId);
  try {
    const gitRoot = gitRootFor(resolved.repoRoot, options);
    return withTaskExecutionLock(resolved.repoRoot, resolved.taskId, 'commit-attempt.terminate', () => {
      if (fs.existsSync(commitIntentPath(resolved.taskDir))) {
        return commitIntentFailed('ORCHESTRATION_COMMIT_RECOVERY_REQUIRED', 'an active commit intent must be aborted or recovered first', resolved.taskId);
      }
      const inspection = inspectCommitFinalization(resolved.taskDir, gitRoot, resolved.taskId);
      if (
        inspection.disposition !== 'retryable-start'
        || inspection.attempt?.attempt !== input.attempt
        || inspection.attempt.agent !== input.agent
        || inspection.attempt.baseline !== inspection.currentHead
      ) {
        return commitIntentFailed('ORCHESTRATION_COMMIT_RECOVERY_REQUIRED', 'commit attempt identity or repository HEAD has drifted', resolved.taskId);
      }
      const error = appendCommitActivity(
        resolved,
        'Commit [aborted]',
        input.agent,
        `aborted; attempt=${input.attempt}; code=${input.code}`
      );
      if (error) return commitIntentFailed(error.code, error.message, resolved.taskId);
      return {
        status: 'ready', changed: true, taskId: resolved.taskId, intent: null,
        finalization: commitFinalizationView(inspectCommitFinalization(resolved.taskDir, gitRoot, resolved.taskId)),
        error: null
      };
    });
  } catch (error) {
    return mapCommitIntentError(error, resolved.taskId);
  }
}

function beginCommitIntent(
  taskRef: string,
  input: Readonly<{ agent: string; orchestrated: boolean; baselineHead: string; attempt: string }>,
  options: OrchestrationOptions = {}
): CommitIntentResult {
  const resolved = resolveTaskRef(taskRef, { repoRoot: options.repoRoot });
  if (!resolved.ok) return commitIntentFailed(resolved.code, resolved.message, resolved.taskId);
  try {
    const gitRoot = gitRootFor(resolved.repoRoot, options);
    return withTaskExecutionLock(resolved.repoRoot, resolved.taskId, 'commit-intent.begin', () => {
      const currentHead = repositoryHead(gitRoot);
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
      const attemptInspection = inspectCommitFinalization(resolved.taskDir, gitRoot, resolved.taskId);
      if (
        attemptInspection.disposition !== 'retryable-start'
        || attemptInspection.attempt?.attempt !== input.attempt
        || attemptInspection.attempt.agent !== input.agent
        || attemptInspection.attempt.baseline !== input.baselineHead
      ) {
        return commitIntentFailed(
          'ORCHESTRATION_COMMIT_ATTEMPT_MISMATCH',
          'commit begin requires one matching retryable Commit attempt',
          resolved.taskId
        );
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
    const gitRoot = gitRootFor(resolved.repoRoot, options);
    return withTaskExecutionLock(resolved.repoRoot, resolved.taskId, 'commit-intent.checkpoint', () => {
      const intent = readCommitIntent(resolved.taskDir, resolved.taskId, input.token);
      const currentHead = repositoryHead(gitRoot);
      if (currentHead !== input.head) {
        return commitIntentFailed('ORCHESTRATION_COMMIT_RECOVERY_REQUIRED', 'checkpoint HEAD does not match the repository HEAD', resolved.taskId);
      }
      if (input.kind === 'committed' && !isAncestor(gitRoot, intent.baselineHead, input.head)) {
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
            phase: 'pushed', committedHead: intent.committedHead ?? intent.baselineHead, updatedAt: now,
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

function completeCommitOrchestration(
  resolved: Extract<ReturnType<typeof resolveTaskRef>, { ok: true }>,
  intent: CommitIntent,
  agent: string
): Readonly<{ code: string; message: string }> | null {
  if (intent.orchestration === null) return null;
  if (intent.orchestration.plannedReceipt.agent !== agent) {
    return { code: 'ORCHESTRATION_PROVENANCE_MISMATCH', message: 'completion agent does not match the planned receipt' };
  }
  const runFile = orchestrationPath(resolved.taskDir);
  if (!fs.existsSync(runFile)) {
    return { code: 'ORCHESTRATION_RUN_MISSING', message: 'orchestration run disappeared' };
  }
  const currentBytes = fs.readFileSync(runFile, 'utf8');
  const currentDigest = digest(currentBytes);
  if (currentDigest === intent.orchestration.sourceRunDigest) {
    const run = readRun(resolved.taskDir);
    if (!run) return { code: 'ORCHESTRATION_RUN_MISSING', message: 'orchestration run disappeared' };
    const plannedRun: OrchestrationRun = Object.freeze({
      ...run,
      pendingDelegation: intent.orchestration.plannedReceipt,
      updatedAt: intent.orchestration.completionUpdatedAt
    });
    if (digest(serialize(plannedRun)) !== intent.orchestration.plannedRunDigest) {
      return { code: 'ORCHESTRATION_COMMIT_RECOVERY_REQUIRED', message: 'planned orchestration bytes no longer match the intent' };
    }
    atomicWrite(runFile, plannedRun);
    if (digest(fs.readFileSync(runFile)) !== intent.orchestration.plannedRunDigest) {
      return { code: 'ORCHESTRATION_COMMIT_COMPLETE_PARTIAL', message: 'orchestration completion could not be verified' };
    }
  } else if (currentDigest !== intent.orchestration.plannedRunDigest) {
    return { code: 'ORCHESTRATION_COMMIT_RECOVERY_REQUIRED', message: 'orchestration state changed after commit begin' };
  }
  return null;
}

function finalizeCommitIntentUnlocked(
  resolved: Extract<ReturnType<typeof resolveTaskRef>, { ok: true }>,
  inspection: CommitFinalizationInspection,
  agent: string,
  remove: () => void
): CommitIntentResult {
  if (inspection.disposition !== 'recoverable' || !inspection.intent) {
    return commitIntentFailed(
      inspection.code ?? 'COMMIT_FINALIZATION_PENDING',
      inspection.message,
      resolved.taskId
    );
  }
  if (
    inspection.intent.orchestration !== null
    && inspection.intent.orchestration.plannedReceipt.agent !== agent
  ) {
    return commitIntentFailed(
      'ORCHESTRATION_PROVENANCE_MISMATCH',
      'completion agent does not match the planned receipt',
      resolved.taskId
    );
  }
  const metadata = captureTaskWriteMetadata();
  const taskPlan = planCommitTaskFinalization(
    resolved.taskDir,
    inspection,
    agent,
    metadata.timestamp
  );
  const written = writeTask({
    taskRef: resolved.taskId,
    expectedState: 'active',
    mutations: taskPlan.mutations
  }, {
    repoRoot: resolved.repoRoot,
    metadataProvider: () => metadata
  });
  if (written.status === 'failed') {
    return commitIntentFailed(written.error.code, written.error.message, resolved.taskId);
  }
  const orchestrationError = completeCommitOrchestration(resolved, inspection.intent, agent);
  if (orchestrationError) {
    return commitIntentFailed(orchestrationError.code, orchestrationError.message, resolved.taskId);
  }
  try {
    remove();
  } catch (error) {
    return commitIntentFailed(
      'ORCHESTRATION_COMMIT_COMPLETE_PARTIAL',
      error instanceof Error ? error.message : String(error),
      resolved.taskId
    );
  }
  return { status: 'ready', changed: true, taskId: resolved.taskId, intent: null, error: null };
}

function completeCommitIntent(
  taskRef: string,
  input: Readonly<{ token: string; agent: string }>,
  options: OrchestrationOptions = {}
): CommitIntentResult {
  const resolved = resolveTaskRef(taskRef, { repoRoot: options.repoRoot });
  if (!resolved.ok) return commitIntentFailed(resolved.code, resolved.message, resolved.taskId);
  try {
    const gitRoot = gitRootFor(resolved.repoRoot, options);
    return withTaskExecutionLock(resolved.repoRoot, resolved.taskId, 'commit-intent.complete', () => {
      readCommitIntent(resolved.taskDir, resolved.taskId, input.token);
      const inspection = inspectCommitFinalization(resolved.taskDir, gitRoot, resolved.taskId);
      return finalizeCommitIntentUnlocked(resolved, inspection, input.agent, () => {
        removeCommitIntent(resolved.taskDir, resolved.taskId, input.token);
      });
    });
  } catch (error) {
    return mapCommitIntentError(error, resolved.taskId);
  }
}

function recoverCommitIntent(
  taskRef: string,
  input: Readonly<{ agent: string }>,
  options: OrchestrationOptions = {}
): CommitIntentResult {
  const resolved = resolveTaskRef(taskRef, { repoRoot: options.repoRoot });
  if (!resolved.ok) return commitIntentFailed(resolved.code, resolved.message, resolved.taskId);
  try {
    const gitRoot = gitRootFor(resolved.repoRoot, options);
    return withTaskExecutionLock(resolved.repoRoot, resolved.taskId, 'commit-intent.recover', () => {
      const inspection = inspectCommitFinalization(resolved.taskDir, gitRoot, resolved.taskId);
      if (inspection.disposition === 'retryable-start') {
        return {
          status: 'ready', changed: false, taskId: resolved.taskId, intent: null,
          finalization: commitFinalizationView(inspection), error: null
        };
      }
      if (inspection.disposition === 'prepared' && inspection.intentDigest) {
        removeCommitIntentByDigest(resolved.taskDir, resolved.taskId, inspection.intentDigest);
        return { status: 'ready', changed: true, taskId: resolved.taskId, intent: null, error: null };
      }
      if (!inspection.intentDigest) {
        return commitIntentFailed(
          inspection.code ?? 'COMMIT_FINALIZATION_EVIDENCE_MISSING',
          inspection.message,
          resolved.taskId
        );
      }
      return finalizeCommitIntentUnlocked(resolved, inspection, input.agent, () => {
        removeCommitIntentByDigest(resolved.taskDir, resolved.taskId, inspection.intentDigest!);
      });
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
    const gitRoot = gitRootFor(resolved.repoRoot, options);
    return withTaskExecutionLock(resolved.repoRoot, resolved.taskId, 'commit-intent.abort', () => {
      const intent = readCommitIntent(resolved.taskDir, resolved.taskId, input.token);
      const currentHead = repositoryHead(gitRoot);
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
  let gitRoot: string;
  try {
    gitRoot = gitRootFor(resolved.repoRoot, options);
  } catch (error) {
    return commitIntentFailed('ORCHESTRATION_WORKTREE_INVALID', error instanceof Error ? error.message : String(error), resolved.taskId);
  }
  const inspection = inspectCommitFinalization(resolved.taskDir, gitRoot, resolved.taskId);
  return {
    status: 'ready',
    changed: false,
    taskId: resolved.taskId,
    intent: inspection.intent ? commitIntentView(inspection.intent, inspection.currentHead) : null,
    finalization: commitFinalizationView(inspection),
    error: null
  };
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
  if (run.schemaVersion !== 3) {
    return failed('ORCHESTRATION_STATE_INVALID', 'delegation preparation requires orchestration schemaVersion 3', resolved.taskId);
  }
  if (!isV2Policy(run.modelPolicy)) return failed('ORCHESTRATION_MODEL_EVIDENCE_MISSING', 'running orchestration has no persisted model policy', resolved.taskId);
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
  if (run.schemaVersion !== 3 || run.status !== 'running') {
    return failed('ORCHESTRATION_STATE_INVALID', 'spawn dispatch requires a running schemaVersion 3 orchestration', resolved.taskId);
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
      if (run?.schemaVersion !== 3 || run.status !== 'running' || !run.pendingDelegation) return [];
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
      && receipt.spawnMode === event.spawnMode
      && receipt.actualModel === event.actualModel
      && receipt.actualReasoningEffort === event.actualReasoningEffort
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
  if (run.schemaVersion !== 3) return failed('ORCHESTRATION_STATE_INVALID', 'active delegation requires schemaVersion 3', resolved.taskId);
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
  return { status: 'running', changed: true, taskId: resolved.taskId, run: updated, next: null, error: null };
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
    if (run.schemaVersion !== 3) {
      return failed('ORCHESTRATION_STATE_INVALID', 'activation barrier requires schemaVersion 3', resolved.taskId);
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
            path.join(resolved.repoRoot, '.agents', 'workspace', '.runtime', 'codex-lifecycle'),
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
      if (fs.existsSync(commitIntentPath(resolved.taskDir))) {
        return failed('ORCHESTRATION_PREPARED_RECOVERY_UNSAFE', 'active commit intent blocks prepared recovery', resolved.taskId);
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
  if (run.schemaVersion !== 3) return failed('ORCHESTRATION_STATE_INVALID', 'stage completion requires schemaVersion 3', resolved.taskId);
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
  if (run.schemaVersion !== 3) return failed('ORCHESTRATION_STATE_INVALID', 'stage inspection requires schemaVersion 3', resolved.taskId);
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
  if (run.schemaVersion !== 3) return failed('ORCHESTRATION_STATE_INVALID', 'delegation sealing requires schemaVersion 3', resolved.taskId);
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
  if (run.schemaVersion !== 3) return failed('ORCHESTRATION_STATE_INVALID', 'orchestration advance requires schemaVersion 3', resolved.taskId);
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
  abortCommitIntent,
  beginCommitIntent,
  beginOrResumeOrchestration,
  checkpointCommitIntent,
  commitOrchestrationStageCompletion,
  completeCommitIntent,
  completeOrchestrationStage,
  dispatchOrchestrationDelegation,
  inspectOrchestrationStage,
  hasActivatableOrchestrationDelegation,
  hasSealableOrchestrationDelegation,
  orchestrationPath,
  pauseMatchingOrchestrationDelegation,
  pauseOrchestration,
  planOrchestrationStageCompletion,
  prepareOrchestrationDelegation,
  readRun,
  reconcileMatchingOrchestrationDelegation,
  recoverCommitIntent,
  recoverPreparedOrchestrationDelegation,
  routeOrchestration,
  sealMatchingOrchestrationDelegation,
  sealMatchingOrchestrationDelegationWithHostEvidence,
  sealOrchestrationDelegation,
  startCommitAttempt,
  statusCommitIntent,
  statusOrchestration,
  terminateCommitAttempt
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
  OrchestrationStatus,
  OrchestrationOptions
};
