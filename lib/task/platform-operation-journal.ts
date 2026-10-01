import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

import { isResourceIdentity } from '../platform/resource-identity.ts';
import type { ResourceIdentity } from '../platform/resource-identity.ts';
import { resolveTaskRef } from './resolve-ref.ts';

const JOURNAL_FILE = '.platform-operations.json';
const MAX_ATTEMPTS = 3;

type PlatformOperationKind = 'task-comment' | 'artifact-comment' | 'summary-comment' | 'cancel-comment' | 'issue-create' | 'issue-metadata' | 'pull-request' | 'pull-request-summary' | 'pull-request-review';
type PlatformOperationState = 'queued' | 'pending' | 'unknown' | 'succeeded' | 'failed';
type PlatformOperationResolution = Readonly<{
  action: 'confirm-applied' | 'retry' | 'supersede';
  agent: string;
  evidence: string;
  evidenceSource: 'operator-attestation';
  remoteState: 'applied' | 'absent' | 'replaced' | 'cancelled';
  replaySafe: boolean;
  dependenciesPreserved: boolean;
  resolvedAt: string;
}>;
type PlatformIssueMetadataIntent = Readonly<{
  requirements: boolean;
  issueType: boolean;
  fields: boolean;
  status?: string;
  assignees?: 'current' | 'none';
  milestone?: 'initial' | 'specific' | 'none';
  inLabels?: 'from-diff' | 'none';
  base?: string;
  fromDiffFiles?: readonly string[];
  inLabelMappingDigest?: string;
  state?: 'open' | 'closed';
  closeReason?: 'completed' | 'not_planned';
}>;
type PlatformPullRequestIntent = Readonly<{
  action: 'create' | 'bind' | 'sync';
  baseRef?: string;
  headRef?: string;
  prToken?: string;
  metadata?: boolean;
  closingIssue?: boolean;
}>;
type PlatformIssueCreateIntent = Readonly<{ title: string; bodyDigest: string }>;
type PlatformPullRequestSummaryIntent = Readonly<{ body: string; changeReportFile: string }>;
type PlatformPullRequestReviewIntent = Readonly<{
  prNumber: string;
  resource: ResourceIdentity;
  providerScopeId: string;
  scope: string;
  round: number;
  commitSha: string;
  event: 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES';
  artifactFile: string;
  bodyDigest: string;
}>;
type PlatformOperation = Readonly<{
  id: string;
  kind: PlatformOperationKind;
  target: string;
  expectedDigest: string;
  dependency: 'deferred' | 'required';
  state: PlatformOperationState;
  attempts: number;
  maxAttempts: typeof MAX_ATTEMPTS;
  lastCode: string | null;
  issueMetadata?: PlatformIssueMetadataIntent;
  issueCreate?: PlatformIssueCreateIntent;
  pullRequest?: PlatformPullRequestIntent;
  pullRequestSummary?: PlatformPullRequestSummaryIntent;
  pullRequestReview?: PlatformPullRequestReviewIntent;
  resolutions?: readonly PlatformOperationResolution[];
  retryBarrierId?: string;
  updatedAt: string;
}>;
type PlatformOperationJournal = Readonly<{
  version: 1;
  taskId: string;
  operations: readonly PlatformOperation[];
}>;

type RecordOperationInput = Readonly<{
  taskRef: string;
  kind: PlatformOperationKind;
  target: string;
  expectedDigest: string;
  dependency: 'deferred' | 'required';
  state: PlatformOperationState;
  lastCode?: string | null;
  issueMetadata?: PlatformIssueMetadataIntent;
  issueCreate?: PlatformIssueCreateIntent;
  pullRequest?: PlatformPullRequestIntent;
  pullRequestSummary?: PlatformPullRequestSummaryIntent;
  pullRequestReview?: PlatformPullRequestReviewIntent;
  retryBarrierId?: string;
  cwd?: string;
}>;

function operationId(input: Pick<RecordOperationInput, 'kind' | 'target' | 'expectedDigest'>): string {
  return createHash('sha256')
    .update(`${input.kind}\0${input.target}\0${input.expectedDigest}`)
    .digest('hex');
}

function journalPath(taskDir: string): string {
  return path.join(taskDir, JOURNAL_FILE);
}

