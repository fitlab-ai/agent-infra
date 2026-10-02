import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

import { isResourceIdentity } from '../platform/resource-identity.ts';
import type { ResourceIdentity } from '../platform/resource-identity.ts';
import { resolveTaskRef } from './resolve-ref.ts';

const JOURNAL_FILE = '.platform-operations.json';

type PlatformOperationKind = 'task-comment' | 'artifact-comment' | 'summary-comment' | 'cancel-comment' | 'issue-create' | 'issue-metadata' | 'pull-request' | 'pull-request-summary' | 'pull-request-review';
type PlatformOperationState = 'queued' | 'pending' | 'unknown' | 'succeeded' | 'failed';
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
  lastCode: string | null;
  issueMetadata?: PlatformIssueMetadataIntent;
  issueCreate?: PlatformIssueCreateIntent;
  pullRequest?: PlatformPullRequestIntent;
  pullRequestSummary?: PlatformPullRequestSummaryIntent;
  pullRequestReview?: PlatformPullRequestReviewIntent;
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
  replaceOperationId?: string;
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
      || !Number.isSafeInteger(item.attempts) || item.attempts < 0
      || !(item.lastCode === null || typeof item.lastCode === 'string')
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
  const targetIndex = journal.operations.findIndex((item) => item.id === id);
  const replacementIndex = input.replaceOperationId
    ? journal.operations.findIndex((item) => item.id === input.replaceOperationId)
    : -1;
  const target = targetIndex >= 0 ? journal.operations[targetIndex] : undefined;
  const replacement = replacementIndex >= 0 ? journal.operations[replacementIndex] : undefined;
  const previousAttempts = Math.max(target?.attempts ?? 0, replacement?.attempts ?? 0);
  const next: PlatformOperation = {
    id,
    kind: input.kind,
    target: input.target,
    expectedDigest: input.expectedDigest,
    dependency: input.dependency,
    state: input.state,
    attempts: previousAttempts + (input.state === 'pending' ? 1 : 0),
    lastCode: input.lastCode ?? null,
    ...(input.issueMetadata ? { issueMetadata: input.issueMetadata } : {}),
    ...(input.issueCreate ? { issueCreate: input.issueCreate } : {}),
    ...(input.pullRequest ? { pullRequest: input.pullRequest } : {}),
    ...(input.pullRequestSummary ? { pullRequestSummary: input.pullRequestSummary } : {}),
    ...(input.pullRequestReview ? { pullRequestReview: input.pullRequestReview } : {}),
    updatedAt: new Date().toISOString()
  };
  const operations = replacementIndex >= 0
    ? journal.operations.flatMap((item, index) => index === replacementIndex
      ? [next]
      : index === targetIndex ? [] : [item])
    : targetIndex >= 0
      ? journal.operations.map((item, index) => index === targetIndex ? next : item)
      : [...journal.operations, next];
  writeJournal(file, { version: 1, taskId, operations });
  return next;
}

function readPlatformOperationJournal(taskRef: string, cwd?: string): PlatformOperationJournal {
  const { taskId, file } = resolveJournal(taskRef, cwd);
  return parseJournal(file, taskId);
}

export { JOURNAL_FILE as PLATFORM_OPERATION_JOURNAL_FILE, operationId, recordPlatformOperation, readPlatformOperationJournal };
export type { PlatformIssueCreateIntent, PlatformIssueMetadataIntent, PlatformOperation, PlatformOperationJournal, PlatformOperationKind, PlatformOperationState, PlatformPullRequestIntent, PlatformPullRequestReviewIntent, PlatformPullRequestSummaryIntent, RecordOperationInput };
