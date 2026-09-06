import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { parseTypedTaskFrontmatter } from '../task/frontmatter.ts';
import { resolveTaskRef } from '../task/resolve-ref.ts';
import { extractSection } from '../task/sections.ts';
import { captureTaskWriteMetadata, writeTask } from '../task/write.ts';
import type { PlatformChangeRequestSnapshot } from './adapters.ts';
import { resolvePlatformProviderContext } from './context.ts';
import type { PlatformClient } from './context.ts';
import { inspectPlatformIssue } from './issues.ts';
import { planPullRequestMetadata } from './pull-request-metadata.ts';
import {
  planInLabelUpdate,
  validateInLabelMapping
} from './in-label-sync.ts';
import { platformResult } from './types.ts';
import type { PlatformOperation, PlatformResult } from './types.ts';
import { inspectCompletionArtifacts } from '../task/finalization-artifacts.ts';
import { TaskExecutionLockError, withTaskExecutionLock } from '../task/task-execution-lock.ts';
import { resolveDeliveryTarget } from '../task/delivery-target.ts';
import { mergeOperationWarnings, type OperationWarning } from '../task/operation-outcome.ts';
import {
  buildBoundFact,
  buildSkippedFact,
  factFrontmatterMutation,
  readPrDeliveryFact
} from '../task/pr-delivery-fact.ts';
import type { CreationOutcome, PrDeliveryBindingSource, PrDeliveryFact } from '../task/pr-delivery-fact.ts';
import {
  providerError,
  providerOperationContext,
  providerStatus,
  providerResourceToken,
  providerResourceIdentity,
  resourceIdentity,
  unsupportedProviderOperation
} from './provider-bridge.ts';
import { isResourceIdentity, resourceIdentityEquals, resourceIdentityNumber } from './resource-identity.ts';
import type { ResourceIdentity } from './resource-identity.ts';
import { taskIssueIdentity, taskIssueIdentityError } from './task-identities.ts';
import type { ChangeRequestSnapshot as ProviderChangeRequestSnapshot, IssueSnapshot as ProviderIssueSnapshot } from './provider-contract.ts';

type PullRequestSnapshot = PlatformChangeRequestSnapshot;

type PullRequestResult = PlatformResult & {
  task: { id: string | null; issueNumber: number | null; prNumber: number | null };
  pullRequest: PullRequestSnapshot | null;
  result: 'pr_created' | 'pr_reused' | 'no_op' | 'pr_created_with_warnings' | 'pr_reused_with_warnings' | 'no_op_with_warnings' | 'failed' | 'blocked' | null;
  creation: CreationOutcome | null;
  warnings: readonly OperationWarning[];
  evidence?: { kind: string; pullRequestFiles?: string[]; closingIssues?: number[] };
  resources?: Array<{
    kind: 'issue' | 'pull-request';
    number: number;
    before: string[];
    expected: string[];
    after: string[] | null;
    effect: 'no-op' | 'applied' | 'unknown';
  }>;
};
type GitHubClient = PlatformClient;
type InspectionOptions = { cwd?: string; client?: PlatformClient; runtimeVersion?: string };
type SharedOptions = { cwd?: string; client?: PlatformClient; runtimeVersion?: string };
type CreateOptions = SharedOptions & {
  agent: string;
  base: string;
  head: string;
  title: string;
  body: string;
  draft?: boolean;
  dryRun?: boolean;
  phase?: { value: CreatePhase };
};
type BindOptions = SharedOptions & { agent: string; pr: string | number; dryRun?: boolean };
type PullRequestPrimaryResult = 'pr_created' | 'pr_reused' | 'no_op';
type SyncOptions = SharedOptions & { agent: string; metadata?: boolean; closingIssue?: boolean; dryRun?: boolean; primaryResult: PullRequestPrimaryResult };
type ResolveExternalOptions = SharedOptions & { agent: string; pr?: string | number; dryRun?: boolean };
type SkipFactOptions = { cwd?: string; agent: string; dryRun?: boolean; runtimeVersion?: string };
type ExternalPullRequestSelection =
  | { status: 'normal'; candidates: PullRequestSnapshot[]; eligible: [] }
  | { status: 'selected'; source: 'unique' | 'explicit'; selected: PullRequestSnapshot; candidates: PullRequestSnapshot[]; eligible: PullRequestSnapshot[] }
  | { status: 'failed'; code: string; message: string; candidates: PullRequestSnapshot[]; eligible: PullRequestSnapshot[] };
type ExternalPullRequestResult = PullRequestResult & {
  mode: 'normal' | 'external' | null;
  authorization: 'unique' | 'explicit' | null;
  candidates: PullRequestSnapshot[];
  eligible: PullRequestSnapshot[];
  selected: PullRequestSnapshot | null;
};

type CreatePhase = 'before-post' | 'post-dispatched' | 'post-accepted';

type RemotePullRequest = {
  number?: number;
  node_id?: string;
  html_url?: string;
  state?: string;
  title?: string;
  body?: string | null;
  draft?: boolean;
  pull_request?: unknown;
  head?: { ref?: string; sha?: string; repo?: { full_name?: string } | null };
  base?: { ref?: string; sha?: string; repo?: { full_name?: string } | null };
  merged_at?: string | null;
  merge_commit_sha?: string | null;
  labels?: Array<string | { name?: string }>;
  assignees?: Array<{ login?: string }>;
  milestone?: { title?: string } | null;
  mergeable?: boolean | null;
  mergeable_state?: string | null;
};

type ClosingPullRequestNode = {
  number?: number;
  id?: string;
  url?: string;
  state?: string;
  title?: string;
  body?: string | null;
  isDraft?: boolean;
  headRefName?: string;
  headRefOid?: string;
  headRepository?: { nameWithOwner?: string } | null;
  baseRefName?: string;
  baseRefOid?: string;
  baseRepository?: { nameWithOwner?: string } | null;
  mergedAt?: string | null;
  mergeCommit?: { oid?: string } | null;
  labels?: { nodes?: Array<{ name?: string }> };
  assignees?: { nodes?: Array<{ login?: string }> };
  milestone?: { title?: string } | null;
};

type ClosingPullRequestPage = {
  data?: { repository?: { issue?: { closedByPullRequestsReferences?: {
    nodes?: ClosingPullRequestNode[];
    pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
  } } } };
};

function warningResultForPrimary(primaryResult: PullRequestPrimaryResult): NonNullable<PullRequestResult['result']> {
  if (primaryResult === 'pr_created') return 'pr_created_with_warnings';
  if (primaryResult === 'pr_reused') return 'pr_reused_with_warnings';
  return 'no_op_with_warnings';
}

function result(
  status: PlatformResult['status'],
  taskId: string | null,
  issueNumber: number | null,
  prNumber: number | null,
  overrides: Partial<PullRequestResult> = {}
): PullRequestResult {
  const output = {
    ...platformResult(status),
    task: { id: taskId, issueNumber, prNumber },
    pullRequest: null,
    result: null,
    creation: null,
    warnings: [],
    ...overrides
  };
  return { ...output, warnings: mergeOperationWarnings(output.warnings) };
}

function externalResult(
  base: PullRequestResult,
  overrides: Partial<ExternalPullRequestResult> = {}
): ExternalPullRequestResult {
  return {
    ...base,
    mode: null,
    authorization: null,
    candidates: [],
    eligible: [],
    selected: null,
    ...overrides
  };
}

function withCreation(output: PullRequestResult, creation: CreationOutcome): PullRequestResult {
  return { ...output, creation };
}

const PRECONDITION_NOT_CREATED: CreationOutcome = {
  kind: 'not-created', reason: 'precondition-failed', createdByCurrentOperation: false
};

function normalizePullRequest(remote: RemotePullRequest, repository: string): PullRequestSnapshot | null {
  const number = Number(remote.number);
  const headRepository = remote.head?.repo?.full_name;
  const baseRepository = remote.base?.repo?.full_name;
  if (!Number.isInteger(number) || number <= 0 || !remote.node_id || !remote.html_url ||
      !remote.head?.ref || !remote.head.sha || !headRepository || !remote.base?.ref || !baseRepository) return null;
  const mergeabilityDetail = remote.mergeable_state?.trim().toLowerCase() || null;
  const mergeability = remote.mergeable === false
    ? { state: 'conflicting' as const, detail: mergeabilityDetail }
    : remote.mergeable === true && mergeabilityDetail !== 'dirty'
      ? { state: 'mergeable' as const, detail: mergeabilityDetail }
      : { state: 'unknown' as const, detail: mergeabilityDetail };
  return {
    repository,
    number,
    nodeId: remote.node_id,
    url: remote.html_url,
    state: remote.state === 'closed' ? 'closed' : 'open',
    title: remote.title || '',
    body: remote.body || '',
    draft: Boolean(remote.draft),
    head: { repository: headRepository, ref: remote.head.ref, sha: remote.head.sha },
    base: { repository: baseRepository, ref: remote.base.ref, sha: remote.base.sha || '' },
    mergedAt: remote.merged_at || null,
    mergeCommitSha: remote.merge_commit_sha || null,
    labels: (remote.labels || []).map((label) => typeof label === 'string' ? label : label.name || '').filter(Boolean).sort(),
    assignees: (remote.assignees || []).map((assignee) => assignee.login || '').filter(Boolean).sort(),
    milestone: remote.milestone?.title || null,
    mergeability
  };
}

function normalizeClosingPullRequest(node: ClosingPullRequestNode, repository: string): PullRequestSnapshot | null {
  return normalizePullRequest({
    number: node.number,
    node_id: node.id,
    html_url: node.url,
    state: node.state === 'OPEN' ? 'open' : 'closed',
    title: node.title,
    body: node.body,
    draft: node.isDraft,
    head: { ref: node.headRefName, sha: node.headRefOid, repo: node.headRepository ? { full_name: node.headRepository.nameWithOwner } : null },
    base: { ref: node.baseRefName, sha: node.baseRefOid, repo: node.baseRepository ? { full_name: node.baseRepository.nameWithOwner } : null },
    merged_at: node.mergedAt,
    merge_commit_sha: node.mergeCommit?.oid,
    labels: node.labels?.nodes,
    assignees: node.assignees?.nodes,
    milestone: node.milestone
  }, repository);
}

function repositoryKey(repository: string): string {
  return repository.trim().toLowerCase();
}

function isUsableResourceIdentity(identity: ResourceIdentity): boolean {
  return isResourceIdentity(identity);
}

function identityLabel(identity: ResourceIdentity): string {
  return identity.kind === 'number' ? `PR #${identity.value}` : `PR ${identity.kind}:${identity.value}`;
}

function identitySignature(pullRequest: PullRequestSnapshot): string {
  return [
    pullRequest.repository, JSON.stringify(pullRequestIdentity(pullRequest)), pullRequest.nodeId, pullRequest.url,
    pullRequest.head.repository, pullRequest.head.ref, pullRequest.head.sha,
    pullRequest.base.repository, pullRequest.base.ref, pullRequest.base.sha,
    pullRequest.mergedAt || '', pullRequest.mergeCommitSha || ''
  ].join('|');
}

function hasCompleteExternalIdentity(pullRequest: PullRequestSnapshot): boolean {
  const required = [
    pullRequest.repository, pullRequest.nodeId, pullRequest.url,
    pullRequest.head.repository, pullRequest.head.ref, pullRequest.head.sha,
    pullRequest.base.repository, pullRequest.base.ref, pullRequest.base.sha
  ];
  return isUsableResourceIdentity(pullRequestIdentity(pullRequest)) && required.every((value) => Boolean(value?.trim())) &&
    (pullRequest.state === 'open' || Boolean(pullRequest.mergedAt) === Boolean(pullRequest.mergeCommitSha));
}

