import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

import { parseTypedTaskFrontmatter } from '../task/frontmatter.ts';
import { resolveTaskRef } from '../task/resolve-ref.ts';
import { extractSection } from '../task/sections.ts';
import { captureTaskWriteMetadata, writeTask } from '../task/write.ts';
import {
  inspectPlatformChangeRequest,
  inspectPlatformIssueClosingChangeRequests,
  registerPlatformCapabilities
} from './adapters.ts';
import type { PlatformChangeRequestSnapshot } from './adapters.ts';
import { parseGitHubRemote, resolvePlatformContext } from './context.ts';
import { createGitHubClient } from './github-client.ts';
import type { GitHubClient } from './github-client.ts';
import { inspectPlatformIssue } from './issues.ts';
import { planPullRequestMetadata } from './pull-request-metadata.ts';
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

type PullRequestSnapshot = PlatformChangeRequestSnapshot;

type PullRequestResult = PlatformResult & {
  task: { id: string | null; issueNumber: number | null; prNumber: number | null };
  pullRequest: PullRequestSnapshot | null;
  result: 'pr_created' | 'pr_reused' | 'no_op' | 'pr_created_with_warnings' | 'pr_reused_with_warnings' | 'no_op_with_warnings' | 'failed' | 'blocked' | null;
  creation: CreationOutcome | null;
  warnings: readonly OperationWarning[];
};
type InspectionOptions = { cwd?: string; client?: unknown };
type SharedOptions = { cwd?: string; client?: GitHubClient };
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
type BindOptions = SharedOptions & { agent: string; pr: number; dryRun?: boolean };
type PullRequestPrimaryResult = 'pr_created' | 'pr_reused' | 'no_op';
type SyncOptions = SharedOptions & { agent: string; metadata?: boolean; closingIssue?: boolean; dryRun?: boolean; primaryResult: PullRequestPrimaryResult };
type ResolveExternalOptions = SharedOptions & { agent: string; pr?: number; dryRun?: boolean };
type MigrateFactOptions = SharedOptions & { state: 'unbound' | 'skipped' | 'bound'; pr?: number; dryRun?: boolean };
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

function identitySignature(pullRequest: PullRequestSnapshot): string {
  return [
    pullRequest.repository, pullRequest.number, pullRequest.nodeId, pullRequest.url,
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
  return Number.isInteger(pullRequest.number) && pullRequest.number > 0 &&
    required.every((value) => Boolean(value?.trim())) &&
    (pullRequest.state === 'open' || Boolean(pullRequest.mergedAt) === Boolean(pullRequest.mergeCommitSha));
}

function selectExternalPullRequest(
  candidates: PullRequestSnapshot[],
  repository: string,
  existingPrNumber: number | null,
  explicitPrNumber: number | null
): ExternalPullRequestSelection {
  const invalid = candidates.find((candidate) => !hasCompleteExternalIdentity(candidate));
  if (invalid) return {
    status: 'failed', code: 'PR_IDENTITY_INVALID',
    message: `Closing PR #${invalid.number} lacks required identity`, candidates, eligible: []
  };
  const byNumber = new Map<number, string>();
  for (const candidate of candidates) {
    const signature = identitySignature(candidate);
    const prior = byNumber.get(candidate.number);
    if (prior && prior !== signature) return {
      status: 'failed', code: 'PR_IDENTITY_INVALID',
      message: `Closing PR #${candidate.number} has conflicting identities`, candidates, eligible: []
    };
    byNumber.set(candidate.number, signature);
  }
  const unique = candidates.filter((candidate, index) =>
    candidates.findIndex((other) => other.number === candidate.number) === index
  );
  const wantedRepository = repositoryKey(repository);
  const eligible = unique.filter((candidate) =>
    repositoryKey(candidate.repository) === wantedRepository &&
    repositoryKey(candidate.base.repository) === wantedRepository &&
    candidate.state === 'closed' &&
    Boolean(candidate.mergedAt && candidate.mergeCommitSha)
  );
  if (explicitPrNumber !== null) {
    const selected = unique.find((candidate) => candidate.number === explicitPrNumber);
    if (!selected) return { status: 'failed', code: 'PR_NOT_FOUND', message: `PR #${explicitPrNumber} is not a closing PR`, candidates, eligible };
    if (!eligible.some((candidate) => candidate.number === explicitPrNumber)) {
      return { status: 'failed', code: 'PR_IDENTITY_INVALID', message: `PR #${explicitPrNumber} is not an eligible merged PR`, candidates, eligible };
    }
    if (existingPrNumber !== null && existingPrNumber !== explicitPrNumber) {
      return { status: 'failed', code: 'PR_BIND_CONFLICT', message: `Task is already bound to PR #${existingPrNumber}`, candidates, eligible };
    }
    return { status: 'selected', source: 'explicit', selected, candidates, eligible };
  }
  if (existingPrNumber !== null && eligible.length === 1 && existingPrNumber !== eligible[0]!.number) {
    return { status: 'failed', code: 'PR_BIND_CONFLICT', message: `Task is already bound to PR #${existingPrNumber}`, candidates, eligible };
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

function repositoryHead(cwd: string): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
  }).trim();
}

function remoteBranchHead(cwd: string, repository: string, head: string):
  | { ok: true; value: string }
  | { ok: false; error: { code: string; message: string; retryable: boolean } } {
  const wanted = expectedHead(repository, head);
  if (!wanted.ref || !/^[A-Za-z0-9._/-]+$/.test(wanted.ref)) return {
    ok: false,
    error: { code: 'PR_HEAD_INVALID', message: 'Pull request head ref is invalid', retryable: false }
  };
  const remotes = configuredGitRemotes(cwd);
  const remote = remotes.find((item) => repositoryKey(item.repository) === repositoryKey(wanted.repository))
    ?? remotes.find((item) => item.name === 'origin');
  if (!remote) return {
    ok: false,
    error: { code: 'PR_REMOTE_BRANCH_MISSING', message: `No configured remote can verify ${wanted.repository}:${wanted.ref}`, retryable: false }
  };
  try {
    const output = execFileSync('git', ['ls-remote', '--refs', remote.name, `refs/heads/${wanted.ref}`], {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
    }).trim();
    const match = output.split(/\r?\n/).map((line) => line.trim()).find((line) => line.endsWith(`refs/heads/${wanted.ref}`));
    const sha = match?.split(/\s+/)[0] || null;
    if (!sha || !/^[a-f0-9]{40}$/i.test(sha)) return {
      ok: false,
      error: { code: 'PR_REMOTE_BRANCH_MISSING', message: `Remote branch ${wanted.repository}:${wanted.ref} does not exist`, retryable: false }
    };
    return { ok: true, value: sha };
  } catch (error) {
    return {
      ok: false,
      error: { code: 'PR_REMOTE_BRANCH_UNAVAILABLE', message: error instanceof Error ? error.message : String(error), retryable: true }
    };
  }
}

