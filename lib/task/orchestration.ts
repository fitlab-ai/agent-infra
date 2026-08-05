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
  completeDelegationStage,
  consumeDelegation,
  managedDelegationRole,
  prepareDelegation,
  sealDelegation
} from './delegation-receipts.ts';
import type { DelegationReceipt, DelegationRole, DelegationStage } from './delegation-receipts.ts';
import { getAgentClientCapability } from '../agent-clients/registry.ts';
import type { AgentClientId } from '../agent-clients/types.ts';
import { captureWorkspaceSnapshot, diffWorkspaceSnapshots } from './workspace-snapshot.ts';

type OrchestrationStatus = 'running' | 'paused' | 'completed';
type OrchestrationModelPolicy = Readonly<{
  executor: string;
  reviewer: string;
  sameModelReason: string | null;
}>;
type OrchestrationRun = Readonly<{
  schemaVersion: 1;
  taskId: string;
  runId: string;
  status: OrchestrationStatus;
  nextStage: DelegationStage | null;
  stepCount: number;
  maxSteps: number;
  modelPolicy?: OrchestrationModelPolicy;
  baseline: string;
  pendingDelegation: DelegationReceipt | null;
  receipts: readonly DelegationReceipt[];
  pause: Readonly<{ code: string; message: string; recoverable: boolean }> | null;
  commitAuthorization: Readonly<{ issuedAt: string | null; consumedAt: string | null }>;
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
}>;
type OrchestrationResult = Readonly<{
  status: OrchestrationStatus | 'failed';
  changed: boolean;
  taskId: string | null;
  run: OrchestrationRun | null;
  next: OrchestrationNext | null;
  error: Readonly<{ code: string; message: string }> | null;
}>;
type OrchestrationOptions = {
  repoRoot?: string;
  id?: () => string;
  now?: () => string;
  maxSteps?: number;
  modelPolicy?: OrchestrationModelPolicy;
  captureWorkspace?: (repoRoot: string, taskId: string | null) => string;
  diffWorkspace?: (repoRoot: string, before: string, after: string) => string[];
};

function orchestrationPath(taskDir: string): string {
  return path.join(taskDir, 'orchestration.json');
}

function readRun(taskDir: string): OrchestrationRun | null {
  const file = orchestrationPath(taskDir);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8')) as OrchestrationRun;
}

function atomicWrite(file: string, value: unknown): void {
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  fs.renameSync(temp, file);
}

function saveRun(taskDir: string, run: OrchestrationRun): void {
  atomicWrite(orchestrationPath(taskDir), run);
}

function withUpdatedRun(run: OrchestrationRun, updates: Partial<OrchestrationRun>): OrchestrationRun {
  return Object.freeze({ ...run, ...updates, updatedAt: new Date().toISOString() });
}

function failed(code: string, message: string, taskId: string | null = null): OrchestrationResult {
  return { status: 'failed', changed: false, taskId, run: null, next: null, error: { code, message } };
}

function validModel(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim() === value;
}

function validateModelPolicy(policy: OrchestrationModelPolicy | undefined): Readonly<{ code: string; message: string }> | null {
  if (!policy || !validModel(policy.executor) || !validModel(policy.reviewer)) {
    return { code: 'ORCHESTRATION_MODEL_POLICY_REQUIRED', message: 'executor and reviewer model identities are required' };
  }
  if (policy.executor === policy.reviewer) {
    if (!validModel(policy.sameModelReason)) {
      return { code: 'ORCHESTRATION_MODEL_SEPARATION_REQUIRED', message: 'using the same executor and reviewer model requires a reason' };
    }
  } else if (policy.sameModelReason !== null) {
    return { code: 'ORCHESTRATION_MODEL_POLICY_INVALID', message: 'same-model reason must be null when executor and reviewer models differ' };
  }
  return null;
}

function sameModelPolicy(left: OrchestrationModelPolicy, right: OrchestrationModelPolicy): boolean {
  return left.executor === right.executor
    && left.reviewer === right.reviewer
    && left.sameModelReason === right.sameModelReason;
}