function selectExternalPullRequest(
  candidates: PullRequestSnapshot[],
  repository: string,
  existingPrIdentity: ResourceIdentity | number | null,
  explicitPrIdentity: ResourceIdentity | number | null
): ExternalPullRequestSelection {
  const existingIdentity = typeof existingPrIdentity === 'number'
    ? resourceIdentity(existingPrIdentity) : existingPrIdentity;
  const explicitIdentity = typeof explicitPrIdentity === 'number'
    ? resourceIdentity(explicitPrIdentity) : explicitPrIdentity;
  const invalid = candidates.find((candidate) => !hasCompleteExternalIdentity(candidate));
  if (invalid) return {
    status: 'failed', code: 'PR_IDENTITY_INVALID',
    message: `Closing PR #${invalid.number} lacks required identity`, candidates, eligible: []
  };
  const byIdentity = new Map<string, string>();
  for (const candidate of candidates) {
    const signature = identitySignature(candidate);
    const identityKey = JSON.stringify(pullRequestIdentity(candidate));
    const prior = byIdentity.get(identityKey);
    if (prior && prior !== signature) return {
      status: 'failed', code: 'PR_IDENTITY_INVALID',
      message: `Closing PR #${candidate.number} has conflicting identities`, candidates, eligible: []
    };
    byIdentity.set(identityKey, signature);
  }
  const unique = candidates.filter((candidate, index) =>
    candidates.findIndex((other) => resourceIdentityEquals(pullRequestIdentity(other), pullRequestIdentity(candidate))) === index
  );
  const wantedRepository = repositoryKey(repository);
  const eligible = unique.filter((candidate) =>
    repositoryKey(candidate.repository) === wantedRepository &&
    repositoryKey(candidate.base.repository) === wantedRepository &&
    candidate.state === 'closed' &&
    Boolean(candidate.mergedAt && candidate.mergeCommitSha)
  );
  if (explicitIdentity !== null) {
    const selected = unique.find((candidate) => resourceIdentityEquals(pullRequestIdentity(candidate), explicitIdentity));
    if (!selected) return { status: 'failed', code: 'PR_NOT_FOUND', message: `PR ${identityLabel(explicitIdentity)} is not a closing PR`, candidates, eligible };
    if (!eligible.some((candidate) => resourceIdentityEquals(pullRequestIdentity(candidate), explicitIdentity))) {
      return { status: 'failed', code: 'PR_IDENTITY_INVALID', message: `PR ${identityLabel(explicitIdentity)} is not an eligible merged PR`, candidates, eligible };
    }
    if (existingIdentity !== null && !resourceIdentityEquals(existingIdentity, explicitIdentity)) {
      return { status: 'failed', code: 'PR_BIND_CONFLICT', message: `Task is already bound to ${identityLabel(existingIdentity)}`, candidates, eligible };
    }
    return { status: 'selected', source: 'explicit', selected, candidates, eligible };
  }
  if (existingIdentity !== null && eligible.length === 1 && !resourceIdentityEquals(existingIdentity, pullRequestIdentity(eligible[0]!))) {
    return { status: 'failed', code: 'PR_BIND_CONFLICT', message: `Task is already bound to ${identityLabel(existingIdentity)}`, candidates, eligible };
  }
  if (eligible.length === 0) return { status: 'normal', candidates, eligible: [] };
  if (eligible.length > 1) return {
    status: 'failed', code: 'PR_IDENTITY_AMBIGUOUS',
    message: 'Multiple eligible merged closing pull requests were found', candidates, eligible
  };
  return { status: 'selected', source: 'unique', selected: eligible[0]!, candidates, eligible };
}

const CLOSING_PULL_REQUESTS_QUERY = `query($owner:String!,$name:String!,$issue:Int!,$cursor:String){repository(owner:$owner,name:$name){issue(number:$issue){closedByPullRequestsReferences(first:100,after:$cursor){nodes{number id url state title body isDraft headRefName headRefOid headRepository{nameWithOwner} baseRefName baseRefOid baseRepository{nameWithOwner} mergedAt mergeCommit{oid} labels(first:100){nodes{name}} assignees(first:100){nodes{login}} milestone{title}} pageInfo{hasNextPage endCursor}}}}}`;

function inspectGitHubIssueClosingChangeRequests(
  client: GitHubClient,
  repository: string,
  issueNumber: number,
  cwd: string
) {
  const [owner, name] = repository.split('/');
  if (!owner || !name || !Number.isInteger(issueNumber) || issueNumber <= 0) return {
    ok: false as const,
    error: { code: 'PR_IDENTITY_INVALID', message: 'Repository or Issue identity is invalid', retryable: false }
  };
  const candidates: PullRequestSnapshot[] = [];
  let cursor: string | null = null;
  for (;;) {
    const args = [
      'api', 'graphql', '-f', `query=${CLOSING_PULL_REQUESTS_QUERY}`,
      '-F', `owner=${owner}`, '-F', `name=${name}`, '-F', `issue=${issueNumber}`
    ];
    if (cursor) args.push('-F', `cursor=${cursor}`);
    const response = client.json<ClosingPullRequestPage>(args, { cwd });
    if (!response.ok) return response;
    const connection = response.value?.data?.repository?.issue?.closedByPullRequestsReferences;
    if (!connection || !Array.isArray(connection.nodes) || !connection.pageInfo) return {
      ok: false as const,
      error: { code: 'PR_IDENTITY_INVALID', message: 'Closing pull request response is incomplete', retryable: false }
    };
    for (const node of connection.nodes) {
      const normalized = normalizeClosingPullRequest(node, repository);
      if (!normalized) return {
        ok: false as const,
        error: { code: 'PR_IDENTITY_INVALID', message: 'Closing pull request identity is incomplete', retryable: false }
      };
      candidates.push(normalized);
    }
    if (!connection.pageInfo.hasNextPage) return { ok: true as const, value: candidates };
    if (!connection.pageInfo.endCursor || connection.pageInfo.endCursor === cursor) return {
      ok: false as const,
      error: { code: 'PR_IDENTITY_INVALID', message: 'Closing pull request pagination cursor is invalid', retryable: false }
    };
    cursor = connection.pageInfo.endCursor;
  }
}

function expectedHead(repository: string, head: string): { repository: string; ref: string } {
  const colon = head.indexOf(':');
  if (colon === -1) return { repository, ref: head };
  const repoName = repository.split('/')[1] || '';
  return { repository: `${head.slice(0, colon)}/${repoName}`, ref: head.slice(colon + 1) };
}

function selectPullRequest(remotes: RemotePullRequest[], repository: string, head: string, base: string, expectedSha?: string):
  | { status: 'resolved'; pullRequest: PullRequestSnapshot }
  | { status: 'missing' | 'ambiguous' | 'head-mismatch'; pullRequest: null } {
  const wanted = expectedHead(repository, head);
  const matches = remotes.flatMap((remote) => {
    const normalized = normalizePullRequest(remote, repository);
    return normalized && normalized.state === 'open' && normalized.head.repository === wanted.repository &&
      normalized.head.ref === wanted.ref && normalized.base.repository === repository && normalized.base.ref === base
      ? [normalized] : [];
  });
  if (expectedSha && matches.some((match) => match.head.sha !== expectedSha)) {
    return { status: 'head-mismatch', pullRequest: null };
  }
  if (matches.length === 1) return { status: 'resolved', pullRequest: matches[0]! };
  return { status: matches.length === 0 ? 'missing' : 'ambiguous', pullRequest: null };
}

function validateBoundPullRequest(
  base: Awaited<ReturnType<typeof resolvedContext>> & { ok: true },
  pullRequest: PullRequestSnapshot | null,
  head: string,
  baseRef: string,
  expectedSha: string
): { ok: true } | { ok: false; error: { code: string; message: string; retryable: boolean } } {
  if (!pullRequest) return {
    ok: false,
    error: { code: 'PR_BIND_RECHECK_FAILED', message: 'Bound pull request identity is unavailable', retryable: false }
  };
  const wanted = expectedHead(base.context.platform.repository!, head);
  if (
    pullRequest.head.repository !== wanted.repository
    || pullRequest.head.ref !== wanted.ref
    || pullRequest.head.sha !== expectedSha
    || pullRequest.base.repository !== base.context.platform.repository
    || pullRequest.base.ref !== baseRef
  ) return {
    ok: false,
    error: { code: 'PR_BIND_IDENTITY_MISMATCH', message: 'Bound pull request identity does not match the current expected head/base', retryable: false }
  };
  return { ok: true };
}

type BindingIdentityOptions = {
  expectedHead?: string;
  expectedHeadSha?: string;
  errorCode?: string;
};

function resolveTaskDeliveryTarget(repoRoot: string, frontmatter: Record<string, unknown>) {
  const existing = {
    ...(typeof frontmatter.delivery_remote === 'string' && frontmatter.delivery_remote
      ? { remote: frontmatter.delivery_remote } : {}),
    ...(typeof frontmatter.delivery_base_ref === 'string' && frontmatter.delivery_base_ref
      ? { baseRef: frontmatter.delivery_base_ref } : {})
  };
  const target = resolveDeliveryTarget(repoRoot, existing);
  return target.ok
    ? { ok: true as const, value: target.value }
    : { ok: false as const, error: { code: target.code, message: target.message, retryable: false } };
}

function taskDeliveryTarget(base: Awaited<ReturnType<typeof resolvedContext>> & { ok: true }) {
  return resolveTaskDeliveryTarget(base.resolved.repoRoot, base.frontmatter);
}

function validateIdentityAgainstTarget(
  repository: string,
  target: { remote: string; baseRef: string },
  pullRequest: PullRequestSnapshot | null,
  options: BindingIdentityOptions = {}
): { ok: true } | { ok: false; error: { code: string; message: string; retryable: boolean } } {
  if (!pullRequest || !hasCompleteExternalIdentity(pullRequest)) return {
    ok: false,
    error: { code: options.errorCode || 'PR_BIND_IDENTITY_MISMATCH', message: 'Pull request identity is incomplete', retryable: false }
  };
  const wantedHead = options.expectedHead ? expectedHead(repository, options.expectedHead) : null;
  const matches = repositoryKey(pullRequest.repository) === repositoryKey(repository)
    && repositoryKey(pullRequest.base.repository) === repositoryKey(repository)
    && pullRequest.base.ref === target.baseRef
    && (!wantedHead || (repositoryKey(pullRequest.head.repository) === repositoryKey(wantedHead.repository) && pullRequest.head.ref === wantedHead.ref))
    && (!options.expectedHeadSha || pullRequest.head.sha === options.expectedHeadSha);
  if (!matches) return {
    ok: false,
    error: {
      code: options.errorCode || 'PR_BIND_IDENTITY_MISMATCH',
      message: 'Pull request identity does not match the task branch and delivery target',
      retryable: false
    }
  };
  return { ok: true };
}

function validateWriterIdentity(
  base: Awaited<ReturnType<typeof resolvedContext>> & { ok: true },
  pullRequest: PullRequestSnapshot | null,
  options: BindingIdentityOptions = {}
): { ok: true } | { ok: false; error: { code: string; message: string; retryable: boolean } } {
  const target = taskDeliveryTarget(base);
  if (!target.ok) return target;
  return validateIdentityAgainstTarget(base.context.platform.repository!, target.value, pullRequest, options);
}

function sameDeliveryIdentity(left: PullRequestSnapshot, right: PullRequestSnapshot): boolean {
  return JSON.stringify(deliveryIdentity(left)) === JSON.stringify(deliveryIdentity(right));
}