function verifyCreateHead(base: ReturnType<typeof resolvedContext> & { ok: true }, head: string) {
  let localHead: string;
  try {
    localHead = repositoryHead(base.resolved.repoRoot);
  } catch (error) {
    return { ok: false as const, error: { code: 'PR_LOCAL_HEAD_UNAVAILABLE', message: error instanceof Error ? error.message : String(error), retryable: false } };
  }
  const remote = remoteBranchHead(base.resolved.repoRoot, base.context.platform.repository!, head);
  if (!remote.ok) return remote;
  if (remote.value !== localHead) return {
    ok: false as const,
    error: { code: 'PR_REMOTE_HEAD_MISMATCH', message: `Remote head ${remote.value} does not match local HEAD ${localHead}`, retryable: false }
  };
  return { ok: true as const, value: localHead };
}

function validateBoundPullRequest(
  base: ReturnType<typeof resolvedContext> & { ok: true },
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

function taskDeliveryTarget(base: ReturnType<typeof resolvedContext> & { ok: true }) {
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
  base: ReturnType<typeof resolvedContext> & { ok: true },
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

function resolvedContext(taskRef: string, options: InspectionOptions) {
  const resolved = resolveTaskRef(taskRef, options.cwd ? { repoRoot: options.cwd } : {});
  if (!resolved.ok) return { ok: false as const, output: result('failed', resolved.taskId, null, null, {
    error: { code: resolved.code, message: resolved.message, retryable: false }
  }) };
  const content = fs.readFileSync(resolved.taskMdPath, 'utf8');
  const frontmatter = parseTypedTaskFrontmatter(content);
  const factRead = readPrDeliveryFact(frontmatter);
  if (factRead.status === 'invalid') return { ok: false as const, output: result('failed', resolved.taskId, null, null, {
    error: { code: 'PR_DELIVERY_FACT_INVALID', message: factRead.error.message, retryable: false }
  }) };
  const fact = factRead.status === 'valid' ? factRead.fact : null;
  const issue = Number(frontmatter.issue_number);
  const pr = fact?.state === 'bound' ? fact.identity.number : NaN;
  const issueNumber = Number.isInteger(issue) && issue > 0 ? issue : null;
  const prNumber = Number.isInteger(pr) && pr > 0 ? pr : null;
  const client = (options.client as GitHubClient | undefined) || createGitHubClient();
  const context = resolvePlatformContext({ cwd: resolved.repoRoot, client });
  const usable = (context.status === 'no-op' || context.status === 'degraded') && context.platform.repository;
  if (!usable) return { ok: false as const, output: result(context.status, resolved.taskId, issueNumber, prNumber, {
    platform: context.platform, capabilities: context.capabilities, operations: context.operations, error: context.error
  }) };
  return { ok: true as const, resolved, content, frontmatter, fact, issueNumber, prNumber, client, context };
}

function inspectGitHubPullRequest(client: GitHubClient, repository: string, number: number, cwd: string) {
  const fetched = client.json<RemotePullRequest>(['api', `repos/${repository}/pulls/${number}`], { cwd });
  if (!fetched.ok) return fetched;
  const pullRequest = normalizePullRequest(fetched.value, repository);
  return pullRequest
    ? { ok: true as const, value: pullRequest }
    : { ok: false as const, error: { code: 'PR_IDENTITY_INVALID', message: 'Remote resource is not a valid pull request', retryable: false } };
}

function configuredGitRemotes(cwd: string): Array<{ name: string; url: string; repository: string }> {
  try {
    return execFileSync('git', ['remote'], {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
    }).split(/\r?\n/).filter(Boolean).flatMap((name) => {
      try {
        const url = execFileSync('git', ['config', '--get', `remote.${name}.url`], {
          cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
        }).trim();
        const repository = parseGitHubRemote(url);
        return repository ? [{ name, url, repository }] : [];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

function rewriteGitHubRemote(remote: string, repository: string): string | null {
  const match = remote.trim().match(
    /^(https?:\/\/github\.com\/|ssh:\/\/(?:git@)?github\.com\/|git@github\.com:)[^/\s]+\/[^/\s]+(?:\.git)?$/i
  );
  return match ? `${match[1]}${repository}.git` : null;
}

function resolveGitHubChangeRequestGitEvidence({
  cwd,
  repository,
  pullRequest
}: {
  cwd: string;
  repository: string;
  pullRequest: PullRequestSnapshot;
}) {
  if (
    pullRequest.repository !== repository ||
    pullRequest.base.repository !== repository ||
    pullRequest.number <= 0
  ) {
    return {
      ok: false as const,
      error: {
        code: 'PR_MERGE_EVIDENCE_SOURCE_UNAVAILABLE',
        message: 'Pull request repository identity is inconsistent',
        retryable: false
      }
    };
  }
  const reviewedHeadRef = `refs/pull/${pullRequest.number}/head`;
  const targetHeadRef = `refs/heads/${pullRequest.base.ref}`;
  const refValid = (ref: string) => {
    try {
      execFileSync('git', ['check-ref-format', ref], {
        cwd, encoding: 'utf8', stdio: ['ignore', 'ignore', 'ignore']
      });
      return true;
    } catch {
      return false;
    }
  };
  if (!refValid(reviewedHeadRef) || !refValid(targetHeadRef)) {
    return {
      ok: false as const,
      error: {
        code: 'PR_MERGE_EVIDENCE_SOURCE_UNAVAILABLE',
        message: 'Pull request Git refs are invalid',
        retryable: false
      }
    };
  }

  const remotes = configuredGitRemotes(cwd);
  const exact = remotes
    .filter((remote) => remote.repository === repository)
    .sort((left, right) => Number(right.name === 'origin') - Number(left.name === 'origin') ||
      left.name.localeCompare(right.name))[0];
  const origin = remotes.find((remote) => remote.name === 'origin');
  const remoteUrl = exact?.url || (origin ? rewriteGitHubRemote(origin.url, repository) : null);
  if (!remoteUrl) {
    return {
      ok: false as const,
      error: {
        code: 'PR_MERGE_EVIDENCE_SOURCE_UNAVAILABLE',
        message: `No GitHub remote can provide evidence for ${repository}`,
        retryable: false
      }
    };
  }
  return {
    ok: true as const,
    value: { remoteUrl, reviewedHeadRef, targetHeadRef }
  };
}

registerPlatformCapabilities('github', {
  inspectChangeRequest({ client, repository, number, cwd }) {
    return inspectGitHubPullRequest((client as GitHubClient | undefined) || createGitHubClient(), repository, number, cwd);
  },
  inspectIssueClosingChangeRequests({ client, repository, issueNumber, cwd }) {
    return inspectGitHubIssueClosingChangeRequests(
      (client as GitHubClient | undefined) || createGitHubClient(), repository, issueNumber, cwd
    );
  },
  resolveChangeRequestGitEvidence(context) {
    return resolveGitHubChangeRequestGitEvidence(context);
  }
});

function locatePullRequest(base: ReturnType<typeof resolvedContext> & { ok: true }, head: string, target: string, expectedSha?: string) {
  const repository = base.context.platform.repository!;
  const listed = base.client.json<RemotePullRequest[]>([
    'api', `repos/${repository}/pulls?state=open&base=${encodeURIComponent(target)}&per_page=100`
  ], { cwd: base.resolved.repoRoot });
  if (!listed.ok) return listed;
  const selected = selectPullRequest(listed.value, repository, head, target, expectedSha);
  return selected.status === 'resolved'
    ? { ok: true as const, value: selected.pullRequest }
    : { ok: false as const, error: {
      code: selected.status === 'ambiguous' ? 'PR_IDENTITY_AMBIGUOUS'
        : selected.status === 'head-mismatch' ? 'PR_HEAD_SHA_MISMATCH' : 'PR_NOT_FOUND',
      message: selected.status === 'ambiguous' ? 'Multiple pull requests match the exact head/base identity'
        : selected.status === 'head-mismatch' ? 'A pull request matches head/base but not the expected head SHA'
          : 'No pull request matches the exact head/base identity',
      retryable: false
    } };
}

function inspectPlatformPullRequest(taskRef: string, options: InspectionOptions = {}): PullRequestResult {
  const base = resolvedContext(taskRef, options);
  if (!base.ok) return base.output;
  if (!base.fact) return result('no-op', base.resolved.taskId, base.issueNumber, null, {
    error: { code: 'PR_DELIVERY_FACT_MISSING', message: 'Task has no pr_delivery_fact; migrate the task before inspecting a PR', retryable: false }
  });
  if (!base.prNumber) return result('no-op', base.resolved.taskId, base.issueNumber, null, {
    platform: base.context.platform, capabilities: base.context.capabilities,
    error: { code: 'PR_NOT_LINKED', message: 'Task has no verified bound pull request', retryable: false }
  });
  const fetched = inspectPlatformChangeRequest(base.context.platform.type, {
    cwd: base.resolved.repoRoot,
    repository: base.context.platform.repository!,
    number: base.prNumber,
    client: options.client || base.client
  });
  if (!fetched.ok || !fetched.value) {
    const error = fetched.error || {
      code: 'PR_INSPECTION_INVALID',
      message: 'Platform adapter returned no change-request snapshot',
      retryable: false
    };
    return result(error.retryable ? 'blocked' : 'failed', base.resolved.taskId, base.issueNumber, base.prNumber, {
      platform: base.context.platform, capabilities: base.context.capabilities,
      resource: { kind: 'pull-request', number: base.prNumber }, error
    });
  }
  return result('no-op', base.resolved.taskId, base.issueNumber, base.prNumber, {
    platform: base.context.platform, capabilities: base.context.capabilities,
    resource: { kind: 'pull-request', number: base.prNumber }, pullRequest: fetched.value, error: null
  });
}

function inspectPlatformPullRequestByNumber(prNumber: number, options: InspectionOptions = {}): PullRequestResult {
  const client = (options.client as GitHubClient | undefined) || createGitHubClient();
  const context = resolvePlatformContext({ cwd: options.cwd || process.cwd(), client });
  const usable = (context.status === 'no-op' || context.status === 'degraded') && context.platform.repository;
  if (!usable) {
    return result(context.status, null, null, null, {
      platform: context.platform, capabilities: context.capabilities, operations: context.operations, error: context.error
    });
  }
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    return result('failed', null, null, null, {
      platform: context.platform, capabilities: context.capabilities,
      error: { code: 'PR_NUMBER_INVALID', message: 'PR number must be positive', retryable: false }
    });
  }
  const fetched = inspectPlatformChangeRequest(context.platform.type, {
    cwd: options.cwd || process.cwd(),
    repository: context.platform.repository!,
    number: prNumber,
    client
  });
  if (!fetched.ok || !fetched.value) {
    const error = fetched.error || {
      code: 'PR_INSPECTION_INVALID',
      message: 'Platform adapter returned no change-request snapshot',
      retryable: false
    };
    return result(error.retryable ? 'blocked' : 'failed', null, null, prNumber, {
      platform: context.platform, capabilities: context.capabilities,
      resource: { kind: 'pull-request', number: prNumber }, error
    });
  }
  return result('no-op', null, null, prNumber, {
    platform: context.platform, capabilities: context.capabilities,
    resource: { kind: 'pull-request', number: prNumber }, pullRequest: fetched.value, error: null
  });
}

function appendActivity(content: string, line: string): string {
  const body = extractSection(content, ['活动日志', 'Activity Log']);
  return `${body.replace(/\s+$/, '')}${body.trim() ? '\n' : ''}${line}`;
}

function deliveryIdentity(pullRequest: PullRequestSnapshot) {
  return {
    repository: pullRequest.repository,
    number: pullRequest.number,
    nodeId: pullRequest.nodeId,
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
  issueNumber: number | null,
  verifiedAt: string
): PrDeliveryFact {
  return buildBoundFact({
    identity: deliveryIdentity(pullRequest),
    source,
    issueNumber,
    verifiedAt: factTimestamp(verifiedAt),
    remoteState: pullRequest.state,
    mergedAt: pullRequest.state === 'closed' ? pullRequest.mergedAt : null,
    mergeCommitSha: pullRequest.state === 'closed' ? pullRequest.mergeCommitSha : null
  });
}

function writeCreateStarted(base: ReturnType<typeof resolvedContext> & { ok: true }, agent: string) {
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
  base: ReturnType<typeof resolvedContext> & { ok: true },
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
  if (base.prNumber && base.prNumber !== pullRequest.number) return { status: 'failed' as const, error: {
    code: 'PR_BIND_CONFLICT', message: `Task is already bound to PR #${base.prNumber}`
  } };
  if (base.prNumber === pullRequest.number && base.fact?.state === 'bound') {
    if (JSON.stringify(base.fact.identity) !== JSON.stringify(deliveryIdentity(pullRequest))) return { status: 'failed' as const, error: {
      code: 'PR_BIND_IDENTITY_MISMATCH', message: `Task binding for PR #${pullRequest.number} does not match the fetched pull request identity`
    } };
    return { status: 'no-op' as const, error: null };
  }
  const current = fs.readFileSync(base.resolved.taskMdPath, 'utf8');
  const metadata = captureTaskWriteMetadata();
  const fact = boundFactFor(pullRequest, source, base.issueNumber, metadata.timestamp);
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

function bindPlatformPullRequest(taskRef: string, options: BindOptions): PullRequestResult {
  const base = resolvedContext(taskRef, options);
  if (!base.ok) return base.output;
  if (!base.fact) return result('failed', base.resolved.taskId, base.issueNumber, null, {
    error: { code: 'PR_DELIVERY_FACT_MISSING', message: 'Task has no pr_delivery_fact; use migrate-fact for legacy tasks', retryable: false }
  });
  if (!Number.isInteger(options.pr) || options.pr <= 0) return result('failed', base.resolved.taskId, base.issueNumber, base.prNumber, {
    error: { code: 'PR_NUMBER_INVALID', message: 'PR number must be positive', retryable: false }
  });
  if (base.prNumber && base.prNumber !== options.pr) return result('failed', base.resolved.taskId, base.issueNumber, base.prNumber, {
    error: { code: 'PR_BIND_CONFLICT', message: `Task is already bound to PR #${base.prNumber}`, retryable: false }
  });
  const fetched = inspectGitHubPullRequest(base.client, base.context.platform.repository!, options.pr, base.resolved.repoRoot);
  if (!fetched.ok) return result(fetched.error.retryable ? 'blocked' : 'failed', base.resolved.taskId, base.issueNumber, base.prNumber, { error: fetched.error });
  const initialIdentity = validateWriterIdentity(base, fetched.value, {
    expectedHead: String(base.frontmatter.branch || ''),
    errorCode: 'PR_BIND_IDENTITY_MISMATCH'
  });
  if (!initialIdentity.ok) return result('failed', base.resolved.taskId, base.issueNumber, base.prNumber, {
    pullRequest: fetched.value, error: initialIdentity.error
  });
  const rechecked = inspectGitHubPullRequest(base.client, base.context.platform.repository!, options.pr, base.resolved.repoRoot);
  if (!rechecked.ok || !rechecked.value) return result(rechecked.ok ? 'failed' : rechecked.error.retryable ? 'blocked' : 'failed', base.resolved.taskId, base.issueNumber, base.prNumber, {
    pullRequest: fetched.value,
    error: rechecked.ok ? { code: 'PR_BIND_RECHECK_FAILED', message: 'Pull request recheck returned no identity', retryable: false } : rechecked.error
  });
  if (!sameDeliveryIdentity(fetched.value, rechecked.value)) return result('failed', base.resolved.taskId, base.issueNumber, base.prNumber, {
    pullRequest: rechecked.value,
    error: { code: 'PR_BIND_IDENTITY_MISMATCH', message: 'Pull request identity changed before task binding', retryable: false }
  });
  const written = bindIdentity(base, rechecked.value, options.agent, 'explicit-bind', options.dryRun);
  if (written.status === 'failed') return result('failed', base.resolved.taskId, base.issueNumber, base.prNumber, {
    pullRequest: fetched.value, error: { code: written.error.code, message: written.error.message, retryable: false }
  });
  return result(options.dryRun ? 'planned' : written.status === 'no-op' ? 'no-op' : 'applied', base.resolved.taskId, base.issueNumber, options.dryRun ? base.prNumber : rechecked.value.number, {
    changed: !options.dryRun && written.status === 'applied', platform: base.context.platform, capabilities: base.context.capabilities,
    resource: { kind: 'pull-request', number: rechecked.value.number }, pullRequest: rechecked.value,
    operations: [{ name: 'task:bind-pr', status: options.dryRun ? 'planned' : written.status === 'no-op' ? 'no-op' : 'applied', reasonCode: null }], error: null
  });
}

function externalEvidenceNote(
  issueNumber: number,
  source: 'unique' | 'explicit',
  pullRequest: PullRequestSnapshot
): string {
  return [
    `authorization=${source}`,
    externalIdentityEvidenceNote(issueNumber, pullRequest)
  ].join('; ');
}

function externalIdentityEvidenceNote(
  issueNumber: number,
  pullRequest: PullRequestSnapshot
): string {
  return [
    `issue=#${issueNumber}`,
    `pr=#${pullRequest.number}`,
    `url=${pullRequest.url}`,
    `base=${pullRequest.base.repository}:${pullRequest.base.ref}@${pullRequest.base.sha}`,
    `head=${pullRequest.head.repository}:${pullRequest.head.ref}@${pullRequest.head.sha}`,
    `mergedAt=${pullRequest.mergedAt}`,
    `mergeCommitSha=${pullRequest.mergeCommitSha}`
  ].join('; ');
}

function resolveExternalPullRequest(taskRef: string, options: ResolveExternalOptions): ExternalPullRequestResult {
  const base = resolvedContext(taskRef, options);
  if (!base.ok) return externalResult(base.output);
  if (!base.fact) return externalResult(result('failed', base.resolved.taskId, base.issueNumber, null, {
    error: { code: 'PR_DELIVERY_FACT_MISSING', message: 'Task has no pr_delivery_fact; migrate the task before external binding', retryable: false }
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
  if (!base.issueNumber) return externalResult(result('failed', base.resolved.taskId, null, base.prNumber, {
    platform: base.context.platform,
    capabilities: base.context.capabilities,
    error: { code: 'EXTERNAL_DELIVERY_ISSUE_REQUIRED', message: 'External delivery requires a valid issue_number', retryable: false }
  }));
  const inspected = inspectPlatformIssueClosingChangeRequests(base.context.platform.type, {
    cwd: base.resolved.repoRoot,
    repository: base.context.platform.repository!,
    issueNumber: base.issueNumber,
    client: base.client
  });
  if (!inspected.ok || !inspected.value) {
    const error = inspected.error || { code: 'PR_IDENTITY_INVALID', message: 'Closing PR inspection returned no candidates', retryable: false };
    return externalResult(result(error.retryable ? 'blocked' : 'failed', base.resolved.taskId, base.issueNumber, base.prNumber, {
      platform: base.context.platform, capabilities: base.context.capabilities, error
    }));
  }
  const selected = selectExternalPullRequest(
    inspected.value,
    base.context.platform.repository!,
    base.prNumber,
    options.pr ?? null
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
  const rechecked = inspectGitHubPullRequest(base.client, base.context.platform.repository!, selected.selected.number, base.resolved.repoRoot);
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
  const note = externalEvidenceNote(base.issueNumber, selected.source, selectedPullRequest);
  const identityNote = externalIdentityEvidenceNote(base.issueNumber, selectedPullRequest);
  const activityEntry = `**Bind External PR** by ${options.agent} — ${note}`;
  const auditLines = base.content.split(/\r?\n/).filter((line) => line.includes('**Bind External PR**'));
  const alreadyAudited = auditLines.some((line) => line.endsWith(identityNote));
  if (auditLines.length > 0 && !alreadyAudited) return externalResult(result('failed', base.resolved.taskId, base.issueNumber, base.prNumber, {
    platform: base.context.platform,
    capabilities: base.context.capabilities,
    pullRequest: selectedPullRequest,
    error: { code: 'PR_BIND_CONFLICT', message: 'Existing external PR audit evidence conflicts with the selected identity', retryable: false }
  }), { candidates: selected.candidates, eligible: selected.eligible, selected: selectedPullRequest });
  if (alreadyAudited && base.prNumber !== selectedPullRequest.number) return externalResult(result('failed', base.resolved.taskId, base.issueNumber, base.prNumber, {
    platform: base.context.platform,
    capabilities: base.context.capabilities,
    pullRequest: selectedPullRequest,
    error: { code: 'PR_BIND_CONFLICT', message: 'External PR audit evidence does not match the task binding', retryable: false }
  }), { candidates: selected.candidates, eligible: selected.eligible, selected: selectedPullRequest });
  if (base.prNumber === selectedPullRequest.number && alreadyAudited) {
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

function createPlatformPullRequestUnlocked(taskRef: string, options: CreateOptions): PullRequestResult {
  const base = resolvedContext(taskRef, options);
  if (!base.ok) return withCreation(base.output, PRECONDITION_NOT_CREATED);
  if (!base.fact) return withCreation(result('failed', base.resolved.taskId, base.issueNumber, null, {
    error: { code: 'PR_DELIVERY_FACT_MISSING', message: 'Task has no pr_delivery_fact; run migrate-fact or create a new task', retryable: false }
  }), PRECONDITION_NOT_CREATED);
  if (!options.base || !options.head || !options.title.trim() || !options.body.trim()) return withCreation(result('failed', base.resolved.taskId, base.issueNumber, base.prNumber, {
    error: { code: 'PR_PAYLOAD_INVALID', message: 'base, head, title and body are required', retryable: false }
  }), PRECONDITION_NOT_CREATED);
  const target = taskDeliveryTarget(base);
  if (!target.ok) return withCreation(result('failed', base.resolved.taskId, base.issueNumber, base.prNumber, {
    error: target.error
  }), PRECONDITION_NOT_CREATED);
  if (options.base !== target.value.baseRef) return withCreation(result('failed', base.resolved.taskId, base.issueNumber, base.prNumber, {
    platform: base.context.platform, capabilities: base.context.capabilities,
    error: { code: 'PR_DELIVERY_TARGET_MISMATCH', message: `Pull request base '${options.base}' does not match delivery target '${target.value.baseRef}'`, retryable: false }
  }), PRECONDITION_NOT_CREATED);
  if (base.prNumber) {
    const headCheck = verifyCreateHead(base, options.head);
    if (!headCheck.ok) return withCreation(result(headCheck.error.retryable ? 'blocked' : 'failed', base.resolved.taskId, base.issueNumber, base.prNumber, {
      platform: base.context.platform,
      capabilities: base.context.capabilities,
      error: headCheck.error
    }), PRECONDITION_NOT_CREATED);
    const inspected = inspectPlatformPullRequest(taskRef, options);
    const identity = validateBoundPullRequest(base, inspected.pullRequest, options.head, options.base, headCheck.value);
    if (!identity.ok) return withCreation(result('failed', base.resolved.taskId, base.issueNumber, base.prNumber, {
      platform: base.context.platform,
      capabilities: base.context.capabilities,
      pullRequest: inspected.pullRequest,
      error: identity.error
    }), PRECONDITION_NOT_CREATED);
    return withCreation({ ...inspected, result: 'no_op' }, { kind: 'no-op', createdByCurrentOperation: false });
  }
  const headCheck = verifyCreateHead(base, options.head);
  if (!headCheck.ok) return withCreation(result(headCheck.error.retryable ? 'blocked' : 'failed', base.resolved.taskId, base.issueNumber, null, {
    platform: base.context.platform,
    capabilities: base.context.capabilities,
    error: headCheck.error
  }), PRECONDITION_NOT_CREATED);
  const expectedHeadSha = headCheck.value;
  const located = locatePullRequest(base, options.head, options.base, expectedHeadSha);
  if (!located.ok && located.error.code === 'PR_IDENTITY_AMBIGUOUS') return withCreation(result('failed', base.resolved.taskId, base.issueNumber, null, {
    platform: base.context.platform, capabilities: base.context.capabilities, error: located.error
  }), PRECONDITION_NOT_CREATED);
  if (!located.ok && located.error.code === 'PR_HEAD_SHA_MISMATCH') return withCreation(result('failed', base.resolved.taskId, base.issueNumber, null, {
    platform: base.context.platform, capabilities: base.context.capabilities, error: located.error
  }), PRECONDITION_NOT_CREATED);
  if (!located.ok && located.error.code !== 'PR_NOT_FOUND') return withCreation(result(located.error.retryable ? 'blocked' : 'failed', base.resolved.taskId, base.issueNumber, null, {
    platform: base.context.platform, capabilities: base.context.capabilities, error: located.error
  }), PRECONDITION_NOT_CREATED);
  if (options.dryRun) return withCreation(result('planned', base.resolved.taskId, base.issueNumber, null, {
    platform: base.context.platform, capabilities: base.context.capabilities,
    operations: [{ name: located.ok ? 'pr:reuse' : 'pr:create', status: 'planned', reasonCode: null }],
    result: located.ok ? 'pr_reused' : 'pr_created', error: null
  }), { kind: 'planned', action: located.ok ? 'reuse' : 'create', createdByCurrentOperation: false });
  const started = writeCreateStarted(base, options.agent);
  if (started.status === 'failed') return withCreation(result('failed', base.resolved.taskId, base.issueNumber, null, {
    error: { code: started.error.code, message: started.error.message, retryable: false }
  }), PRECONDITION_NOT_CREATED);
  let pullRequest = located.ok ? located.value : null;
  let created = false;
  if (!pullRequest) {
    const repository = base.context.platform.repository!;
    if (options.phase) options.phase.value = 'post-dispatched';
    const response = base.client.json<RemotePullRequest>(['api', `repos/${repository}/pulls`, '-X', 'POST', '--input', '-'], {
      cwd: base.resolved.repoRoot,
      method: 'POST',
      input: JSON.stringify({ title: options.title, body: options.body, head: options.head, base: options.base, draft: Boolean(options.draft) })
    });
    if (response.ok) {
      // The remote POST is accepted before any normalization, recheck, or task write.
      // From this point on the current call has created a remote resource even if
      // local post-processing later fails.
      created = true;
      if (options.phase) options.phase.value = 'post-accepted';
      pullRequest = normalizePullRequest(response.value, repository);
    } else if (response.error.retryable) {
      return withCreation(result('blocked', base.resolved.taskId, base.issueNumber, null, {
        platform: base.context.platform, capabilities: base.context.capabilities,
        operations: [{ name: 'pr:create', status: 'failed', reasonCode: 'PR_CREATE_OUTCOME_UNKNOWN' }],
        error: { code: 'PR_CREATE_OUTCOME_UNKNOWN', message: response.error.message, retryable: true }
      }), { kind: 'unknown', errorCode: 'PR_CREATE_OUTCOME_UNKNOWN' });
    } else return withCreation(result('failed', base.resolved.taskId, base.issueNumber, null, {
      platform: base.context.platform, capabilities: base.context.capabilities,
      operations: [{ name: 'pr:create', status: 'failed', reasonCode: response.error.code }], error: response.error
    }), { kind: 'not-created', reason: 'post-rejected', createdByCurrentOperation: false });
    if (!pullRequest) return withCreation(result('failed', base.resolved.taskId, base.issueNumber, null, {
      error: { code: 'PR_CREATE_RESPONSE_INVALID', message: 'PR create response lacks validated identity', retryable: false }
    }), { kind: 'created', createdByCurrentOperation: true });
    if (pullRequest.head.sha !== expectedHeadSha) return withCreation(result('failed', base.resolved.taskId, base.issueNumber, pullRequest.number, {
      platform: base.context.platform, capabilities: base.context.capabilities,
      resource: { kind: 'pull-request', number: pullRequest.number }, pullRequest,
      error: { code: 'PR_HEAD_SHA_MISMATCH', message: 'Created pull request head does not match the expected local HEAD', retryable: false }
    }), { kind: 'created', createdByCurrentOperation: true });
  }
  const bindHeadCheck = verifyCreateHead(base, options.head);
  if (!bindHeadCheck.ok || bindHeadCheck.value !== expectedHeadSha) {
    const error = bindHeadCheck.ok
      ? { code: 'PR_REMOTE_HEAD_MISMATCH', message: 'Remote head changed before task binding', retryable: false }
      : bindHeadCheck.error;
    return withCreation(result(error.retryable ? 'blocked' : 'failed', base.resolved.taskId, base.issueNumber, pullRequest.number, {
      platform: base.context.platform, capabilities: base.context.capabilities,
      resource: { kind: 'pull-request', number: pullRequest.number }, pullRequest, error
    }), created ? { kind: 'created', createdByCurrentOperation: true } : { kind: 'not-created', reason: 'precondition-failed', createdByCurrentOperation: false });
  }
  const beforeBind = inspectGitHubPullRequest(base.client, base.context.platform.repository!, pullRequest.number, base.resolved.repoRoot);
  if (!beforeBind.ok || !beforeBind.value) {
    const error = beforeBind.ok
      ? { code: 'PR_BIND_RECHECK_FAILED', message: 'Pull request recheck returned no identity', retryable: false }
      : beforeBind.error;
    return withCreation(result(error.retryable ? 'blocked' : 'failed', base.resolved.taskId, base.issueNumber, pullRequest.number, {
      platform: base.context.platform, capabilities: base.context.capabilities,
      resource: { kind: 'pull-request', number: pullRequest.number }, pullRequest, error
    }), created ? { kind: 'created', createdByCurrentOperation: true } : { kind: 'not-created', reason: 'precondition-failed', createdByCurrentOperation: false });
  }
  if (
    beforeBind.value.head.sha !== expectedHeadSha
    || beforeBind.value.head.ref !== expectedHead(base.context.platform.repository!, options.head).ref
    || beforeBind.value.base.ref !== options.base
    || beforeBind.value.base.repository !== base.context.platform.repository
  ) return withCreation(result('failed', base.resolved.taskId, base.issueNumber, pullRequest.number, {
    platform: base.context.platform, capabilities: base.context.capabilities,
    resource: { kind: 'pull-request', number: pullRequest.number }, pullRequest: beforeBind.value,
    error: { code: 'PR_BIND_IDENTITY_MISMATCH', message: 'Pull request identity changed before task binding', retryable: false }
  }), created ? { kind: 'created', createdByCurrentOperation: true } : { kind: 'not-created', reason: 'precondition-failed', createdByCurrentOperation: false });
  pullRequest = beforeBind.value;
  const refreshed = resolvedContext(taskRef, options);
  if (!refreshed.ok) return withCreation(result('failed', base.resolved.taskId, base.issueNumber, null, {
    pullRequest, error: { code: 'PR_CREATED_BIND_FAILED', message: pullRequest.url, retryable: false }
  }), created ? { kind: 'created', createdByCurrentOperation: true } : { kind: 'not-created', reason: 'precondition-failed', createdByCurrentOperation: false });
  const bound = bindIdentity(refreshed, pullRequest, options.agent, created ? 'created' : 'reused', false, options.head, expectedHeadSha);
  if (bound.status === 'failed') return withCreation(result('failed', base.resolved.taskId, base.issueNumber, null, {
    platform: base.context.platform, capabilities: base.context.capabilities,
    resource: { kind: 'pull-request', number: pullRequest.number }, pullRequest,
    operations: [{ name: created ? 'pr:create' : 'pr:reuse', status: 'applied', reasonCode: null }, { name: 'task:bind-pr', status: 'failed', reasonCode: bound.error.code }],
    error: { code: 'PR_CREATED_BIND_FAILED', message: `${pullRequest.url}: ${bound.error.message}`, retryable: false }
  }), created ? { kind: 'created', createdByCurrentOperation: true } : { kind: 'reused', createdByCurrentOperation: false });
  return withCreation(result('applied', base.resolved.taskId, base.issueNumber, pullRequest.number, {
    changed: true, platform: base.context.platform, capabilities: base.context.capabilities,
    resource: { kind: 'pull-request', number: pullRequest.number }, pullRequest,
    operations: [{ name: created ? 'pr:create' : 'pr:reuse', status: created ? 'applied' : 'no-op', reasonCode: null }, { name: 'task:bind-pr', status: 'applied', reasonCode: null }],
    result: created ? 'pr_created' : 'pr_reused', error: null
  }), created ? { kind: 'created', createdByCurrentOperation: true } : { kind: 'reused', createdByCurrentOperation: false });
}

function createPlatformPullRequest(taskRef: string, options: CreateOptions): PullRequestResult {
  const base = resolvedContext(taskRef, options);
  if (!base.ok) return withCreation(base.output, PRECONDITION_NOT_CREATED);
  if (!options.base || !options.head || !options.title.trim() || !options.body.trim()) {
    return withCreation(result('failed', base.resolved.taskId, base.issueNumber, base.prNumber, {
      error: { code: 'PR_PAYLOAD_INVALID', message: 'base, head, title and body are required', retryable: false }
    }), PRECONDITION_NOT_CREATED);
  }
  const phase = { value: 'before-post' as CreatePhase };
  try {
    return withTaskExecutionLock(
      base.resolved.repoRoot,
      base.resolved.taskId,
      'platform-pr.create',
      () => createPlatformPullRequestUnlocked(taskRef, { ...options, phase })
    );
  } catch (error) {
    if (error instanceof TaskExecutionLockError) {
      return withCreation(result('blocked', base.resolved.taskId, base.issueNumber, null, {
        platform: base.context.platform,
        capabilities: base.context.capabilities,
        error: { code: error.code, message: error.message, retryable: true }
      }), PRECONDITION_NOT_CREATED);
    }
    const creation: CreationOutcome = phase.value === 'post-accepted'
      ? { kind: 'created', createdByCurrentOperation: true }
      : phase.value === 'post-dispatched'
        ? { kind: 'unknown', errorCode: 'PR_CREATE_OUTCOME_UNKNOWN' }
        : PRECONDITION_NOT_CREATED;
    return withCreation(result(phase.value === 'post-dispatched' ? 'blocked' : 'failed', base.resolved.taskId, base.issueNumber, null, {
      platform: base.context.platform,
      capabilities: base.context.capabilities,
      error: {
        code: phase.value === 'post-dispatched' ? 'PR_CREATE_OUTCOME_UNKNOWN' : 'PR_CREATE_FAILED',
        message: error instanceof Error ? error.message : String(error),
        retryable: phase.value === 'post-dispatched'
      }
    }), creation);
  }
}

function syncPlatformPullRequest(taskRef: string, options: SyncOptions): PullRequestResult {
  const warningResult = warningResultForPrimary(options.primaryResult);
  const softenFailure = (output: PullRequestResult): PullRequestResult => {
    const warning = output.error && output.task.prNumber !== null
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
  const base = resolvedContext(taskRef, options);
  if (!base.ok) return softenFailure(base.output);
  if (!base.fact) return softenFailure(result('failed', base.resolved.taskId, base.issueNumber, null, {
    error: { code: 'PR_DELIVERY_FACT_MISSING', message: 'Task has no pr_delivery_fact; migrate the task before syncing PR metadata', retryable: false }
  }));
  if (!base.prNumber) return softenFailure(result('failed', base.resolved.taskId, base.issueNumber, null, {
    error: { code: 'PR_NOT_LINKED', message: 'Task has no verified bound pull request', retryable: false }
  }));
  const fetched = inspectGitHubPullRequest(base.client, base.context.platform.repository!, base.prNumber, base.resolved.repoRoot);
  if (!fetched.ok) return softenFailure(result(fetched.error.retryable ? 'blocked' : 'failed', base.resolved.taskId, base.issueNumber, base.prNumber, { error: fetched.error }));
  if (!options.metadata && !options.closingIssue) return softenFailure(result('failed', base.resolved.taskId, base.issueNumber, base.prNumber, {
    error: { code: 'PR_PAYLOAD_INVALID', message: 'sync requires a desired-state option', retryable: false }
  }));
  if (!base.issueNumber) return softenFailure(result('degraded', base.resolved.taskId, null, base.prNumber, {
    pullRequest: fetched.value, error: { code: 'ISSUE_NOT_LINKED', message: 'Task has no linked Issue to copy metadata from', retryable: false }
  }));
  const issue = inspectPlatformIssue(taskRef, { cwd: base.resolved.repoRoot, client: base.client });
  if (!issue.issue) return softenFailure(result(issue.status, base.resolved.taskId, base.issueNumber, base.prNumber, {
    platform: base.context.platform, capabilities: base.context.capabilities, pullRequest: fetched.value, error: issue.error
  }));
  const planned = planPullRequestMetadata({
    pullRequest: fetched.value,
    issue: issue.issue,
    taskType: String(base.frontmatter.type || 'task'),
    issueNumber: base.issueNumber,
    capabilities: base.context.capabilities
  }).operations.filter((operation) => options.metadata || operation.name === 'closing-issue')
    .filter((operation) => options.closingIssue || operation.name !== 'closing-issue');
  const operations: PlatformOperation[] = planned.map(({ name, status, reasonCode }) => ({ name, status, reasonCode }));
  if (options.dryRun) return softenFailure(result(planned.some((operation) => operation.status === 'planned') ? 'planned' : 'no-op', base.resolved.taskId, base.issueNumber, base.prNumber, {
    platform: base.context.platform, capabilities: base.context.capabilities, pullRequest: fetched.value, operations, error: null
  }));
  const payload: Record<string, unknown> = {};
  for (const operation of planned) {
    if (operation.status !== 'planned') continue;
    if (operation.name === 'labels') payload.labels = operation.value;
    if (operation.name === 'assignees') payload.assignees = operation.value;
    if (operation.name === 'closing-issue') payload.body = operation.value;
    if (operation.name === 'milestone') {
      const milestones = base.client.json<unknown[]>(['api', '--paginate', '--slurp', `repos/${base.context.platform.repository}/milestones?state=open&per_page=100`], { cwd: base.resolved.repoRoot });
      if (!milestones.ok) return softenFailure(result(milestones.error.retryable ? 'blocked' : 'failed', base.resolved.taskId, base.issueNumber, base.prNumber, { pullRequest: fetched.value, operations, error: milestones.error }));
      const flat = milestones.value.flatMap((entry) => Array.isArray(entry) ? entry : [entry]) as Array<{ title?: string; number?: number }>;
      payload.milestone = flat.find((entry) => entry.title === operation.value)?.number ?? null;
    }
  }
  if (Object.keys(payload).length === 0) {
    const degraded = planned.some((operation) => operation.status === 'skipped');
    return softenFailure(result(degraded ? 'degraded' : 'no-op', base.resolved.taskId, base.issueNumber, base.prNumber, {
      platform: base.context.platform, capabilities: base.context.capabilities, resource: { kind: 'pull-request', number: base.prNumber }, pullRequest: fetched.value, operations, error: null
    }));
  }
  const patched = base.client.json<RemotePullRequest>(['api', `repos/${base.context.platform.repository}/issues/${base.prNumber}`, '-X', 'PATCH', '--input', '-'], {
    cwd: base.resolved.repoRoot, method: 'PATCH', input: JSON.stringify(payload)
  });
  if (!patched.ok) return softenFailure(result(patched.error.retryable ? 'blocked' : 'failed', base.resolved.taskId, base.issueNumber, base.prNumber, { pullRequest: fetched.value, operations, error: patched.error }));
  return softenFailure(result(planned.some((operation) => operation.status === 'skipped') ? 'degraded' : 'applied', base.resolved.taskId, base.issueNumber, base.prNumber, {
    changed: true, platform: base.context.platform, capabilities: base.context.capabilities,
    resource: { kind: 'pull-request', number: base.prNumber }, pullRequest: fetched.value,
    operations: operations.map((operation) => operation.status === 'planned' ? { ...operation, status: 'applied' } : operation), error: null
  }));
}

function migratePlatformPullRequestFact(taskRef: string, options: MigrateFactOptions): PullRequestResult {
  const resolved = resolveTaskRef(taskRef, options.cwd ? { repoRoot: options.cwd } : {});
  if (!resolved.ok) return result('failed', resolved.taskId, null, null, {
    error: { code: resolved.code, message: resolved.message, retryable: false }
  });
  if (options.state !== 'bound' && options.pr !== undefined) return result('failed', resolved.taskId, null, null, {
    error: { code: 'PR_PAYLOAD_INVALID', message: `${options.state} migration does not accept --pr`, retryable: false }
  });
  if (options.state === 'bound' && (!Number.isSafeInteger(options.pr) || options.pr! <= 0)) return result('failed', resolved.taskId, null, null, {
    error: { code: 'PR_NUMBER_INVALID', message: 'bound migration requires a positive --pr', retryable: false }
  });
  let frontmatter: ReturnType<typeof parseTypedTaskFrontmatter>;
  try { frontmatter = parseTypedTaskFrontmatter(fs.readFileSync(resolved.taskMdPath, 'utf8')); }
  catch (error) { return result('failed', resolved.taskId, null, null, { error: { code: 'TASK_DOCUMENT_INVALID', message: error instanceof Error ? error.message : String(error), retryable: false } }); }
  const existing = readPrDeliveryFact(frontmatter);
  if (existing.status === 'invalid') return result('failed', resolved.taskId, null, null, {
    error: { code: 'PR_DELIVERY_FACT_INVALID', message: existing.error.message, retryable: false }
  });
  const issue = Number(frontmatter.issue_number);
  const issueNumber = Number.isSafeInteger(issue) && issue > 0 ? issue : null;
  const hasLegacyFields = Object.hasOwn(frontmatter, 'pr_number') || Object.hasOwn(frontmatter, 'pr_status');
  let fact: PrDeliveryFact;
  let prNumber: number | null = null;
  if (existing.status === 'valid') {
    const sameState = existing.fact.state === options.state
      && (options.state !== 'bound' || (existing.fact.state === 'bound' && existing.fact.identity.number === options.pr));
    if (!sameState) return result('failed', resolved.taskId, issueNumber, existing.fact.state === 'bound' ? existing.fact.identity.number : null, {
      error: { code: 'PR_MIGRATION_CONFLICT', message: 'Migration cannot replace an existing current delivery fact', retryable: false }
    });
    fact = existing.fact;
    if (fact.state === 'bound') prNumber = fact.identity.number;
  } else if (options.state === 'unbound') {
    fact = { version: 1, state: 'unbound', reason: 'migrated' };
  } else if (options.state === 'skipped') {
    fact = buildSkippedFact(factTimestamp(captureTaskWriteMetadata().timestamp));
  } else {
    const client = options.client || createGitHubClient();
    const context = resolvePlatformContext({ cwd: resolved.repoRoot, client });
    if (!context.platform.repository || !['no-op', 'degraded'].includes(context.status)) return result(context.status, resolved.taskId, issueNumber, options.pr!, {
      platform: context.platform, capabilities: context.capabilities, error: context.error
    });
    const inspected = inspectGitHubPullRequest(client, context.platform.repository, options.pr!, resolved.repoRoot);
    if (!inspected.ok || !inspected.value) {
      const remoteError = inspected.ok ? { code: 'PR_IDENTITY_INVALID', message: 'Remote resource is not a valid pull request', retryable: false } : inspected.error;
      return result(remoteError.retryable ? 'blocked' : 'failed', resolved.taskId, issueNumber, options.pr!, {
      platform: context.platform, capabilities: context.capabilities,
        error: remoteError
      });
    }
    let pullRequest = inspected.value;
    const taskBranch = String(frontmatter.branch || '').trim();
    const repository = context.platform.repository;
    const target = resolveTaskDeliveryTarget(resolved.repoRoot, frontmatter);
    if (!target.ok) return result('failed', resolved.taskId, issueNumber, options.pr!, {
      platform: context.platform, capabilities: context.capabilities, error: target.error
    });
    const identity = validateIdentityAgainstTarget(repository, target.value, pullRequest);
    const taskBranchMatches = !taskBranch || (pullRequest.head.ref === taskBranch
      && repositoryKey(pullRequest.head.repository) === repositoryKey(repository));
    const rechecked = inspectGitHubPullRequest(client, repository, pullRequest.number, resolved.repoRoot);
    if (!rechecked.ok || !rechecked.value) return result(rechecked.ok ? 'failed' : rechecked.error.retryable ? 'blocked' : 'failed', resolved.taskId, issueNumber, options.pr!, {
      platform: context.platform, capabilities: context.capabilities,
      pullRequest,
      error: rechecked.ok ? { code: 'PR_MIGRATION_RECHECK_FAILED', message: 'Pull request recheck returned no identity', retryable: false } : rechecked.error
    });
    if (!sameDeliveryIdentity(pullRequest, rechecked.value)) return result('failed', resolved.taskId, issueNumber, options.pr!, {
      platform: context.platform, capabilities: context.capabilities,
      pullRequest: rechecked.value,
      error: { code: 'PR_MIGRATION_EVIDENCE_INVALID', message: 'Pull request identity changed during migration', retryable: false }
    });
    pullRequest = rechecked.value;
    let hasEvidence = pullRequest.state === 'closed' && Boolean(pullRequest.mergedAt && pullRequest.mergeCommitSha);
    if (!hasEvidence && issueNumber) {
      const closing = inspectPlatformIssueClosingChangeRequests(context.platform.type, {
        cwd: resolved.repoRoot, repository, issueNumber, client
      });
      if (!closing.ok) {
        const closingError = closing.error || { code: 'PR_IDENTITY_INVALID', message: 'Closing pull request inspection failed', retryable: false };
        return result(closingError.retryable ? 'blocked' : 'failed', resolved.taskId, issueNumber, options.pr!, {
          platform: context.platform, capabilities: context.capabilities, error: closingError
        });
      }
      hasEvidence = closing.value?.some((candidate) => candidate.number === pullRequest.number
        && candidate.repository === pullRequest.repository && candidate.base.repository === pullRequest.base.repository
        && candidate.head.sha === pullRequest.head.sha && Boolean(candidate.mergedAt && candidate.mergeCommitSha)) ?? false;
    }
    if (!identity.ok || !taskBranchMatches || !hasEvidence) return result('failed', resolved.taskId, issueNumber, options.pr!, {
      platform: context.platform, capabilities: context.capabilities, pullRequest,
      error: { code: 'PR_MIGRATION_EVIDENCE_INVALID', message: 'Explicit PR migration requires complete task identity and merge or Issue-closing evidence', retryable: false }
    });
    prNumber = pullRequest.number;
    const metadata = captureTaskWriteMetadata();
    fact = boundFactFor(pullRequest, 'legacy-migrated', issueNumber, metadata.timestamp);
  }
  if (fact.state === 'bound') prNumber = fact.identity.number;
  const encoded = JSON.stringify(fact);
  if (existing.status === 'valid' && JSON.stringify(existing.fact) === encoded && !hasLegacyFields) {
    return result('no-op', resolved.taskId, issueNumber, prNumber, { error: null });
  }
  const write = writeTask({
    taskRef: resolved.taskId,
    expectedState: resolved.state,
    dryRun: options.dryRun,
    mutations: [{ kind: 'frontmatter', ...factFrontmatterMutation(fact), remove: ['pr_number', 'pr_status'] }]
  }, { repoRoot: resolved.repoRoot });
  if (write.status === 'failed') return result('failed', resolved.taskId, issueNumber, prNumber, {
    error: { code: write.error.code, message: write.error.message, retryable: false }
  });
  return result(options.dryRun ? 'planned' : write.status === 'no-op' ? 'no-op' : 'applied', resolved.taskId, issueNumber, prNumber, {
    changed: !options.dryRun && write.changed,
    resource: { kind: 'pull-request', number: prNumber },
    operations: [{ name: 'task:migrate-pr-delivery-fact', status: options.dryRun ? 'planned' : write.status === 'no-op' ? 'no-op' : 'applied', reasonCode: null }],
    error: null
  });
}

export {
  bindPlatformPullRequest,
  createPlatformPullRequest,
  inspectGitHubPullRequest,
  inspectGitHubIssueClosingChangeRequests,
  inspectPlatformPullRequest,
  inspectPlatformPullRequestByNumber,
  normalizePullRequest,
  resolveGitHubChangeRequestGitEvidence,
  resolveExternalPullRequest,
  migratePlatformPullRequestFact,
  selectExternalPullRequest,
  selectPullRequest,
  syncPlatformPullRequest
};
export type { BindOptions, CreateOptions, ExternalPullRequestResult, ExternalPullRequestSelection, MigrateFactOptions, PullRequestPrimaryResult, PullRequestResult, PullRequestSnapshot, ResolveExternalOptions, SyncOptions };
export { warningResultForPrimary };