function parseJournal(file: string, taskId: string): PlatformOperationJournal {
  let value: unknown;
  try { value = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, taskId, operations: [] };
    throw Object.assign(new Error(`Platform operation journal is unreadable: ${String(error)}`), { code: 'PLATFORM_OPERATION_JOURNAL_INVALID' });
  }
  if (!value || typeof value !== 'object') throw Object.assign(new Error('Platform operation journal is invalid'), { code: 'PLATFORM_OPERATION_JOURNAL_INVALID' });
  const journal = value as Partial<PlatformOperationJournal>;
  if (journal.version !== 1 || journal.taskId !== taskId || !Array.isArray(journal.operations)) {
    throw Object.assign(new Error('Platform operation journal identity or version is invalid'), { code: 'PLATFORM_OPERATION_JOURNAL_INVALID' });
  }
  for (const item of journal.operations) {
    if (!item || typeof item !== 'object' || !/^[a-f0-9]{64}$/u.test(item.id)
      || !['task-comment', 'artifact-comment', 'summary-comment', 'cancel-comment', 'issue-create', 'issue-metadata', 'pull-request', 'pull-request-summary', 'pull-request-review'].includes(item.kind)
      || typeof item.target !== 'string' || !item.target
      || !/^[a-f0-9]{64}$/u.test(item.expectedDigest)
      || !['deferred', 'required'].includes(item.dependency)
      || !['queued', 'pending', 'unknown', 'succeeded', 'failed'].includes(item.state)
      || !Number.isSafeInteger(item.attempts) || item.attempts < 0 || item.attempts > MAX_ATTEMPTS
      || item.maxAttempts !== MAX_ATTEMPTS
      || !(item.lastCode === null || typeof item.lastCode === 'string')
      || (item.retryBarrierId !== undefined && !/^[a-f0-9]{64}$/u.test(item.retryBarrierId))
      || (item.resolutions !== undefined && (!Array.isArray(item.resolutions) || item.resolutions.some((resolution: PlatformOperationResolution) =>
        !resolution || !['confirm-applied', 'retry', 'supersede'].includes(resolution.action)
        || typeof resolution.agent !== 'string' || !resolution.agent.trim()
        || typeof resolution.evidence !== 'string' || !resolution.evidence.trim()
        || resolution.evidenceSource !== 'operator-attestation'
        || !['applied', 'absent', 'replaced', 'cancelled'].includes(resolution.remoteState)
        || typeof resolution.replaySafe !== 'boolean' || typeof resolution.dependenciesPreserved !== 'boolean'
        || typeof resolution.resolvedAt !== 'string'
        || (resolution.action === 'confirm-applied' && resolution.remoteState !== 'applied')
        || (resolution.action === 'retry' && (resolution.remoteState !== 'absent' || !resolution.replaySafe))
        || (resolution.action === 'supersede' && (!['replaced', 'cancelled'].includes(resolution.remoteState) || !resolution.dependenciesPreserved)))))
      || (item.kind === 'issue-metadata'
        ? !item.issueMetadata || typeof item.issueMetadata.requirements !== 'boolean'
          || typeof item.issueMetadata.issueType !== 'boolean' || typeof item.issueMetadata.fields !== 'boolean'
          || (item.issueMetadata.status !== undefined && typeof item.issueMetadata.status !== 'string')
          || (item.issueMetadata.assignees !== undefined && !['current', 'none'].includes(item.issueMetadata.assignees))
          || (item.issueMetadata.milestone !== undefined && !['initial', 'specific', 'none'].includes(item.issueMetadata.milestone))
          || (item.issueMetadata.inLabels !== undefined && !['from-diff', 'none'].includes(item.issueMetadata.inLabels))
          || (item.issueMetadata.base !== undefined && (typeof item.issueMetadata.base !== 'string' || !item.issueMetadata.base.trim()))
          || (item.issueMetadata.fromDiffFiles !== undefined && (!Array.isArray(item.issueMetadata.fromDiffFiles)
            || item.issueMetadata.fromDiffFiles.some((file: unknown) => typeof file !== 'string')))
          || (item.issueMetadata.inLabelMappingDigest !== undefined && !/^[a-f0-9]{64}$/u.test(item.issueMetadata.inLabelMappingDigest))
          || (item.issueMetadata.state !== undefined && !['open', 'closed'].includes(item.issueMetadata.state))
          || (item.issueMetadata.closeReason !== undefined && !['completed', 'not_planned'].includes(item.issueMetadata.closeReason))
          || (!item.issueMetadata.requirements && !item.issueMetadata.issueType && !item.issueMetadata.fields
            && item.issueMetadata.status === undefined && item.issueMetadata.assignees === undefined
            && item.issueMetadata.milestone === undefined && item.issueMetadata.inLabels === undefined && item.issueMetadata.state === undefined)
        : item.issueMetadata !== undefined)
      || (item.kind === 'pull-request'
        ? !item.pullRequest || !['create', 'bind', 'sync'].includes(item.pullRequest.action)
          || Object.entries(item.pullRequest).some(([key, field]) => key !== 'action'
            && key !== 'metadata' && key !== 'closingIssue' && (typeof field !== 'string' || !field.trim()))
          || (item.pullRequest.metadata !== undefined && typeof item.pullRequest.metadata !== 'boolean')
          || (item.pullRequest.closingIssue !== undefined && typeof item.pullRequest.closingIssue !== 'boolean')
        : item.pullRequest !== undefined)
      || (item.kind === 'issue-create'
        ? !item.issueCreate || typeof item.issueCreate.title !== 'string' || !item.issueCreate.title.trim()
          || !/^[a-f0-9]{64}$/u.test(item.issueCreate.bodyDigest)
        : item.issueCreate !== undefined)
      || (item.kind === 'pull-request-summary'
        ? !item.pullRequestSummary || typeof item.pullRequestSummary.body !== 'string'
          || !item.pullRequestSummary.body.trim() || typeof item.pullRequestSummary.changeReportFile !== 'string'
          || !item.pullRequestSummary.changeReportFile.trim()
        : item.pullRequestSummary !== undefined)
      || (item.kind === 'pull-request-review'
        ? !item.pullRequestReview || typeof item.pullRequestReview.prNumber !== 'string'
          || !isResourceIdentity(item.pullRequestReview.resource)
          || typeof item.pullRequestReview.providerScopeId !== 'string' || !item.pullRequestReview.providerScopeId.trim()
          || !item.pullRequestReview.prNumber.trim() || !/^TASK-\d{8}-\d{6}$|^pr\d+$/u.test(item.pullRequestReview.scope)
          || !Number.isSafeInteger(item.pullRequestReview.round) || item.pullRequestReview.round <= 0
          || !/^[0-9a-f]{7,40}$/iu.test(item.pullRequestReview.commitSha)
          || !['COMMENT', 'APPROVE', 'REQUEST_CHANGES'].includes(item.pullRequestReview.event)
          || typeof item.pullRequestReview.artifactFile !== 'string'
          || !/^pr-review(?:-r\d+)?\.md$/u.test(item.pullRequestReview.artifactFile)
          || (item.pullRequestReview.artifactFile === 'pr-review.md'
            ? item.pullRequestReview.round !== 1
            : item.pullRequestReview.artifactFile !== `pr-review-r${item.pullRequestReview.round}.md`)
          || !/^[a-f0-9]{64}$/u.test(item.pullRequestReview.bodyDigest)
        : item.pullRequestReview !== undefined)
      || typeof item.updatedAt !== 'string') {
      throw Object.assign(new Error('Platform operation journal contains an invalid operation'), { code: 'PLATFORM_OPERATION_JOURNAL_INVALID' });
    }
  }
  return journal as PlatformOperationJournal;
}