function validateExternalMergedEvidence(
  initial: PullRequestSnapshot,
  rechecked: PullRequestSnapshot
): { ok: true } | { ok: false; error: { code: string; message: string; retryable: boolean } } {
  if (
    initial.state !== 'closed'
    || !initial.mergedAt
    || !initial.mergeCommitSha
    || rechecked.state !== 'closed'
    || !rechecked.mergedAt
    || !rechecked.mergeCommitSha
    || initial.mergedAt !== rechecked.mergedAt
    || initial.mergeCommitSha !== rechecked.mergeCommitSha
  ) return {
    ok: false,
    error: { code: 'PR_EXTERNAL_IDENTITY_MISMATCH', message: 'Selected pull request merged evidence changed before task binding', retryable: false }
  };
  return { ok: true };
}

async function resolvedContext(taskRef: string, options: InspectionOptions) {
  const resolved = resolveTaskRef(taskRef, options.cwd ? { repoRoot: options.cwd } : {});
  if (!resolved.ok) return { ok: false as const, output: result('failed', resolved.taskId, null, null, {
    error: { code: resolved.code, message: resolved.message, retryable: false }
  }) };
  const content = fs.readFileSync(resolved.taskMdPath, 'utf8');
  const frontmatter = parseTypedTaskFrontmatter(content);
  const factRead = readPrDeliveryFact(frontmatter, options.runtimeVersion);
  if (factRead.status === 'invalid') return { ok: false as const, output: result('failed', resolved.taskId, null, null, {
    error: { code: factRead.error.code, message: factRead.error.message, retryable: false }
  }) };
  const fact = factRead.status === 'valid' ? factRead.fact : null;
  let issueIdentity: ResourceIdentity | null;
  try { issueIdentity = taskIssueIdentity(frontmatter, undefined, options.runtimeVersion); }
  catch (error) { return { ok: false as const, output: result('failed', resolved.taskId, null, null, { error: { ...taskIssueIdentityError(error), retryable: false } }) }; }
  const issueNumber = resourceIdentityNumber(issueIdentity);
  const prIdentity = fact?.state === 'bound' ? fact.identity.resource : null;
  const prNumber = resourceIdentityNumber(prIdentity);
  const client = options.client;
  const loaded = await resolvePlatformProviderContext({ cwd: resolved.repoRoot, client });
  const context = loaded.ok ? loaded.value.context : loaded.context;
  const usable = (context.status === 'no-op' || context.status === 'degraded') && context.platform.repository;
  if (!usable || !loaded.ok) return { ok: false as const, output: result(context.status, resolved.taskId, issueNumber, prNumber, {
    platform: context.platform, capabilities: context.capabilities, operations: context.operations, error: context.error
  }) };
  return { ok: true as const, resolved, content, frontmatter, fact, issueIdentity, issueNumber, prIdentity, prNumber, client, context, provider: loaded.value.provider, providerType: loaded.value.providerType, loadedContext: loaded.value };
}

function normalizeProviderPullRequest(
  remote: ProviderChangeRequestSnapshot,
  repository: string,
  fallbackNumber: number,
  fallback?: PullRequestSnapshot | null
): PullRequestSnapshot {
  const head = remote.head || fallback?.head || { repository, ref: '', sha: remote.headSha || '' };
  const base = remote.base || fallback?.base || { repository, ref: '', sha: remote.baseSha || '' };
  const identity = remote.identity || fallback?.identity || (remote.number ? { kind: 'number' as const, value: remote.number } : { kind: 'id' as const, value: remote.id });
  const snapshot: PullRequestSnapshot = {
    repository,
    number: remote.number ?? resourceIdentityNumber(identity) ?? fallbackNumber,
    nodeId: remote.id,
    url: remote.displayUrl || fallback?.url || '',
    state: remote.state === 'closed' ? 'closed' : 'open',
    title: remote.title,
    body: remote.body,
    draft: remote.draft ?? fallback?.draft ?? false,
    head: { ...head, sha: remote.headSha || head.sha },
    base: { ...base, sha: remote.baseSha || base.sha },
    mergedAt: remote.mergedAt ?? fallback?.mergedAt ?? null,
    mergeCommitSha: remote.mergeCommitSha ?? fallback?.mergeCommitSha ?? null,
    labels: [...(remote.labels || fallback?.labels || [])].sort(),
    assignees: [...(remote.assignees || fallback?.assignees || [])].sort(),
    milestone: remote.milestone ?? fallback?.milestone ?? null,
    mergeability: remote.mergeability || fallback?.mergeability || { state: 'unknown', detail: null }
  };
  Object.defineProperty(snapshot, 'identity', { value: identity, enumerable: false, configurable: true });
  return snapshot;
}

function pullRequestIdentity(pullRequest: PullRequestSnapshot): ResourceIdentity {
  return pullRequest.identity || { kind: 'number', value: pullRequest.number };
}

function providerPullRequestError(
  base: Awaited<ReturnType<typeof resolvedContext>> & { ok: true },
  error: { code: string; message: string; retryable: boolean },
  prNumber: number | null
): PullRequestResult {
  return result(error.code.startsWith('IN_LABEL_SYNC') ? 'blocked' : providerStatus(error), base.resolved.taskId, base.issueNumber, prNumber, {
    changed: error.code.startsWith('IN_LABEL_SYNC'),
    platform: base.context.platform,
    capabilities: base.context.capabilities,
    resource: { kind: 'pull-request', number: prNumber },
    error: providerError(error, 'PLATFORM_PROVIDER_OPERATION_FAILED')
  });
}

async function inspectExternalPullRequest(
  base: Awaited<ReturnType<typeof resolvedContext>> & { ok: true },
  prIdentity: ResourceIdentity
): Promise<PullRequestResult> {
  const prNumber = resourceIdentityNumber(prIdentity);
  const fallback = base.fact?.state === 'bound' && resourceIdentityEquals(base.fact.identity.resource, prIdentity)
    ? base.fact.identity as unknown as PullRequestSnapshot
    : null;
  const inspected = base.provider.changeRequests?.inspect
    ? await base.provider.changeRequests.inspect({ context: providerOperationContext(base.loadedContext), target: prIdentity })
    : unsupportedProviderOperation(base.provider, 'changeRequests.inspect');
  if (!inspected.ok) return providerPullRequestError(base, inspected.error, prNumber);
  const pullRequest = normalizeProviderPullRequest(inspected.value, base.context.platform.repository!, prNumber || 0, fallback);
  return result('no-op', base.resolved.taskId, base.issueNumber, prNumber, {
    platform: base.context.platform,
    capabilities: base.context.capabilities,
    resource: { kind: 'pull-request', number: prNumber, identity: prIdentity },
    pullRequest,
    error: null
  });
}

function inspectGitHubPullRequest(client: GitHubClient, repository: string, number: number, cwd: string) {
  const fetched = client.json<RemotePullRequest>(['api', `repos/${repository}/pulls/${number}`], { cwd });
  if (!fetched.ok) return fetched;
  const pullRequest = normalizePullRequest(fetched.value, repository);
  return pullRequest
    ? { ok: true as const, value: pullRequest }
    : { ok: false as const, error: { code: 'PR_IDENTITY_INVALID', message: 'Remote resource is not a valid pull request', retryable: false } };
}

async function inspectPlatformPullRequest(taskRef: string, options: InspectionOptions = {}): Promise<PullRequestResult> {
  const base = await resolvedContext(taskRef, options);
  if (!base.ok) return base.output;
  if (!base.fact) return result('no-op', base.resolved.taskId, base.issueNumber, null, {
    error: { code: 'PR_DELIVERY_FACT_MISSING', message: 'Task has no pr_delivery_fact; repair the task metadata or create a new task', retryable: false }
  });
  if (!base.prIdentity) return result('no-op', base.resolved.taskId, base.issueNumber, null, {
    platform: base.context.platform, capabilities: base.context.capabilities,
    error: { code: 'PR_NOT_LINKED', message: 'Task has no verified bound pull request', retryable: false }
  });
  return inspectExternalPullRequest(base, base.prIdentity);
}

async function inspectPlatformPullRequestByNumber(prNumber: string | number, options: InspectionOptions = {}): Promise<PullRequestResult> {
  const loaded = await resolvePlatformProviderContext({ cwd: options.cwd || process.cwd(), client: options.client });
  const context = loaded.ok ? loaded.value.context : loaded.context;
  const usable = (context.status === 'no-op' || context.status === 'degraded') && context.platform.repository;
  if (!usable) {
    return result(context.status, null, null, null, {
      platform: context.platform, capabilities: context.capabilities, operations: context.operations, error: context.error
    });
  }
  let identity: ResourceIdentity;
  try { identity = loaded.ok ? providerResourceToken(loaded.value.provider, 'pull-request', String(prNumber)) : resourceIdentity(prNumber); }
  catch (error) {
    return result('failed', null, null, null, {
      platform: context.platform, capabilities: context.capabilities,
      error: { code: 'PLATFORM_IDENTITY_TOKEN_INVALID', message: error instanceof Error ? error.message : String(error), retryable: false }
    });
  }
  if (loaded.ok) {
    const inspected = loaded.value.provider.changeRequests?.inspect
      ? await loaded.value.provider.changeRequests.inspect({ context: providerOperationContext(loaded.value), target: identity })
      : unsupportedProviderOperation(loaded.value.provider, 'changeRequests.inspect');
    const number = resourceIdentityNumber(identity);
    if (!inspected.ok) return result(providerStatus(inspected.error), null, null, number, {
      platform: context.platform, capabilities: context.capabilities,
      resource: { kind: 'pull-request', number, identity }, error: providerError(inspected.error, 'PLATFORM_PROVIDER_OPERATION_FAILED')
    });
    return result('no-op', null, null, number, {
      platform: context.platform, capabilities: context.capabilities,
      resource: { kind: 'pull-request', number, identity },
      pullRequest: normalizeProviderPullRequest(inspected.value, context.platform.repository!, number || 0), error: null
    });
  }
  return result('failed', null, null, null, {
    platform: context.platform, capabilities: context.capabilities,
    resource: { kind: 'pull-request', number: null },
    error: { code: 'PLATFORM_PROVIDER_LOAD_FAILED', message: 'Selected provider failed to load', retryable: false }
  });
}

function readInLabelMapping(repoRoot: string): { ok: true; value: Record<string, unknown> } | { ok: false; error: { code: string; message: string; retryable: boolean } } {
  try {
    const config = JSON.parse(fs.readFileSync(path.join(repoRoot, '.agents', '.airc.json'), 'utf8')) as {
      labels?: { in?: unknown };
    };
    const mapping = validateInLabelMapping(config.labels?.in);
    return mapping.ok ? { ok: true, value: mapping.value } : mapping;
  } catch (error) {
    return {
      ok: false,
      error: { code: 'IN_LABEL_SYNC_CONFIG_INVALID', message: error instanceof Error ? error.message : String(error), retryable: false }
    };
  }
}

