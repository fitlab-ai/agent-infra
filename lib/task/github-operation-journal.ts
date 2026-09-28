import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

import { resolveTaskRef } from './resolve-ref.ts';

const JOURNAL_FILE = '.github-operations.json';
const MAX_ATTEMPTS = 3;

type GithubOperationKind = 'task-comment' | 'artifact-comment' | 'summary-comment' | 'issue-metadata' | 'pull-request';
type GithubOperationState = 'pending' | 'unknown' | 'succeeded' | 'failed';
type GithubIssueMetadataIntent = Readonly<{
  requirements: boolean;
  issueType: boolean;
  fields: boolean;
  status?: string;
  assignees?: 'current' | 'none';
  milestone?: 'initial' | 'specific' | 'none';
  inLabels?: 'from-diff' | 'none';
  base?: string;
  fromDiffFiles?: readonly string[];
  state?: 'open' | 'closed';
  closeReason?: 'completed' | 'not_planned';
}>;
type GithubPullRequestIntent = Readonly<{
  action: 'create' | 'bind' | 'sync';
  baseRef?: string;
  headRef?: string;
  prToken?: string;
  metadata?: boolean;
  closingIssue?: boolean;
}>;
type GithubOperation = Readonly<{
  id: string;
  kind: GithubOperationKind;
  target: string;
  expectedDigest: string;
  dependency: 'deferred' | 'required';
  state: GithubOperationState;
  attempts: number;
  maxAttempts: typeof MAX_ATTEMPTS;
  lastCode: string | null;
  issueMetadata?: GithubIssueMetadataIntent;
  pullRequest?: GithubPullRequestIntent;
  updatedAt: string;
}>;
type GithubOperationJournal = Readonly<{
  version: 1;
  taskId: string;
  operations: readonly GithubOperation[];
}>;

type RecordOperationInput = Readonly<{
  taskRef: string;
  kind: GithubOperationKind;
  target: string;
  expectedDigest: string;
  dependency: 'deferred' | 'required';
  state: GithubOperationState;
  lastCode?: string | null;
  issueMetadata?: GithubIssueMetadataIntent;
  pullRequest?: GithubPullRequestIntent;
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

function parseJournal(file: string, taskId: string): GithubOperationJournal {
  let value: unknown;
  try { value = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, taskId, operations: [] };
    throw Object.assign(new Error(`GitHub operation journal is unreadable: ${String(error)}`), { code: 'GITHUB_OPERATION_JOURNAL_INVALID' });
  }
  if (!value || typeof value !== 'object') throw Object.assign(new Error('GitHub operation journal is invalid'), { code: 'GITHUB_OPERATION_JOURNAL_INVALID' });
  const journal = value as Partial<GithubOperationJournal>;
  if (journal.version !== 1 || journal.taskId !== taskId || !Array.isArray(journal.operations)) {
    throw Object.assign(new Error('GitHub operation journal identity or version is invalid'), { code: 'GITHUB_OPERATION_JOURNAL_INVALID' });
  }
  for (const item of journal.operations) {
    if (!item || typeof item !== 'object' || !/^[a-f0-9]{64}$/u.test(item.id)
      || !['task-comment', 'artifact-comment', 'summary-comment', 'issue-metadata', 'pull-request'].includes(item.kind)
      || typeof item.target !== 'string' || !item.target
      || !/^[a-f0-9]{64}$/u.test(item.expectedDigest)
      || !['deferred', 'required'].includes(item.dependency)
      || !['pending', 'unknown', 'succeeded', 'failed'].includes(item.state)
      || !Number.isSafeInteger(item.attempts) || item.attempts < 0 || item.attempts > MAX_ATTEMPTS
      || item.maxAttempts !== MAX_ATTEMPTS
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
      || typeof item.updatedAt !== 'string') {
      throw Object.assign(new Error('GitHub operation journal contains an invalid operation'), { code: 'GITHUB_OPERATION_JOURNAL_INVALID' });
    }
  }
  return journal as GithubOperationJournal;
}

function writeJournal(file: string, journal: GithubOperationJournal): void {
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

function recordGithubOperation(input: RecordOperationInput): GithubOperation {
  if (!/^[a-f0-9]{64}$/u.test(input.expectedDigest) || !input.target.trim()) {
    throw Object.assign(new Error('GitHub operation requires a stable target and SHA-256 digest'), { code: 'GITHUB_OPERATION_PAYLOAD_INVALID' });
  }
  const { taskId, file } = resolveJournal(input.taskRef, input.cwd);
  const journal = parseJournal(file, taskId);
  const id = operationId(input);
  const previous = journal.operations.find((item) => item.id === id);
  const next: GithubOperation = {
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
    ...(input.pullRequest ? { pullRequest: input.pullRequest } : {}),
    updatedAt: new Date().toISOString()
  };
  const operations = previous
    ? journal.operations.map((item) => item.id === id ? next : item)
    : [...journal.operations, next];
  writeJournal(file, { version: 1, taskId, operations });
  return next;
}

function readGithubOperationJournal(taskRef: string, cwd?: string): GithubOperationJournal {
  const { taskId, file } = resolveJournal(taskRef, cwd);
  return parseJournal(file, taskId);
}

export { JOURNAL_FILE as GITHUB_OPERATION_JOURNAL_FILE, MAX_ATTEMPTS as GITHUB_OPERATION_MAX_ATTEMPTS, operationId, recordGithubOperation, readGithubOperationJournal };
export type { GithubIssueMetadataIntent, GithubOperation, GithubOperationJournal, GithubOperationKind, GithubOperationState, GithubPullRequestIntent, RecordOperationInput };