function writeJournal(file: string, journal: PlatformOperationJournal): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(journal, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally {
    try { fs.unlinkSync(temporary); } catch { /* renamed or already removed */ }
  }
}

function resolveJournal(taskRef: string, cwd?: string): { taskId: string; file: string } {
  const resolved = resolveTaskRef(taskRef, cwd ? { repoRoot: cwd } : {});
  if (!resolved.ok) throw Object.assign(new Error(resolved.message), { code: resolved.code });
  return { taskId: resolved.taskId, file: journalPath(resolved.taskDir) };
}

function recordPlatformOperation(input: RecordOperationInput): PlatformOperation {
  if (!/^[a-f0-9]{64}$/u.test(input.expectedDigest) || !input.target.trim()) {
    throw Object.assign(new Error('Platform operation requires a stable target and SHA-256 digest'), { code: 'PLATFORM_OPERATION_PAYLOAD_INVALID' });
  }
  const { taskId, file } = resolveJournal(input.taskRef, input.cwd);
  const journal = parseJournal(file, taskId);
  const id = operationId(input);
  const previous = journal.operations.find((item) => item.id === id);
  const next: PlatformOperation = {
    id,
    kind: input.kind,
    target: input.target,
    expectedDigest: input.expectedDigest,
    dependency: input.dependency,
    state: input.state,
    attempts: Math.min(MAX_ATTEMPTS, (previous?.attempts ?? 0) + (input.state === 'pending' ? 1 : 0)),
    maxAttempts: MAX_ATTEMPTS,
    lastCode: input.lastCode ?? null,
    ...(input.issueMetadata ? { issueMetadata: input.issueMetadata } : {}),
    ...(input.issueCreate ? { issueCreate: input.issueCreate } : {}),
    ...(input.pullRequest ? { pullRequest: input.pullRequest } : {}),
    ...(input.pullRequestSummary ? { pullRequestSummary: input.pullRequestSummary } : {}),
    ...(input.pullRequestReview ? { pullRequestReview: input.pullRequestReview } : {}),
    ...(previous?.retryBarrierId ?? input.retryBarrierId ? { retryBarrierId: previous?.retryBarrierId ?? input.retryBarrierId } : {}),
    ...(previous?.resolutions ? { resolutions: previous.resolutions } : {}),
    updatedAt: new Date().toISOString()
  };
  const operations = previous
    ? journal.operations.map((item) => item.id === id ? next : item)
    : [...journal.operations, next];
  writeJournal(file, { version: 1, taskId, operations });
  return next;
}