function taskInLabelTarget(
  repoRoot: string,
  frontmatter: Record<string, unknown>,
  currentLabels: readonly string[],
  repositoryLabels: Set<string>
) {
  const baseRef = typeof frontmatter.delivery_base_ref === 'string' ? frontmatter.delivery_base_ref.trim() : '';
  if (!baseRef) return {
    ok: false as const,
    error: { code: 'IN_LABEL_SYNC_BASE_MISSING', message: 'Task has no delivery_base_ref for in-label evidence', retryable: false }
  };
  let changedFiles: string[];
  try {
    changedFiles = execFileSync('git', ['diff', `${baseRef}...HEAD`, '--name-only'], {
      cwd: repoRoot, encoding: 'utf8'
    }).trim().split(/\r?\n/).filter(Boolean);
  } catch (error) {
    return {
      ok: false as const,
      error: { code: 'IN_LABEL_SYNC_EVIDENCE_UNAVAILABLE', message: error instanceof Error ? error.message : String(error), retryable: false }
    };
  }
  const mapping = readInLabelMapping(repoRoot);
  if (!mapping.ok) return mapping;
  const planned = planInLabelUpdate({ changedFiles, currentLabels, mapping: mapping.value, repositoryLabels });
  if (planned.error) return { ok: false as const, error: planned.error };
  return { ok: true as const, value: planned.target };
}

function inLabelResource(
  kind: 'issue' | 'pull-request',
  number: number,
  before: string[],
  expected: string[],
  after: string[] | null,
  effect: 'no-op' | 'applied' | 'unknown'
) {
  return { kind, number, before: [...before].sort(), expected: [...expected].sort(), after: after ? [...after].sort() : null, effect };
}

async function syncPlatformPullRequestInLabels(prNumber: number, options: SharedOptions & { dryRun?: boolean } = {}): Promise<PullRequestResult> {
  const cwd = path.resolve(options.cwd || process.cwd());
  const loaded = await resolvePlatformProviderContext({ cwd, client: options.client });
  const context = loaded.ok ? loaded.value.context : loaded.context;
  const usable = (context.status === 'no-op' || context.status === 'degraded') && context.platform.repository;
  if (!loaded.ok || !usable) return result(context.status, null, null, prNumber, {
    platform: context.platform, capabilities: context.capabilities, operations: context.operations, error: context.error
  });
  if (!Number.isSafeInteger(prNumber) || prNumber <= 0) return result('failed', null, null, prNumber, {
    platform: context.platform, capabilities: context.capabilities,
    error: { code: 'PR_NUMBER_INVALID', message: 'PR number must be positive', retryable: false }
  });
  const provider = loaded.value.provider;
  const operationContext = providerOperationContext(loaded.value);
  const providerFailure = (error: { code: string; message: string; retryable: boolean }): PullRequestResult => result(
    error.code === 'PLATFORM_CAPABILITY_UNSUPPORTED' ? 'degraded' : providerStatus(error),
    null,
    null,
    prNumber,
    {
      platform: context.platform,
      capabilities: context.capabilities,
      resource: { kind: 'pull-request', number: prNumber },
      error: providerError(error, 'PLATFORM_PROVIDER_OPERATION_FAILED')
    }
  );
  const repository = context.platform.repository!;
  const pullRequestIdentity = providerResourceToken(provider, 'pull-request', String(prNumber));
  const inspected = provider.changeRequests?.inspect
    ? await provider.changeRequests.inspect({ context: operationContext, target: pullRequestIdentity })
    : unsupportedProviderOperation(provider, 'changeRequests.inspect');
  if (!inspected.ok) return providerFailure(inspected.error);
  const fetched = normalizeProviderPullRequest(inspected.value, repository, prNumber);
  const files = provider.changeRequests?.listFiles
    ? await provider.changeRequests.listFiles({ context: operationContext, target: pullRequestIdentity })
    : unsupportedProviderOperation(provider, 'changeRequests.listFiles');
  if (!files.ok) return providerFailure(files.error);
  const mapping = readInLabelMapping(cwd);
  if (!mapping.ok) return result('failed', null, null, prNumber, {
    platform: context.platform, capabilities: context.capabilities, pullRequest: fetched,
    resource: { kind: 'pull-request', number: prNumber }, error: mapping.error
  });
  let repositoryLabels = new Set<string>();
  if (Object.keys(mapping.value).length > 0) {
    const labels = provider.issues?.listLabels
      ? await provider.issues.listLabels({ context: operationContext })
      : unsupportedProviderOperation(provider, 'issues.listLabels');
    if (!labels.ok) return providerFailure(labels.error);
    repositoryLabels = new Set(labels.value);
  }
  const plannedTarget = planInLabelUpdate({
    changedFiles: files.value, currentLabels: fetched.labels,
    mapping: mapping.value, repositoryLabels
  });
  if (plannedTarget.error) return result('failed', null, null, prNumber, {
    platform: context.platform, capabilities: context.capabilities, pullRequest: fetched,
    resource: { kind: 'pull-request', number: prNumber }, error: plannedTarget.error
  });
  const association = provider.changeRequests?.listClosingIssues
    ? await provider.changeRequests.listClosingIssues({ context: operationContext, target: pullRequestIdentity })
    : unsupportedProviderOperation(provider, 'changeRequests.listClosingIssues');
  if (!association.ok) return providerFailure(association.error);

  const issueIdentity = association.value.length === 1 ? association.value[0]! : null;
  const issueNumber = issueIdentity ? resourceIdentityNumber(issueIdentity) : null;
  if (issueIdentity && issueNumber === null) {
    return result('degraded', null, null, prNumber, {
      platform: context.platform,
      capabilities: context.capabilities,
      pullRequest: fetched,
      resource: { kind: 'pull-request', number: prNumber },
      evidence: { kind: 'pull-request-files', pullRequestFiles: files.value },
      error: { code: 'IN_LABEL_SYNC_ASSOCIATION_UNSUPPORTED', message: 'The associated Issue identity cannot be represented by this operation', retryable: false }
    });
  }
  const closingIssueNumbers = association.value.flatMap((identity) => {
    const number = resourceIdentityNumber(identity);
    return number === null ? [] : [number];
  });
  let issue: ProviderIssueSnapshot | null = null;
  if (issueIdentity) {
    const fetchedIssue = provider.issues?.inspect
      ? await provider.issues.inspect({ context: operationContext, target: issueIdentity })
      : unsupportedProviderOperation(provider, 'issues.inspect');
    if (!fetchedIssue.ok) return providerFailure(fetchedIssue.error);
    issue = fetchedIssue.value;
  }

  const resources = issue
    ? [
      { kind: 'issue' as const, number: issueNumber!, snapshot: issue },
      { kind: 'pull-request' as const, number: prNumber, snapshot: fetched }
    ]
    : [{ kind: 'pull-request' as const, number: prNumber, snapshot: fetched }];
  const plans = resources.map((resource) => ({
    ...resource,
    plan: planInLabelUpdate({
      changedFiles: files.value, currentLabels: resource.snapshot.labels,
      mapping: mapping.value, repositoryLabels
    })
  }));
  const operations: PlatformOperation[] = [
    { name: 'closing-issues', status: 'no-op', reasonCode: association.value.length === 1 ? null : association.value.length === 0 ? 'ISSUE_ASSOCIATION_NONE' : 'ISSUE_ASSOCIATION_AMBIGUOUS' },
    ...plans.map((item) => ({
      name: `labels:in:${item.kind}`,
      status: !context.capabilities.triage ? 'skipped' as const : item.plan.changed ? 'planned' as const : 'no-op' as const,
      reasonCode: !context.capabilities.triage ? 'TRIAGE_REQUIRED' : null
    }))
  ];
  const willWrite = context.capabilities.triage && !options.dryRun;
  const resourcesState = plans.map((item) => inLabelResource(
    item.kind,
    item.number,
    item.snapshot.labels,
    item.plan.target,
    item.plan.changed && willWrite ? null : item.snapshot.labels,
    item.plan.changed && willWrite ? 'unknown' : 'no-op'
  ));
  if (options.dryRun || !context.capabilities.triage) return result(
    !context.capabilities.triage || association.value.length !== 1 ? 'degraded' : plans.some((item) => item.plan.changed) ? 'planned' : 'no-op',
    null, issueNumber, prNumber, {
      platform: context.platform, capabilities: context.capabilities, pullRequest: fetched,
      resource: { kind: 'pull-request', number: prNumber }, operations, resources: resourcesState,
      evidence: { kind: 'pull-request-files', pullRequestFiles: files.value, closingIssues: closingIssueNumbers }, error: null
    }
  );

  let currentPullRequest = fetched;
  let successfulWrites = 0;
  for (const item of plans) {
    if (!item.plan.changed) continue;
    const targetIdentity = item.kind === 'issue' ? issueIdentity! : pullRequestIdentity;
    const synced = item.kind === 'issue'
      ? provider.issues?.update
        ? await provider.issues.update({
          context: operationContext,
          target: targetIdentity,
          currentLabels: item.snapshot.labels,
          patch: { labels: item.plan.labels },
          mutation: { idempotencyKey: `issue:update:${item.number}:in-labels`, target: targetIdentity }
        })
        : unsupportedProviderOperation(provider, 'issues.update')
      : provider.changeRequests?.update
        ? await provider.changeRequests.update({
          context: operationContext,
          target: targetIdentity,
          currentLabels: item.snapshot.labels,
          patch: { labels: item.plan.labels },
          mutation: { idempotencyKey: `pull-request:update:${item.number}:in-labels`, target: targetIdentity }
        })
        : unsupportedProviderOperation(provider, 'changeRequests.update');
    if (!synced.ok) {
      const state = resourcesState.find((resource) => resource.kind === item.kind && resource.number === item.number)!;
      state.effect = synced.error.retryable ? 'unknown' : 'no-op';
      state.after = state.effect === 'unknown' ? null : item.snapshot.labels;
      const partial = successfulWrites > 0 || synced.error.retryable;
      const error = partial
        ? { ...synced.error, code: 'IN_LABEL_SYNC_PARTIAL', message: `In-label synchronization is partial or unknown: ${synced.error.message}` }
        : synced.error;
      return result(partial ? 'blocked' : providerStatus(synced.error), null, issueNumber, prNumber, {
        changed: successfulWrites > 0, platform: context.platform, capabilities: context.capabilities,
        pullRequest: currentPullRequest, resource: { kind: 'pull-request', number: prNumber }, operations, resources: resourcesState,
        evidence: { kind: 'pull-request-files', pullRequestFiles: files.value, closingIssues: closingIssueNumbers }, error: providerError(error, 'PLATFORM_PROVIDER_OPERATION_FAILED')
      });
    }
    successfulWrites += synced.value.changed ? 1 : 0;
    const reread = item.kind === 'issue'
      ? provider.issues?.inspect
        ? await provider.issues.inspect({ context: operationContext, target: targetIdentity })
        : unsupportedProviderOperation(provider, 'issues.inspect')
      : provider.changeRequests?.inspect
        ? await provider.changeRequests.inspect({ context: operationContext, target: targetIdentity })
        : unsupportedProviderOperation(provider, 'changeRequests.inspect');
    if (!reread.ok) return result('blocked', null, issueNumber, prNumber, {
      changed: true, platform: context.platform, capabilities: context.capabilities,
      pullRequest: currentPullRequest, resource: { kind: 'pull-request', number: prNumber }, operations, resources: resourcesState,
      evidence: { kind: 'pull-request-files', pullRequestFiles: files.value, closingIssues: closingIssueNumbers },
      error: { ...providerError(reread.error, 'PLATFORM_PROVIDER_OPERATION_FAILED'), code: 'IN_LABEL_SYNC_PARTIAL', message: `In-label synchronization is partial or unknown: ${reread.error.message}` }
    });
    const after = reread.value.labels || [];
    const state = resourcesState.find((resource) => resource.kind === item.kind && resource.number === item.number)!;
    state.after = after;
    state.effect = after.filter((label: string) => label.startsWith('in:')).sort().join('\0') === item.plan.target.join('\0') ? 'applied' : 'unknown';
    if (state.effect === 'unknown') return result('blocked', null, issueNumber, prNumber, {
      changed: true, platform: context.platform, capabilities: context.capabilities,
      pullRequest: currentPullRequest, resource: { kind: 'pull-request', number: prNumber }, operations, resources: resourcesState,
      evidence: { kind: 'pull-request-files', pullRequestFiles: files.value, closingIssues: closingIssueNumbers },
      error: { code: 'IN_LABEL_SYNC_PARTIAL', message: `${item.kind} #${item.number} did not converge to the expected in: labels`, retryable: true }
    });
    if (item.kind === 'pull-request') currentPullRequest = normalizeProviderPullRequest(reread.value as ProviderChangeRequestSnapshot, repository, prNumber, currentPullRequest);
  }
  return result(association.value.length !== 1 ? 'degraded' : successfulWrites > 0 ? 'applied' : 'no-op', null, issueNumber, prNumber, {
    changed: successfulWrites > 0, platform: context.platform, capabilities: context.capabilities,
    pullRequest: currentPullRequest, resource: { kind: 'pull-request', number: prNumber },
    operations: operations.map((operation) => operation.status === 'planned' ? { ...operation, status: 'applied' as const } : operation),
    resources: resourcesState, evidence: { kind: 'pull-request-files', pullRequestFiles: files.value, closingIssues: closingIssueNumbers }, error: null
  });
}