function beginOrResumeOrchestration(taskRef: string, options: OrchestrationOptions = {}): OrchestrationResult {
  const resolved = resolveTaskRef(taskRef, { repoRoot: options.repoRoot });
  if (!resolved.ok) return failed(resolved.code, resolved.message, resolved.taskId);
  const existing = readRun(resolved.taskDir);
  if (existing) {
    if (!existing.modelPolicy && existing.status !== 'completed') {
      if (existing.status === 'paused' && existing.pause?.code === 'ORCHESTRATION_MODEL_EVIDENCE_MISSING') {
        return { status: 'paused', changed: false, taskId: resolved.taskId, run: existing, next: null, error: null };
      }
      const paused = withUpdatedRun(existing, {
        status: 'paused',
        pause: {
          code: 'ORCHESTRATION_MODEL_EVIDENCE_MISSING',
          message: 'existing orchestration run has no persisted model policy',
          recoverable: false
        }
      });
      saveRun(resolved.taskDir, paused);
      return { status: 'paused', changed: true, taskId: resolved.taskId, run: paused, next: null, error: null };
    }
    if (options.modelPolicy) {
      const policyError = validateModelPolicy(options.modelPolicy);
      if (policyError) return failed(policyError.code, policyError.message, resolved.taskId);
      if (!existing.modelPolicy || !sameModelPolicy(existing.modelPolicy, options.modelPolicy)) {
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
  const policyError = validateModelPolicy(options.modelPolicy);
  if (policyError) return failed(policyError.code, policyError.message, resolved.taskId);
  const now = (options.now ?? (() => new Date().toISOString()))();
  const run: OrchestrationRun = {
    schemaVersion: 1,
    taskId: resolved.taskId,
    runId: (options.id ?? randomUUID)(),
    status: 'running',
    nextStage: null,
    stepCount: 0,
    maxSteps: options.maxSteps ?? 24,
    modelPolicy: options.modelPolicy!,
    baseline: '',
    pendingDelegation: null,
    receipts: [],
    pause: null,
    commitAuthorization: { issuedAt: null, consumedAt: null },
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

function routeFromFacts(taskDir: string): Omit<OrchestrationNext, 'requestedModel'> | null {
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
  try {
    parseTypedTaskFrontmatter(content);
  } catch (error) {
    return failed('ORCHESTRATION_TASK_INVALID', error instanceof Error ? error.message : String(error), resolved.taskId);
  }
  const routed = routeFromFacts(resolved.taskDir);
  if (!routed) return failed('ORCHESTRATION_ROUTE_UNKNOWN', 'cannot determine a unique lifecycle action', resolved.taskId);
  const run = readRun(resolved.taskDir);
  const next: OrchestrationNext = {
    ...routed,
    requestedModel: run?.modelPolicy?.[routed.role] ?? null
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
    if (review.summary.manualValidation > 0) {
      return failed('ORCHESTRATION_MANUAL_VALIDATION_PENDING', 'manual validation must be completed before commit', resolved.taskId);
    }
    const rows = parseLedger(content);
    const ledgerError = validateLedgerRows(rows);
    if (ledgerError) return failed('ORCHESTRATION_LEDGER_INVALID', ledgerError.message, resolved.taskId);
    if (!summarizeLedgerStage(rows, 'code').canAdvance) {
      return failed('ORCHESTRATION_LEDGER_BLOCKED', 'code review ledger has unresolved findings or human decisions', resolved.taskId);
    }
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

function prepareOrchestrationDelegation(
  taskRef: string,
  input: Readonly<{ client: AgentClientId; requestedModel?: string }>,
  options: OrchestrationOptions = {}
): OrchestrationResult {
  const resolved = resolveTaskRef(taskRef, { repoRoot: options.repoRoot });
  if (!resolved.ok) return failed(resolved.code, resolved.message, resolved.taskId);
  if (
    getAgentClientCapability(input.client, 'subagents').level === 'unsupported'
    || getAgentClientCapability(input.client, 'orchestration').level === 'unsupported'
  ) {
    return failed('ORCHESTRATION_CLIENT_UNSUPPORTED', `client '${input.client}' does not support lifecycle orchestration`, resolved.taskId);
  }
  const run = readRun(resolved.taskDir);
  if (!run || run.status !== 'running') return failed('ORCHESTRATION_RUN_NOT_RUNNING', 'a running orchestration is required', resolved.taskId);
  if (!run.modelPolicy) return failed('ORCHESTRATION_MODEL_EVIDENCE_MISSING', 'running orchestration has no persisted model policy', resolved.taskId);
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
  const expectedModel = run.modelPolicy[next.role];
  if (input.requestedModel !== expectedModel) {
    return failed('ORCHESTRATION_REQUESTED_MODEL_MISMATCH', `requested model does not match the persisted ${next.role} model`, resolved.taskId);
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

function completeCommitOrchestrationStage(
  taskRef: string,
  agent: string,
  options: OrchestrationOptions = {}
): OrchestrationResult {
  const resolved = resolveTaskRef(taskRef, { repoRoot: options.repoRoot });
  if (!resolved.ok) return failed(resolved.code, resolved.message, resolved.taskId);
  const run = readRun(resolved.taskDir);
  if (!run) return { status: 'running', changed: false, taskId: resolved.taskId, run: null, next: null, error: null };
  const receipt = run.pendingDelegation;
  if (!receipt || receipt.stage !== 'commit') {
    return failed('ORCHESTRATION_DELEGATION_MISSING', 'active run has no pending commit delegation', resolved.taskId);
  }
  return completeOrchestrationStage(taskRef, {
    stage: receipt.stage,
    round: receipt.round,
    artifact: receipt.artifact,
    agent
  }, options);
}

function validateOrchestrationStage(
  taskRef: string,
  event: Readonly<{ stage: DelegationStage; round: number; artifact: string; role: DelegationRole }>,
  options: OrchestrationOptions = {}
): OrchestrationResult {
  const resolved = resolveTaskRef(taskRef, { repoRoot: options.repoRoot });
  if (!resolved.ok) return failed(resolved.code, resolved.message, resolved.taskId);
  const run = readRun(resolved.taskDir);
  if (!run) return { status: 'running', changed: false, taskId: resolved.taskId, run: null, next: null, error: null };
  const receipt = run.pendingDelegation;
  if (
    !receipt
    || receipt.status !== 'activated'
    || receipt.stage !== event.stage
    || receipt.round !== event.round
    || receipt.artifact !== event.artifact
    || receipt.role !== event.role
  ) {
    return pauseOrchestration(
      taskRef,
      'ORCHESTRATION_PROVENANCE_MISMATCH',
      'active run does not have one matching activated delegation',
      true,
      options
    );
  }
  return { status: 'running', changed: false, taskId: resolved.taskId, run, next: null, error: null };
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
  beginOrResumeOrchestration,
  completeCommitOrchestrationStage,
  completeOrchestrationStage,
  orchestrationPath,
  pauseOrchestration,
  prepareOrchestrationDelegation,
  readRun,
  routeOrchestration,
  sealMatchingOrchestrationDelegation,
  sealOrchestrationDelegation,
  statusOrchestration,
  validateOrchestrationStage
};
export type { OrchestrationModelPolicy, OrchestrationNext, OrchestrationResult, OrchestrationRun, OrchestrationStatus };