type ResolveFailedPlatformOperationInput = Readonly<{
  taskRef: string;
  operationId: string;
  expectedDigest: string;
  expectedState: 'failed';
  action: PlatformOperationResolution['action'];
  agent: string;
  evidence: string;
  remoteState: PlatformOperationResolution['remoteState'];
  replaySafe?: boolean;
  dependenciesPreserved?: boolean;
  cwd?: string;
}>;

function resolveFailedPlatformOperation(input: ResolveFailedPlatformOperationInput): PlatformOperation {
  if (!/^[a-f0-9]{64}$/u.test(input.operationId) || !/^[a-f0-9]{64}$/u.test(input.expectedDigest)
    || input.expectedState !== 'failed' || !input.agent.trim() || input.evidence.trim().length < 20) {
    throw Object.assign(new Error('Resolution requires the full operation identity, failed state, agent, and specific evidence'), { code: 'PLATFORM_OPERATION_RESOLUTION_PAYLOAD_INVALID' });
  }
  const { taskId, file } = resolveJournal(input.taskRef, input.cwd);
  const journal = parseJournal(file, taskId);
  const operation = journal.operations.find((item) => item.id === input.operationId);
  if (!operation || operation.expectedDigest !== input.expectedDigest || operation.state !== input.expectedState) {
    throw Object.assign(new Error('Operation identity, expected digest, or current state changed; inspect the journal and retry with current facts'), { code: 'PLATFORM_OPERATION_RESOLUTION_STALE' });
  }
  if (input.action === 'confirm-applied' && input.remoteState !== 'applied') {
    throw Object.assign(new Error('confirm-applied requires remoteState=applied'), { code: 'PLATFORM_OPERATION_RESOLUTION_EVIDENCE_INVALID' });
  }
  if (input.action === 'retry' && (input.remoteState !== 'absent' || input.replaySafe !== true)) {
    throw Object.assign(new Error('retry requires remoteState=absent and replaySafe=true'), { code: 'PLATFORM_OPERATION_RESOLUTION_EVIDENCE_INVALID' });
  }
  if (input.action === 'retry' && (operation.attempts >= operation.maxAttempts
    || !['task-comment', 'artifact-comment', 'summary-comment', 'cancel-comment', 'issue-metadata', 'pull-request', 'pull-request-summary'].includes(operation.kind))) {
    throw Object.assign(new Error('Operation has no remaining attempts or its recovery handler is not approved for safe replay'), { code: 'PLATFORM_OPERATION_RETRY_NOT_SAFE' });
  }
  if (input.action === 'supersede' && (!['replaced', 'cancelled'].includes(input.remoteState) || input.dependenciesPreserved !== true)) {
    throw Object.assign(new Error('supersede requires remoteState=replaced|cancelled and dependenciesPreserved=true'), { code: 'PLATFORM_OPERATION_RESOLUTION_EVIDENCE_INVALID' });
  }
  const resolvedAt = new Date().toISOString();
  const resolution: PlatformOperationResolution = {
    action: input.action, agent: input.agent, evidence: input.evidence.trim(), evidenceSource: 'operator-attestation', remoteState: input.remoteState,
    replaySafe: input.replaySafe === true, dependenciesPreserved: input.dependenciesPreserved === true, resolvedAt
  };
  const updated: PlatformOperation = {
    ...operation,
    state: input.action === 'confirm-applied' ? 'succeeded' : input.action === 'retry' ? 'queued' : 'failed',
    lastCode: input.action === 'supersede' ? 'PLATFORM_OPERATION_SUPERSEDED' : null,
    resolutions: [...(operation.resolutions ?? []), resolution],
    updatedAt: resolvedAt
  };
  writeJournal(file, { ...journal, operations: journal.operations.map((item) => item.id === operation.id ? updated : item) });
  return updated;
}

function readPlatformOperationJournal(taskRef: string, cwd?: string): PlatformOperationJournal {
  const { taskId, file } = resolveJournal(taskRef, cwd);
  return parseJournal(file, taskId);
}

export { JOURNAL_FILE as PLATFORM_OPERATION_JOURNAL_FILE, MAX_ATTEMPTS as PLATFORM_OPERATION_MAX_ATTEMPTS, operationId, recordPlatformOperation, readPlatformOperationJournal, resolveFailedPlatformOperation };
export type { PlatformIssueCreateIntent, PlatformIssueMetadataIntent, PlatformOperation, PlatformOperationJournal, PlatformOperationKind, PlatformOperationResolution, PlatformOperationState, PlatformPullRequestIntent, PlatformPullRequestReviewIntent, PlatformPullRequestSummaryIntent, RecordOperationInput, ResolveFailedPlatformOperationInput };