function appendActivity(content: string, line: string): string {
  const body = extractSection(content, ['活动日志', 'Activity Log']);
  return `${body.replace(/\s+$/, '')}${body.trim() ? '\n' : ''}${line}`;
}

function deliveryIdentity(pullRequest: PullRequestSnapshot) {
  return {
    resource: pullRequestIdentity(pullRequest),
    repository: pullRequest.repository,
    url: pullRequest.url,
    head: { ...pullRequest.head },
    base: { ...pullRequest.base }
  };
}

function factTimestamp(timestamp: string): string {
  return new Date(timestamp.replace(' ', 'T')).toISOString();
}

function boundFactFor(
  pullRequest: PullRequestSnapshot,
  source: PrDeliveryBindingSource,
  issue: number | ResourceIdentity | null,
  verifiedAt: string
): PrDeliveryFact {
  return buildBoundFact({
    identity: deliveryIdentity(pullRequest),
    source,
    ...(typeof issue === 'object' ? { issueIdentity: issue } : { issueNumber: issue }),
    verifiedAt: factTimestamp(verifiedAt),
    remoteState: pullRequest.state,
    mergedAt: pullRequest.state === 'closed' ? pullRequest.mergedAt : null,
    mergeCommitSha: pullRequest.state === 'closed' ? pullRequest.mergeCommitSha : null
  });
}

function writeCreateStarted(base: Awaited<ReturnType<typeof resolvedContext>> & { ok: true }, agent: string) {
  const starts = (base.content.match(/\*\*Create PR \[started\]\*\*/g) || []).length;
  const dones = (base.content.match(/\*\*Create PR\*\*/g) || []).length;
  if (starts > dones) return { status: 'no-op' as const };
  const metadata = captureTaskWriteMetadata();
  return writeTask({
    taskRef: base.resolved.taskId,
    expectedState: 'active',
    mutations: [{ kind: 'section', aliases: ['活动日志', 'Activity Log'], heading: '活动日志', body: appendActivity(
      base.content, `- ${metadata.timestamp} — **Create PR [started]** by ${agent} — started`
    ) }]
  }, { repoRoot: base.resolved.repoRoot, metadataProvider: () => metadata });
}

function bindIdentity(
  base: Awaited<ReturnType<typeof resolvedContext>> & { ok: true },
  pullRequest: PullRequestSnapshot,
  agent: string,
  source: PrDeliveryBindingSource,
  dryRun = false,
  expectedHead?: string,
  expectedHeadSha?: string
) {
  const identity = validateWriterIdentity(base, pullRequest, {
    expectedHead: source === 'explicit-bind' ? String(base.frontmatter.branch || '') : expectedHead,
    expectedHeadSha,
    errorCode: 'PR_BIND_IDENTITY_MISMATCH'
  });
  if (!identity.ok) return { status: 'failed' as const, error: identity.error };
  if (base.prIdentity && !resourceIdentityEquals(base.prIdentity, pullRequestIdentity(pullRequest))) return { status: 'failed' as const, error: {
    code: 'PR_BIND_CONFLICT', message: 'Task is already bound to a different pull request identity'
  } };
  if (base.prIdentity && resourceIdentityEquals(base.prIdentity, pullRequestIdentity(pullRequest)) && base.fact?.state === 'bound') {
    if (JSON.stringify(base.fact.identity) !== JSON.stringify(deliveryIdentity(pullRequest))) return { status: 'failed' as const, error: {
      code: 'PR_BIND_IDENTITY_MISMATCH', message: `Task binding for PR #${pullRequest.number} does not match the fetched pull request identity`
    } };
    return { status: 'no-op' as const, error: null };
  }
  const current = fs.readFileSync(base.resolved.taskMdPath, 'utf8');
  const metadata = captureTaskWriteMetadata();
  const fact = boundFactFor(pullRequest, source, taskIssueIdentity(base.frontmatter), metadata.timestamp);
  const factMutation = factFrontmatterMutation(fact);
  return writeTask({
    taskRef: base.resolved.taskId,
    expectedState: 'active',
    dryRun,
    mutations: [
      { kind: 'frontmatter', set: { ...factMutation.set, assigned_to: agent } },
      { kind: 'section', aliases: ['活动日志', 'Activity Log'], heading: '活动日志', body: appendActivity(
        current, `- ${metadata.timestamp} — **Create PR** by ${agent} — PR #${pullRequest.number} created → ${pullRequest.url}`
      ) }
    ]
  }, { repoRoot: base.resolved.repoRoot, metadataProvider: () => metadata });
}

async function bindPlatformPullRequest(taskRef: string, options: BindOptions): Promise<PullRequestResult> {
  const base = await resolvedContext(taskRef, options);
  if (!base.ok) return base.output;
  if (!base.fact) return result('failed', base.resolved.taskId, base.issueNumber, null, {
    error: { code: 'PR_DELIVERY_FACT_MISSING', message: 'Task has no pr_delivery_fact; repair the task metadata or create a new task', retryable: false }
  });
  let prIdentity: ResourceIdentity;
  try { prIdentity = providerResourceToken(base.provider, 'pull-request', String(options.pr)); }
  catch (error) { return result('failed', base.resolved.taskId, base.issueNumber, base.prNumber, { error: { code: 'PLATFORM_IDENTITY_TOKEN_INVALID', message: error instanceof Error ? error.message : String(error), retryable: false } }); }
  const requestedNumber = resourceIdentityNumber(prIdentity);
  if (base.prIdentity && !resourceIdentityEquals(base.prIdentity, prIdentity)) return result('failed', base.resolved.taskId, base.issueNumber, base.prNumber, {
    error: { code: 'PR_BIND_CONFLICT', message: 'Task is already bound to a different pull request identity', retryable: false }
  });
  const inspected = await inspectExternalPullRequest(base, prIdentity);
  if (inspected.status === 'failed' || inspected.status === 'blocked' || !inspected.pullRequest) return inspected;
  const initialIdentity = validateWriterIdentity(base, inspected.pullRequest, {
    expectedHead: String(base.frontmatter.branch || ''),
    errorCode: 'PR_BIND_IDENTITY_MISMATCH'
  });
  if (!initialIdentity.ok) return result('failed', base.resolved.taskId, base.issueNumber, requestedNumber, {
    pullRequest: inspected.pullRequest, error: initialIdentity.error
  });
  const written = bindIdentity(base, inspected.pullRequest, options.agent, 'explicit-bind', options.dryRun);
  if (written.status === 'failed') return result('failed', base.resolved.taskId, base.issueNumber, requestedNumber, {
    pullRequest: inspected.pullRequest, error: { code: written.error.code, message: written.error.message, retryable: false }
  });
  return result(options.dryRun ? 'planned' : written.status === 'no-op' ? 'no-op' : 'applied', base.resolved.taskId, base.issueNumber, options.dryRun ? base.prNumber : inspected.pullRequest.number, {
    changed: !options.dryRun && written.status === 'applied', platform: base.context.platform, capabilities: base.context.capabilities,
    resource: { kind: 'pull-request', number: inspected.pullRequest.number, identity: pullRequestIdentity(inspected.pullRequest) }, pullRequest: inspected.pullRequest,
    operations: [{ name: 'task:bind-pr', status: options.dryRun ? 'planned' : written.status === 'no-op' ? 'no-op' : 'applied', reasonCode: null }], error: null
  });
}

function externalEvidenceNote(
  issueIdentity: ResourceIdentity | null,
  source: 'unique' | 'explicit',
  pullRequest: PullRequestSnapshot
): string {
  return [
    `authorization=${source}`,
    externalIdentityEvidenceNote(issueIdentity, pullRequest)
  ].join('; ');
}

function externalIdentityEvidenceNote(
  issueIdentity: ResourceIdentity | null,
  pullRequest: PullRequestSnapshot
): string {
  const issueLabel = issueIdentity
    ? issueIdentity.kind === 'number' ? `#${issueIdentity.value}` : `${issueIdentity.kind}:${issueIdentity.value}`
    : 'unknown';
  return [
    `issue=${issueLabel}`,
    `pr=#${pullRequest.number}`,
    `url=${pullRequest.url}`,
    `base=${pullRequest.base.repository}:${pullRequest.base.ref}@${pullRequest.base.sha}`,
    `head=${pullRequest.head.repository}:${pullRequest.head.ref}@${pullRequest.head.sha}`,
    `mergedAt=${pullRequest.mergedAt}`,
    `mergeCommitSha=${pullRequest.mergeCommitSha}`
  ].join('; ');
}

async function resolveExternalPullRequest(taskRef: string, options: ResolveExternalOptions): Promise<ExternalPullRequestResult> {
  const base = await resolvedContext(taskRef, options);
  if (!base.ok) return externalResult(base.output);
  if (!base.fact) return externalResult(result('failed', base.resolved.taskId, base.issueNumber, null, {
    error: { code: 'PR_DELIVERY_FACT_MISSING', message: 'Task has no pr_delivery_fact; repair the task metadata or create a new task', retryable: false }
  }));
  const inventory = inspectCompletionArtifacts(base.resolved.taskId, { repoRoot: base.resolved.repoRoot });
  if (inventory.status === 'failed') return externalResult(result('failed', base.resolved.taskId, base.issueNumber, base.prNumber, {
    platform: base.context.platform,
    capabilities: base.context.capabilities,
    error: { code: inventory.error?.code || 'ARTIFACT_TOPOLOGY_CONFLICT', message: inventory.error?.message || 'Completion artifact inventory failed', retryable: false }
  }));
  if (inventory.artifacts.length > 0) {
    if (options.pr !== undefined) return externalResult(result('failed', base.resolved.taskId, base.issueNumber, base.prNumber, {
      platform: base.context.platform,
      capabilities: base.context.capabilities,
      error: { code: 'EXTERNAL_DELIVERY_NOT_APPLICABLE', message: 'External PR selection is only valid when the completion inventory is empty', retryable: false }
    }), { mode: 'normal' });
    return externalResult(result('no-op', base.resolved.taskId, base.issueNumber, base.prNumber, {
      platform: base.context.platform,
      capabilities: base.context.capabilities,
      operations: [{ name: 'external-pr:inventory', status: 'no-op', reasonCode: 'CANONICAL_ARTIFACTS_PRESENT' }],
      error: null
    }), { mode: 'normal' });
  }
  if (!base.issueIdentity) return externalResult(result('failed', base.resolved.taskId, null, base.prNumber, {
    platform: base.context.platform,
    capabilities: base.context.capabilities,
    error: { code: 'EXTERNAL_DELIVERY_ISSUE_REQUIRED', message: 'External delivery requires a valid issue_number', retryable: false }
  }));
  const inspected = base.provider.changeRequests?.listClosing
    ? await base.provider.changeRequests.listClosing({
      context: providerOperationContext(base.loadedContext),
      issue: base.issueIdentity
    })
    : unsupportedProviderOperation(base.provider, 'changeRequests.listClosing');
  if (!inspected.ok || !inspected.value) {
    const error = 'error' in inspected && inspected.error
      ? inspected.error
      : { code: 'PR_IDENTITY_INVALID', message: 'Closing PR inspection returned no candidates', retryable: false };
    return externalResult(result(error.retryable ? 'blocked' : 'failed', base.resolved.taskId, base.issueNumber, base.prNumber, {
      platform: base.context.platform, capabilities: base.context.capabilities, error
    }));
  }
  const candidates = (inspected.value as ProviderChangeRequestSnapshot[]).map((item) => normalizeProviderPullRequest(item, base.context.platform.repository!, item.number || 0));
  let explicitPrIdentity: ResourceIdentity | null = null;
  if (options.pr !== undefined) {
    try { explicitPrIdentity = providerResourceToken(base.provider, 'pull-request', String(options.pr)); }
    catch (error) {
      return externalResult(result('failed', base.resolved.taskId, base.issueNumber, base.prNumber, {
        platform: base.context.platform, capabilities: base.context.capabilities,
        error: { code: 'PLATFORM_IDENTITY_TOKEN_INVALID', message: error instanceof Error ? error.message : String(error), retryable: false }
      }));
    }
  }
  const selected = selectExternalPullRequest(
    candidates,
    base.context.platform.repository!,
    base.prIdentity,
    explicitPrIdentity
  );
  if (selected.status === 'normal') return externalResult(result('no-op', base.resolved.taskId, base.issueNumber, base.prNumber, {
    platform: base.context.platform,
    capabilities: base.context.capabilities,
    operations: [{ name: 'external-pr:select', status: 'no-op', reasonCode: 'NO_ELIGIBLE_CANDIDATE' }],
    error: null
  }), { mode: 'normal', candidates: selected.candidates, eligible: selected.eligible });
  if (selected.status === 'failed') return externalResult(result('failed', base.resolved.taskId, base.issueNumber, base.prNumber, {
    platform: base.context.platform,
    capabilities: base.context.capabilities,
    error: { code: selected.code, message: selected.message, retryable: false }
  }), { candidates: selected.candidates, eligible: selected.eligible });

  const initialIdentity = validateWriterIdentity(base, selected.selected, { errorCode: 'PR_EXTERNAL_IDENTITY_MISMATCH' });
  if (!initialIdentity.ok) return externalResult(result('failed', base.resolved.taskId, base.issueNumber, base.prNumber, {
    platform: base.context.platform, capabilities: base.context.capabilities,
    pullRequest: selected.selected, error: initialIdentity.error
  }), { candidates: selected.candidates, eligible: selected.eligible, selected: selected.selected });
  const rechecked = base.provider.changeRequests?.inspect
    ? await base.provider.changeRequests.inspect({
      context: providerOperationContext(base.loadedContext),
      target: pullRequestIdentity(selected.selected)
    }).then((response) => response.ok
      ? { ok: true as const, value: normalizeProviderPullRequest(response.value, base.context.platform.repository!, selected.selected.number, selected.selected) }
      : response)
    : unsupportedProviderOperation(base.provider, 'changeRequests.inspect');
  if (!rechecked.ok || !rechecked.value) return externalResult(result(rechecked.ok ? 'failed' : rechecked.error.retryable ? 'blocked' : 'failed', base.resolved.taskId, base.issueNumber, base.prNumber, {
    platform: base.context.platform, capabilities: base.context.capabilities,
    pullRequest: selected.selected,
    error: rechecked.ok ? { code: 'PR_EXTERNAL_RECHECK_FAILED', message: 'Selected pull request recheck returned no identity', retryable: false } : rechecked.error
  }), { candidates: selected.candidates, eligible: selected.eligible, selected: selected.selected });
  if (!sameDeliveryIdentity(selected.selected, rechecked.value)) return externalResult(result('failed', base.resolved.taskId, base.issueNumber, base.prNumber, {
    platform: base.context.platform, capabilities: base.context.capabilities,
    pullRequest: rechecked.value,
    error: { code: 'PR_EXTERNAL_IDENTITY_MISMATCH', message: 'Selected pull request identity changed before task binding', retryable: false }
  }), { candidates: selected.candidates, eligible: selected.eligible, selected: rechecked.value });
  const finalIdentity = validateWriterIdentity(base, rechecked.value, { errorCode: 'PR_EXTERNAL_IDENTITY_MISMATCH' });
  if (!finalIdentity.ok) return externalResult(result('failed', base.resolved.taskId, base.issueNumber, base.prNumber, {
    platform: base.context.platform, capabilities: base.context.capabilities,
    pullRequest: rechecked.value, error: finalIdentity.error
  }), { candidates: selected.candidates, eligible: selected.eligible, selected: rechecked.value });
  const finalEvidence = validateExternalMergedEvidence(selected.selected, rechecked.value);
  if (!finalEvidence.ok) return externalResult(result('failed', base.resolved.taskId, base.issueNumber, base.prNumber, {
    platform: base.context.platform, capabilities: base.context.capabilities,
    pullRequest: rechecked.value, error: finalEvidence.error
  }), { candidates: selected.candidates, eligible: selected.eligible, selected: rechecked.value });
  const selectedPullRequest = rechecked.value;
  const note = externalEvidenceNote(base.issueIdentity, selected.source, selectedPullRequest);
  const identityNote = externalIdentityEvidenceNote(base.issueIdentity, selectedPullRequest);
  const activityEntry = `**Bind External PR** by ${options.agent} — ${note}`;
  const auditLines = base.content.split(/\r?\n/).filter((line) => line.includes('**Bind External PR**'));
  const alreadyAudited = auditLines.some((line) => line.endsWith(identityNote));
  if (auditLines.length > 0 && !alreadyAudited) return externalResult(result('failed', base.resolved.taskId, base.issueNumber, base.prNumber, {
    platform: base.context.platform,
    capabilities: base.context.capabilities,
    pullRequest: selectedPullRequest,
    error: { code: 'PR_BIND_CONFLICT', message: 'Existing external PR audit evidence conflicts with the selected identity', retryable: false }
  }), { candidates: selected.candidates, eligible: selected.eligible, selected: selectedPullRequest });
  if (alreadyAudited && base.prIdentity && !resourceIdentityEquals(base.prIdentity, pullRequestIdentity(selectedPullRequest))) return externalResult(result('failed', base.resolved.taskId, base.issueNumber, base.prNumber, {
    platform: base.context.platform,
    capabilities: base.context.capabilities,
    pullRequest: selectedPullRequest,
    error: { code: 'PR_BIND_CONFLICT', message: 'External PR audit evidence does not match the task binding', retryable: false }
  }), { candidates: selected.candidates, eligible: selected.eligible, selected: selectedPullRequest });
  if (base.prIdentity && resourceIdentityEquals(base.prIdentity, pullRequestIdentity(selectedPullRequest)) && alreadyAudited) {
    return externalResult(result('no-op', base.resolved.taskId, base.issueNumber, base.prNumber, {
      platform: base.context.platform,
      capabilities: base.context.capabilities,
      resource: { kind: 'pull-request', number: selectedPullRequest.number },
      pullRequest: selectedPullRequest,
      operations: [{ name: 'task:bind-external-pr', status: 'no-op', reasonCode: 'EVIDENCE_ALREADY_RECORDED' }],
      error: null
    }), { mode: 'external', authorization: selected.source, candidates: selected.candidates, eligible: selected.eligible, selected: selectedPullRequest });
  }
  const metadata = captureTaskWriteMetadata();
  const write = writeTask({
    taskRef: base.resolved.taskId,
    expectedState: 'active',
    dryRun: options.dryRun,
    mutations: [
      { kind: 'frontmatter', set: { ...factFrontmatterMutation(boundFactFor(selectedPullRequest, selected.source === 'unique' ? 'external-unique' : 'external-explicit', base.issueNumber, metadata.timestamp)).set, assigned_to: options.agent } },
      { kind: 'section', aliases: ['活动日志', 'Activity Log'], heading: '活动日志', body: appendActivity(
        base.content, `- ${metadata.timestamp} — ${activityEntry}`
      ) }
    ]
  }, { repoRoot: base.resolved.repoRoot, metadataProvider: () => metadata });
  if (write.status === 'failed') return externalResult(result('failed', base.resolved.taskId, base.issueNumber, base.prNumber, {
    platform: base.context.platform,
    capabilities: base.context.capabilities,
    pullRequest: selectedPullRequest,
    error: { code: write.error.code, message: write.error.message, retryable: false }
  }), { candidates: selected.candidates, eligible: selected.eligible, selected: selectedPullRequest });
  const operationStatus = options.dryRun ? 'planned' : write.status === 'applied' ? 'applied' : 'no-op';
  return externalResult(result(operationStatus, base.resolved.taskId, base.issueNumber, options.dryRun ? base.prNumber : selectedPullRequest.number, {
    changed: !options.dryRun && write.changed,
    platform: base.context.platform,
    capabilities: base.context.capabilities,
    resource: { kind: 'pull-request', number: selectedPullRequest.number },
    pullRequest: selectedPullRequest,
    operations: [{ name: 'task:bind-external-pr', status: operationStatus, reasonCode: null }],
    error: null
  }), { mode: 'external', authorization: selected.source, candidates: selected.candidates, eligible: selected.eligible, selected: selectedPullRequest });
}

async function createPlatformPullRequest(taskRef: string, options: CreateOptions): Promise<PullRequestResult> {
  const base = await resolvedContext(taskRef, options);
  if (!base.ok) return withCreation(base.output, PRECONDITION_NOT_CREATED);
  if (!options.base || !options.head || !options.title.trim() || !options.body.trim()) {
    return withCreation(result('failed', base.resolved.taskId, base.issueNumber, base.prNumber, {
      error: { code: 'PR_PAYLOAD_INVALID', message: 'base, head, title and body are required', retryable: false }
    }), PRECONDITION_NOT_CREATED);
  }
  try {
    return withTaskExecutionLock(
      base.resolved.repoRoot,
      base.resolved.taskId,
      'platform-pr.create',
      () => createExternalPullRequest(taskRef, options, base)
    );
  } catch (error) {
    if (error instanceof TaskExecutionLockError) {
      return withCreation(result('blocked', base.resolved.taskId, base.issueNumber, null, {
        platform: base.context.platform,
        capabilities: base.context.capabilities,
        error: { code: error.code, message: error.message, retryable: true }
      }), PRECONDITION_NOT_CREATED);
    }
    return withCreation(result('failed', base.resolved.taskId, base.issueNumber, null, {
      platform: base.context.platform,
      capabilities: base.context.capabilities,
      error: {
        code: 'PR_CREATE_FAILED',
        message: error instanceof Error ? error.message : String(error),
        retryable: false
      }
    }), PRECONDITION_NOT_CREATED);
  }
}

async function createExternalPullRequest(
  taskRef: string,
  options: CreateOptions,
  base: Extract<Awaited<ReturnType<typeof resolvedContext>>, { ok: true }>
): Promise<PullRequestResult> {
  if (!base.fact) return withCreation(result('failed', base.resolved.taskId, base.issueNumber, null, {
    error: { code: 'PR_DELIVERY_FACT_MISSING', message: 'Task has no pr_delivery_fact; repair the task metadata or create a new task', retryable: false }
  }), PRECONDITION_NOT_CREATED);
  const target = taskDeliveryTarget(base);
  if (!target.ok) return withCreation(result('failed', base.resolved.taskId, base.issueNumber, base.prNumber, {
    error: target.error
  }), PRECONDITION_NOT_CREATED);
  if (options.base !== target.value.baseRef) return withCreation(result('failed', base.resolved.taskId, base.issueNumber, base.prNumber, {
    platform: base.context.platform,
    capabilities: base.context.capabilities,
    error: { code: 'PR_DELIVERY_TARGET_MISMATCH', message: `Pull request base '${options.base}' does not match delivery target '${target.value.baseRef}'`, retryable: false }
  }), PRECONDITION_NOT_CREATED);
  let verifiedHeadSha: string | undefined;
  if (base.provider.changeRequests?.verifyHead) {
    const verified = await base.provider.changeRequests.verifyHead({
      context: providerOperationContext(base.loadedContext),
      head: options.head
    });
    if (!verified.ok) return withCreation(providerPullRequestError(base, verified.error, base.prNumber), PRECONDITION_NOT_CREATED);
    verifiedHeadSha = verified.value.sha;
  }
  if (base.prIdentity) {
    const inspected = await inspectExternalPullRequest(base, base.prIdentity!);
    return inspected.status === 'failed' || inspected.status === 'blocked'
      ? withCreation(inspected, PRECONDITION_NOT_CREATED)
      : withCreation({ ...inspected, result: 'no_op' }, { kind: 'no-op', createdByCurrentOperation: false });
  }
  if (options.dryRun) return withCreation(result('planned', base.resolved.taskId, base.issueNumber, null, {
    platform: base.context.platform,
    capabilities: base.context.capabilities,
    operations: [{ name: 'pr:create', status: 'planned', reasonCode: null }],
    result: 'pr_created',
    error: null
  }), { kind: 'planned', action: 'create', createdByCurrentOperation: false });

  const started = writeCreateStarted(base, options.agent);
  if (started.status === 'failed') return withCreation(result('failed', base.resolved.taskId, base.issueNumber, null, {
    error: { code: started.error.code, message: started.error.message, retryable: false }
  }), PRECONDITION_NOT_CREATED);
  const created = base.provider.changeRequests?.create
    ? await base.provider.changeRequests.create({
      context: providerOperationContext(base.loadedContext),
      base: options.base,
      head: options.head,
      title: options.title,
      body: options.body,
      draft: Boolean(options.draft),
      mutation: { idempotencyKey: `pull-request:create:${base.resolved.taskId}` }
    })
    : unsupportedProviderOperation(base.provider, 'changeRequests.create');
  if (!created.ok) return withCreation(providerPullRequestError(base, created.error, null), { kind: 'unknown', errorCode: 'PR_CREATE_OUTCOME_UNKNOWN' });
  const remoteId = String(created.value.remoteId || '');
  let createdIdentity: ResourceIdentity;
  try { createdIdentity = providerResourceIdentity(base.provider, 'pull-request', remoteId); }
  catch (error) {
    return withCreation(result('failed', base.resolved.taskId, base.issueNumber, null, {
      platform: base.context.platform, capabilities: base.context.capabilities,
      error: { code: 'PR_CREATE_RESPONSE_INVALID', message: error instanceof Error ? error.message : String(error), retryable: false }
    }), { kind: 'created', createdByCurrentOperation: true });
  }
  const number = resourceIdentityNumber(createdIdentity);
  const fallbackNumber = number ?? 0;
  const fallback = normalizeProviderPullRequest({
    id: remoteId,
    identity: createdIdentity,
    number: number || undefined,
    state: 'open',
    title: options.title,
    body: options.body,
    headSha: '',
    baseSha: '',
    head: { repository: base.context.platform.repository!, ref: options.head, sha: '' },
    base: { repository: base.context.platform.repository!, ref: options.base, sha: '' },
    displayUrl: `${base.provider.type}:${remoteId}`
  }, base.context.platform.repository!, fallbackNumber);
  const inspected = base.provider.changeRequests?.inspect
    ? await base.provider.changeRequests.inspect({
      context: providerOperationContext(base.loadedContext),
      target: createdIdentity
    })
    : unsupportedProviderOperation(base.provider, 'changeRequests.inspect');
  if (!inspected.ok) return withCreation(providerPullRequestError(base, inspected.error, number), { kind: 'created', createdByCurrentOperation: true });
  const pullRequest = normalizeProviderPullRequest(
    inspected.value,
    base.context.platform.repository!,
    inspected.value.number ?? fallback.number,
    fallback
  );
  if (!pullRequest.nodeId || !isUsableResourceIdentity(pullRequestIdentity(pullRequest))) return withCreation(result('failed', base.resolved.taskId, base.issueNumber, null, {
    platform: base.context.platform,
    capabilities: base.context.capabilities,
    error: { code: 'PR_CREATE_RESPONSE_INVALID', message: 'Provider create response lacks validated identity', retryable: false }
  }), { kind: 'created', createdByCurrentOperation: true });
  const identity = validateWriterIdentity(base, pullRequest, {
    expectedHead: options.head,
    expectedHeadSha: verifiedHeadSha,
    errorCode: 'PR_BIND_IDENTITY_MISMATCH'
  });
  if (!identity.ok) return withCreation(result('failed', base.resolved.taskId, base.issueNumber, pullRequest.number, {
    platform: base.context.platform,
    capabilities: base.context.capabilities,
    resource: { kind: 'pull-request', number: pullRequest.number },
    pullRequest,
    error: identity.error
  }), { kind: 'created', createdByCurrentOperation: true });
  const bound = bindIdentity(base, pullRequest, options.agent, 'created', false, options.head);
  if (bound.status === 'failed') return withCreation(result('failed', base.resolved.taskId, base.issueNumber, pullRequest.number, {
    platform: base.context.platform,
    capabilities: base.context.capabilities,
    resource: { kind: 'pull-request', number: pullRequest.number },
    pullRequest,
    error: { code: 'PR_CREATED_BIND_FAILED', message: `${pullRequest.url}: ${bound.error.message}`, retryable: false }
  }), { kind: 'created', createdByCurrentOperation: true });
  return withCreation(result('applied', base.resolved.taskId, base.issueNumber, pullRequest.number, {
    changed: true,
    platform: base.context.platform,
    capabilities: base.context.capabilities,
    resource: { kind: 'pull-request', number: pullRequest.number },
    pullRequest,
    operations: [{ name: 'pr:create', status: 'applied', reasonCode: null }, { name: 'task:bind-pr', status: 'applied', reasonCode: null }],
    result: 'pr_created',
    error: null
  }), { kind: 'created', createdByCurrentOperation: true });
}

async function syncPlatformPullRequest(taskRef: string, options: SyncOptions): Promise<PullRequestResult> {
  const warningResult = warningResultForPrimary(options.primaryResult);
  const softenFailure = (output: PullRequestResult): PullRequestResult => {
    const authorityError = output.error?.code.startsWith('IN_LABEL_SYNC') || output.error?.code.startsWith('PR_IDENTITY');
    const warning = output.error && output.task.prNumber !== null
      && !authorityError
      && !['PR_NOT_LINKED', 'PR_BIND_CONFLICT'].includes(output.error.code)
      ? {
        code: output.error.code,
        message: output.error.message,
        retryable: output.error.retryable,
        step: 'pr-metadata',
        target: `pull-request:${output.task.prNumber}`,
        severity: 'ACTION_REQUIRED' as const
      }
      : null;
    return warning
      ? { ...output, status: 'applied', changed: false, error: null, result: warningResult, warnings: mergeOperationWarnings([warning]) }
      : output;
  };
  const base = await resolvedContext(taskRef, options);
  if (!base.ok) return softenFailure(base.output);
  if (!base.fact) return softenFailure(result('failed', base.resolved.taskId, base.issueNumber, null, {
    error: { code: 'PR_DELIVERY_FACT_MISSING', message: 'Task has no pr_delivery_fact; repair the task metadata or create a new task', retryable: false }
  }));
  if (!base.prIdentity) return softenFailure(result('failed', base.resolved.taskId, base.issueNumber, null, {
    error: { code: 'PR_NOT_LINKED', message: 'Task has no verified bound pull request', retryable: false }
  }));
  {
    const inspected = await inspectExternalPullRequest(base, base.prIdentity!);
    if (inspected.status === 'failed' || inspected.status === 'blocked' || !inspected.pullRequest) return softenFailure(inspected);
    if (!options.metadata && !options.closingIssue) return softenFailure(result('failed', base.resolved.taskId, base.issueNumber, base.prNumber, {
      error: { code: 'PR_PAYLOAD_INVALID', message: 'sync requires a desired-state option', retryable: false }
    }));
    const issue = await inspectPlatformIssue(taskRef, { cwd: base.resolved.repoRoot, client: base.client });
    if (!issue.issue) return softenFailure(result(issue.status, base.resolved.taskId, base.issueNumber, base.prNumber, {
      platform: base.context.platform, capabilities: base.context.capabilities, pullRequest: inspected.pullRequest, error: issue.error
    }));
    let inLabels = inspected.pullRequest.labels.filter((label) => label.startsWith('in:')).sort();
    let issueInLabelOperation: PlatformOperation | null = null;
    if (options.metadata && base.provider.issues?.listLabels) {
      const labels = await base.provider.issues.listLabels({ context: providerOperationContext(base.loadedContext) });
      if (!labels.ok) return softenFailure(providerPullRequestError(base, labels.error, base.prNumber));
      const target = taskInLabelTarget(base.resolved.repoRoot, base.frontmatter, inspected.pullRequest.labels, new Set(labels.value));
      if (!target.ok) return softenFailure(providerPullRequestError(base, target.error, base.prNumber));
      inLabels = target.value;
      const currentIssueLabels = issue.issue.labels.filter((label) => label.startsWith('in:')).sort();
      issueInLabelOperation = base.context.capabilities.triage
        ? currentIssueLabels.join('\0') === inLabels.join('\0')
          ? { name: 'labels:in:issue', status: 'no-op', reasonCode: null }
          : { name: 'labels:in:issue', status: 'planned', reasonCode: null }
        : { name: 'labels:in:issue', status: 'skipped', reasonCode: 'TRIAGE_REQUIRED' };
    }
    const planned = planPullRequestMetadata({
      pullRequest: inspected.pullRequest,
      issue: issue.issue,
      taskType: String(base.frontmatter.type || 'task'),
      issueNumber: base.issueNumber,
      capabilities: base.context.capabilities,
      inLabels
    }).operations.filter((operation) => options.metadata || operation.name === 'closing-issue')
      .filter((operation) => options.closingIssue || operation.name !== 'closing-issue');
    const operations: PlatformOperation[] = [
      ...(issueInLabelOperation ? [issueInLabelOperation] : []),
      ...planned.map(({ name, status, reasonCode }) => ({ name, status, reasonCode }))
    ];
    const milestoneOperation = planned.find((operation) => operation.name === 'milestone' && operation.status === 'planned');
    if (milestoneOperation && base.provider.issues?.listMilestones) {
      const milestones = await base.provider.issues.listMilestones({ context: providerOperationContext(base.loadedContext) });
      if (!milestones.ok) return providerPullRequestError(base, milestones.error, base.prNumber);
    }
    if (options.dryRun) return softenFailure(result(planned.some((operation) => operation.status === 'planned') ? 'planned' : 'no-op', base.resolved.taskId, base.issueNumber, base.prNumber, {
      platform: base.context.platform, capabilities: base.context.capabilities, pullRequest: inspected.pullRequest, operations, error: null
    }));
    let issueChanged = false;
    if (issueInLabelOperation?.status === 'planned') {
      const desiredIssueLabels = [...new Set([
        ...issue.issue.labels.filter((label) => !label.startsWith('in:')),
        ...inLabels
      ])].sort();
      const updatedIssue = base.provider.issues?.update
        ? await base.provider.issues.update({
          context: providerOperationContext(base.loadedContext),
          target: base.issueIdentity!,
          currentLabels: issue.issue.labels,
          patch: { labels: desiredIssueLabels },
          mutation: { idempotencyKey: `issue:update:${base.resolved.taskId}:in-labels` }
        })
        : unsupportedProviderOperation(base.provider, 'issues.update');
      if (!updatedIssue.ok) return softenFailure(providerPullRequestError(base, updatedIssue.error, base.prNumber));
      issueChanged = updatedIssue.value.changed;
      const rereadIssue = base.provider.issues?.inspect
        ? await base.provider.issues.inspect({ context: providerOperationContext(base.loadedContext), target: base.issueIdentity! })
        : unsupportedProviderOperation(base.provider, 'issues.inspect');
      if (!rereadIssue.ok) return softenFailure(providerPullRequestError(base, {
        ...rereadIssue.error,
        code: 'IN_LABEL_SYNC_PARTIAL',
        message: `In-label synchronization is partial or unknown: ${rereadIssue.error.message}`
      }, base.prNumber));
      const actualIssueLabels = rereadIssue.value.labels.filter((label) => label.startsWith('in:')).sort();
      if (actualIssueLabels.join('\0') !== inLabels.join('\0')) return softenFailure(providerPullRequestError(base, {
        code: 'IN_LABEL_SYNC_PARTIAL',
        message: 'Issue in: labels did not converge after update',
        retryable: true
      }, base.prNumber));
    }
    const patch: Record<string, unknown> = {};
    for (const operation of planned) {
      if (operation.status !== 'planned') continue;
      if (operation.name === 'labels') patch.labels = operation.value;
      if (operation.name === 'assignees') patch.assignees = operation.value;
      if (operation.name === 'closing-issue') patch.body = operation.value;
      if (operation.name === 'milestone') patch.milestone = operation.value;
    }
    if (Object.keys(patch).length === 0) return softenFailure(result(planned.some((operation) => operation.status === 'skipped') ? 'degraded' : 'no-op', base.resolved.taskId, base.issueNumber, base.prNumber, {
      platform: base.context.platform, capabilities: base.context.capabilities, resource: { kind: 'pull-request', number: base.prNumber }, pullRequest: inspected.pullRequest, operations, error: null
    }));
    const updated = base.provider.changeRequests?.update
      ? await base.provider.changeRequests.update({
        context: providerOperationContext(base.loadedContext),
        target: base.prIdentity,
        currentLabels: inspected.pullRequest.labels,
        patch: patch as never,
        mutation: { idempotencyKey: `pull-request:update:${base.resolved.taskId}` }
      })
      : unsupportedProviderOperation(base.provider, 'changeRequests.update');
    if (!updated.ok) {
      const error = issueChanged && !updated.error.code.startsWith('IN_LABEL_SYNC')
        ? { ...updated.error, code: 'IN_LABEL_SYNC_PARTIAL', message: `In-label synchronization is partial or unknown: ${updated.error.message}` }
        : updated.error;
      return softenFailure(providerPullRequestError(base, error, base.prNumber));
    }
    let finalPullRequest = inspected.pullRequest;
    if (planned.some((operation) => operation.name === 'labels' && operation.status === 'planned')) {
      const reread = base.provider.changeRequests?.inspect
        ? await base.provider.changeRequests.inspect({ context: providerOperationContext(base.loadedContext), target: base.prIdentity })
        : unsupportedProviderOperation(base.provider, 'changeRequests.inspect');
      if (!reread.ok) return softenFailure(providerPullRequestError(base, {
        ...reread.error,
        code: 'IN_LABEL_SYNC_PARTIAL',
        message: `In-label synchronization is partial or unknown: ${reread.error.message}`
      }, base.prNumber));
      finalPullRequest = normalizeProviderPullRequest(reread.value, base.context.platform.repository!, base.prNumber || 0, inspected.pullRequest);
      const expected = ((planned.find((operation) => operation.name === 'labels')?.value as string[] || [])
        .filter((label) => label.startsWith('in:') || label.startsWith('type:'))).sort();
      const actual = finalPullRequest.labels.filter((label) => label.startsWith('in:') || label.startsWith('type:')).sort();
      if (actual.join('\0') !== expected.join('\0')) return softenFailure(providerPullRequestError(base, {
        code: 'IN_LABEL_SYNC_PARTIAL',
        message: 'Pull request labels did not converge after update',
        retryable: true
      }, base.prNumber));
    }
    return softenFailure(result(planned.some((operation) => operation.status === 'skipped') ? 'degraded' : 'applied', base.resolved.taskId, base.issueNumber, base.prNumber, {
      changed: issueChanged || updated.value.changed,
      platform: base.context.platform,
      capabilities: base.context.capabilities,
      resource: { kind: 'pull-request', number: base.prNumber },
      pullRequest: finalPullRequest,
      operations: operations.map((operation) => operation.status === 'planned' ? { ...operation, status: 'applied' } : operation),
      error: null
    }));
  }
}

function readProjectPrFlow(repoRoot: string): 'required' | 'disabled' | undefined {
  try {
    const config = JSON.parse(fs.readFileSync(path.join(repoRoot, '.agents', '.airc.json'), 'utf8')) as { prFlow?: unknown };
    return config.prFlow === 'required' || config.prFlow === 'disabled' ? config.prFlow : undefined;
  } catch {
    return undefined;
  }
}

function skipPlatformPullRequestFactUnlocked(
  resolved: Extract<ReturnType<typeof resolveTaskRef>, { ok: true }>,
  options: SkipFactOptions
): PullRequestResult {
  let content: string;
  let frontmatter: ReturnType<typeof parseTypedTaskFrontmatter>;
  try {
    content = fs.readFileSync(resolved.taskMdPath, 'utf8');
    frontmatter = parseTypedTaskFrontmatter(content);
  } catch (error) {
    return result('failed', resolved.taskId, null, null, {
      error: { code: 'TASK_DOCUMENT_INVALID', message: error instanceof Error ? error.message : String(error), retryable: false }
    });
  }
  let issueIdentity: ResourceIdentity | null;
  try { issueIdentity = taskIssueIdentity(frontmatter, undefined, options.runtimeVersion); }
  catch (error) { return result('failed', resolved.taskId, null, null, { error: { ...taskIssueIdentityError(error), retryable: false } }); }
  const issueNumber = resourceIdentityNumber(issueIdentity);
  const existing = readPrDeliveryFact(frontmatter, options.runtimeVersion);
  if (existing.status === 'invalid') return result('failed', resolved.taskId, issueNumber, null, {
    error: { code: existing.error.code, message: existing.error.message, retryable: false }
  });
  if (existing.status === 'missing') return result('failed', resolved.taskId, issueNumber, null, {
    error: { code: 'PR_DELIVERY_FACT_MISSING', message: 'Task has no pr_delivery_fact; repair the task metadata or create a new task', retryable: false }
  });
  if (existing.fact.state === 'skipped') return result('no-op', resolved.taskId, issueNumber, null, {
    operations: [{ name: 'task:skip-pr', status: 'no-op', reasonCode: null }],
    error: null
  });
  if (existing.fact.state === 'bound') {
    const boundNumber = resourceIdentityNumber(existing.fact.identity.resource);
    return result('failed', resolved.taskId, issueNumber, boundNumber, {
      error: { code: 'PR_DELIVERY_FACT_CONFLICT', message: `Task is already bound to PR ${boundNumber === null ? 'identity' : `#${boundNumber}`}`, retryable: false }
    });
  }
  if (readProjectPrFlow(resolved.repoRoot) === 'required') return result('failed', resolved.taskId, issueNumber, null, {
    error: { code: 'PR_SKIP_FORBIDDEN', message: 'Cannot skip PR delivery when prFlow is required', retryable: false }
  });

  const metadata = captureTaskWriteMetadata();
  const fact = buildSkippedFact(factTimestamp(metadata.timestamp));
  const write = writeTask({
    taskRef: resolved.taskId,
    expectedState: 'active',
    dryRun: options.dryRun,
    mutations: [
      { kind: 'frontmatter', set: { ...factFrontmatterMutation(fact).set, assigned_to: options.agent } },
      { kind: 'section', aliases: ['活动日志', 'Activity Log'], heading: '活动日志', body: appendActivity(
        content, `- ${metadata.timestamp} — **Skip PR** by ${options.agent} — PR delivery explicitly skipped`
      ) }
    ]
  }, { repoRoot: resolved.repoRoot, metadataProvider: () => metadata });
  if (write.status === 'failed') return result('failed', resolved.taskId, issueNumber, null, {
    error: { code: write.error.code, message: write.error.message, retryable: false }
  });
  const status = options.dryRun ? 'planned' : write.status === 'no-op' ? 'no-op' : 'applied';
  return result(status, resolved.taskId, issueNumber, null, {
    changed: !options.dryRun && write.changed,
    operations: [{ name: 'task:skip-pr', status, reasonCode: null }],
    error: null
  });
}

async function skipPlatformPullRequestFact(taskRef: string, options: SkipFactOptions): Promise<PullRequestResult> {
  const resolved = resolveTaskRef(taskRef, options.cwd ? { repoRoot: options.cwd } : {});
  if (!resolved.ok) return result('failed', resolved.taskId, null, null, {
    error: { code: resolved.code, message: resolved.message, retryable: false }
  });
  if (resolved.state !== 'active') return result('failed', resolved.taskId, null, null, {
    error: { code: 'TASK_STATE_INVALID', message: 'platform-pr skip requires an active task', retryable: false }
  });
  try {
    return withTaskExecutionLock(
      resolved.repoRoot,
      resolved.taskId,
      'platform-pr.skip',
      () => skipPlatformPullRequestFactUnlocked(resolved, options)
    );
  } catch (error) {
    if (error instanceof TaskExecutionLockError) return result('blocked', resolved.taskId, null, null, {
      error: { code: error.code, message: error.message, retryable: true }
    });
    return result('failed', resolved.taskId, null, null, {
      error: { code: 'PR_SKIP_FAILED', message: error instanceof Error ? error.message : String(error), retryable: false }
    });
  }
}

export {
  bindPlatformPullRequest,
  createPlatformPullRequest,
  inspectGitHubPullRequest,
  inspectGitHubIssueClosingChangeRequests,
  inspectPlatformPullRequest,
  inspectPlatformPullRequestByNumber,
  normalizePullRequest,
  resolveExternalPullRequest,
  skipPlatformPullRequestFact,
  selectExternalPullRequest,
  selectPullRequest,
  syncPlatformPullRequest,
  syncPlatformPullRequestInLabels
};
export type { BindOptions, CreateOptions, ExternalPullRequestResult, ExternalPullRequestSelection, PullRequestPrimaryResult, PullRequestResult, PullRequestSnapshot, ResolveExternalOptions, SkipFactOptions, SyncOptions };
export { warningResultForPrimary };
