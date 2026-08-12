import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

import { parseTaskFrontmatter } from '../task/frontmatter.ts';
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
import { inspectCreatePrCommitGate } from '../task/commit-finalization.ts';
import { TaskExecutionLockError, withTaskExecutionLock } from '../task/task-execution-lock.ts';

type PullRequestSnapshot = PlatformChangeRequestSnapshot;

type PullRequestResult = PlatformResult & {
  task: { id: string | null; issueNumber: number | null; prNumber: number | null };
  pullRequest: PullRequestSnapshot | null;
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
};
type BindOptions = SharedOptions & { agent: string; pr: number; dryRun?: boolean };
type SyncOptions = SharedOptions & { agent: string; metadata?: boolean; closingIssue?: boolean; dryRun?: boolean };
type ResolveExternalOptions = SharedOptions & { agent: string; pr?: number; dryRun?: boolean };
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

function result(
  status: PlatformResult['status'],
  taskId: string | null,
  issueNumber: number | null,
  prNumber: number | null,
  overrides: Partial<PullRequestResult> = {}
): PullRequestResult {
  return {
    ...platformResult(status),
    task: { id: taskId, issueNumber, prNumber },
    pullRequest: null,
    ...overrides
  };
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
    Boolean(pullRequest.mergedAt) === Boolean(pullRequest.mergeCommitSha);
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

function selectPullRequest(remotes: RemotePullRequest[], repository: string, head: string, base: string):
  | { status: 'resolved'; pullRequest: PullRequestSnapshot }
  | { status: 'missing' | 'ambiguous'; pullRequest: null } {
  const wanted = expectedHead(repository, head);
  const matches = remotes.flatMap((remote) => {
    const normalized = normalizePullRequest(remote, repository);
    return normalized && normalized.state === 'open' && normalized.head.repository === wanted.repository &&
      normalized.head.ref === wanted.ref && normalized.base.repository === repository && normalized.base.ref === base
      ? [normalized] : [];
  });
  if (matches.length === 1) return { status: 'resolved', pullRequest: matches[0]! };
  return { status: matches.length === 0 ? 'missing' : 'ambiguous', pullRequest: null };
}

function resolvedContext(taskRef: string, options: InspectionOptions) {
  const resolved = resolveTaskRef(taskRef, options.cwd ? { repoRoot: options.cwd } : {});
  if (!resolved.ok) return { ok: false as const, output: result('failed', resolved.taskId, null, null, {
    error: { code: resolved.code, message: resolved.message, retryable: false }
  }) };
  const content = fs.readFileSync(resolved.taskMdPath, 'utf8');
  const frontmatter = parseTaskFrontmatter(content);
  const issue = Number(frontmatter.issue_number);
  const pr = Number(frontmatter.pr_number);
  const issueNumber = Number.isInteger(issue) && issue > 0 ? issue : null;
  const prNumber = Number.isInteger(pr) && pr > 0 ? pr : null;
  const client = (options.client as GitHubClient | undefined) || createGitHubClient();
  const context = resolvePlatformContext({ cwd: resolved.repoRoot, client });
  const usable = (context.status === 'no-op' || context.status === 'degraded') && context.platform.repository;
  if (!usable) return { ok: false as const, output: result(context.status, resolved.taskId, issueNumber, prNumber, {
    platform: context.platform, capabilities: context.capabilities, operations: context.operations, error: context.error
  }) };
  return { ok: true as const, resolved, content, frontmatter, issueNumber, prNumber, client, context };
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

function locatePullRequest(base: ReturnType<typeof resolvedContext> & { ok: true }, head: string, target: string) {
  const repository = base.context.platform.repository!;
  const listed = base.client.json<RemotePullRequest[]>([
    'api', `repos/${repository}/pulls?state=open&base=${encodeURIComponent(target)}&per_page=100`
  ], { cwd: base.resolved.repoRoot });
  if (!listed.ok) return listed;
  const selected = selectPullRequest(listed.value, repository, head, target);
  return selected.status === 'resolved'
    ? { ok: true as const, value: selected.pullRequest }
    : { ok: false as const, error: {
      code: selected.status === 'ambiguous' ? 'PR_IDENTITY_AMBIGUOUS' : 'PR_NOT_FOUND',
      message: selected.status === 'ambiguous' ? 'Multiple pull requests match the exact head/base identity' : 'No pull request matches the exact head/base identity',
      retryable: false
    } };
}

function inspectPlatformPullRequest(taskRef: string, options: InspectionOptions = {}): PullRequestResult {
  const base = resolvedContext(taskRef, options);
  if (!base.ok) return base.output;
  if (!base.prNumber) return result('no-op', base.resolved.taskId, base.issueNumber, null, {
    platform: base.context.platform, capabilities: base.context.capabilities,
    error: { code: 'PR_NOT_LINKED', message: 'Task has no valid pr_number', retryable: false }
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

function bindIdentity(base: ReturnType<typeof resolvedContext> & { ok: true }, pullRequest: PullRequestSnapshot, agent: string, dryRun = false) {
  if (base.prNumber && base.prNumber !== pullRequest.number) return { status: 'failed' as const, error: {
    code: 'PR_BIND_CONFLICT', message: `Task is already bound to PR #${base.prNumber}`
  } };
  if (base.prNumber === pullRequest.number) return { status: 'no-op' as const, error: null };
  const current = fs.readFileSync(base.resolved.taskMdPath, 'utf8');
  const metadata = captureTaskWriteMetadata();
  return writeTask({
    taskRef: base.resolved.taskId,
    expectedState: 'active',
    dryRun,
    mutations: [
      { kind: 'frontmatter', set: { pr_number: pullRequest.number, pr_status: 'created', assigned_to: agent } },
      { kind: 'section', aliases: ['活动日志', 'Activity Log'], heading: '活动日志', body: appendActivity(
        current, `- ${metadata.timestamp} — **Create PR** by ${agent} — PR #${pullRequest.number} created → ${pullRequest.url}`
      ) }
    ]
  }, { repoRoot: base.resolved.repoRoot, metadataProvider: () => metadata });
}

function bindPlatformPullRequest(taskRef: string, options: BindOptions): PullRequestResult {
  const base = resolvedContext(taskRef, options);
  if (!base.ok) return base.output;
  if (!Number.isInteger(options.pr) || options.pr <= 0) return result('failed', base.resolved.taskId, base.issueNumber, base.prNumber, {
    error: { code: 'PR_NUMBER_INVALID', message: 'PR number must be positive', retryable: false }
  });
  if (base.prNumber && base.prNumber !== options.pr) return result('failed', base.resolved.taskId, base.issueNumber, base.prNumber, {
    error: { code: 'PR_BIND_CONFLICT', message: `Task is already bound to PR #${base.prNumber}`, retryable: false }
  });
  const fetched = inspectGitHubPullRequest(base.client, base.context.platform.repository!, options.pr, base.resolved.repoRoot);
  if (!fetched.ok) return result(fetched.error.retryable ? 'blocked' : 'failed', base.resolved.taskId, base.issueNumber, base.prNumber, { error: fetched.error });
  const written = bindIdentity(base, fetched.value, options.agent, options.dryRun);
  if (written.status === 'failed') return result('failed', base.resolved.taskId, base.issueNumber, base.prNumber, {
    pullRequest: fetched.value, error: { code: written.error.code, message: written.error.message, retryable: false }
  });
  return result(options.dryRun ? 'planned' : written.status === 'no-op' ? 'no-op' : 'applied', base.resolved.taskId, base.issueNumber, options.dryRun ? base.prNumber : fetched.value.number, {
    changed: !options.dryRun && written.status === 'applied', platform: base.context.platform, capabilities: base.context.capabilities,
    resource: { kind: 'pull-request', number: fetched.value.number }, pullRequest: fetched.value,
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

  const note = externalEvidenceNote(base.issueNumber, selected.source, selected.selected);
  const identityNote = externalIdentityEvidenceNote(base.issueNumber, selected.selected);
  const activityEntry = `**Bind External PR** by ${options.agent} — ${note}`;
  const auditLines = base.content.split(/\r?\n/).filter((line) => line.includes('**Bind External PR**'));
  const alreadyAudited = auditLines.some((line) => line.endsWith(identityNote));
  if (auditLines.length > 0 && !alreadyAudited) return externalResult(result('failed', base.resolved.taskId, base.issueNumber, base.prNumber, {
    platform: base.context.platform,
    capabilities: base.context.capabilities,
    pullRequest: selected.selected,
    error: { code: 'PR_BIND_CONFLICT', message: 'Existing external PR audit evidence conflicts with the selected identity', retryable: false }
  }), { candidates: selected.candidates, eligible: selected.eligible, selected: selected.selected });
  if (alreadyAudited && base.prNumber !== selected.selected.number) return externalResult(result('failed', base.resolved.taskId, base.issueNumber, base.prNumber, {
    platform: base.context.platform,
    capabilities: base.context.capabilities,
    pullRequest: selected.selected,
    error: { code: 'PR_BIND_CONFLICT', message: 'External PR audit evidence does not match the task binding', retryable: false }
  }), { candidates: selected.candidates, eligible: selected.eligible, selected: selected.selected });
  if (base.prNumber === selected.selected.number && alreadyAudited) {
    return externalResult(result('no-op', base.resolved.taskId, base.issueNumber, base.prNumber, {
      platform: base.context.platform,
      capabilities: base.context.capabilities,
      resource: { kind: 'pull-request', number: selected.selected.number },
      pullRequest: selected.selected,
      operations: [{ name: 'task:bind-external-pr', status: 'no-op', reasonCode: 'EVIDENCE_ALREADY_RECORDED' }],
      error: null
    }), { mode: 'external', authorization: selected.source, candidates: selected.candidates, eligible: selected.eligible, selected: selected.selected });
  }
  const metadata = captureTaskWriteMetadata();
  const write = writeTask({
    taskRef: base.resolved.taskId,
    expectedState: 'active',
    dryRun: options.dryRun,
    mutations: [
      { kind: 'frontmatter', set: { pr_number: selected.selected.number, pr_status: 'created', assigned_to: options.agent } },
      { kind: 'section', aliases: ['活动日志', 'Activity Log'], heading: '活动日志', body: appendActivity(
        base.content, `- ${metadata.timestamp} — ${activityEntry}`
      ) }
    ]
  }, { repoRoot: base.resolved.repoRoot, metadataProvider: () => metadata });
  if (write.status === 'failed') return externalResult(result('failed', base.resolved.taskId, base.issueNumber, base.prNumber, {
    platform: base.context.platform,
    capabilities: base.context.capabilities,
    pullRequest: selected.selected,
    error: { code: write.error.code, message: write.error.message, retryable: false }
  }), { candidates: selected.candidates, eligible: selected.eligible, selected: selected.selected });
  const operationStatus = options.dryRun ? 'planned' : write.status === 'applied' ? 'applied' : 'no-op';
  return externalResult(result(operationStatus, base.resolved.taskId, base.issueNumber, options.dryRun ? base.prNumber : selected.selected.number, {
    changed: !options.dryRun && write.changed,
    platform: base.context.platform,
    capabilities: base.context.capabilities,
    resource: { kind: 'pull-request', number: selected.selected.number },
    pullRequest: selected.selected,
    operations: [{ name: 'task:bind-external-pr', status: operationStatus, reasonCode: null }],
    error: null
  }), { mode: 'external', authorization: selected.source, candidates: selected.candidates, eligible: selected.eligible, selected: selected.selected });
}

function createPlatformPullRequestUnlocked(taskRef: string, options: CreateOptions): PullRequestResult {
  const base = resolvedContext(taskRef, options);
  if (!base.ok) return base.output;
  if (!options.base || !options.head || !options.title.trim() || !options.body.trim()) return result('failed', base.resolved.taskId, base.issueNumber, base.prNumber, {
    error: { code: 'PR_PAYLOAD_INVALID', message: 'base, head, title and body are required', retryable: false }
  });
  if (base.prNumber) return inspectPlatformPullRequest(taskRef, options);
  const gate = inspectCreatePrCommitGate(base.resolved.taskDir, base.resolved.repoRoot, base.resolved.taskId);
  if (!gate.allowed) return result('blocked', base.resolved.taskId, base.issueNumber, null, {
    platform: base.context.platform,
    capabilities: base.context.capabilities,
    error: {
      code: gate.code!,
      message: `${gate.message}; action=${gate.action}`,
      retryable: gate.action === 'rerun-commit' || gate.action === 'rerun-review-code'
    }
  });
  const located = locatePullRequest(base, options.head, options.base);
  if (!located.ok && located.error.code === 'PR_IDENTITY_AMBIGUOUS') return result('failed', base.resolved.taskId, base.issueNumber, null, {
    platform: base.context.platform, capabilities: base.context.capabilities, error: located.error
  });
  if (options.dryRun) return result('planned', base.resolved.taskId, base.issueNumber, null, {
    platform: base.context.platform, capabilities: base.context.capabilities,
    operations: [{ name: located.ok ? 'pr:reuse' : 'pr:create', status: 'planned', reasonCode: null }], error: null
  });
  const started = writeCreateStarted(base, options.agent);
  if (started.status === 'failed') return result('failed', base.resolved.taskId, base.issueNumber, null, {
    error: { code: started.error.code, message: started.error.message, retryable: false }
  });
  let pullRequest = located.ok ? located.value : null;
  let created = false;
  if (!pullRequest) {
    const repository = base.context.platform.repository!;
    const response = base.client.json<RemotePullRequest>(['api', `repos/${repository}/pulls`, '-X', 'POST', '--input', '-'], {
      cwd: base.resolved.repoRoot,
      method: 'POST',
      input: JSON.stringify({ title: options.title, body: options.body, head: options.head, base: options.base, draft: Boolean(options.draft) })
    });
    if (response.ok) pullRequest = normalizePullRequest(response.value, repository);
    else if (response.error.retryable) {
      const recovered = locatePullRequest(base, options.head, options.base);
      if (recovered.ok) pullRequest = recovered.value;
      else return result('blocked', base.resolved.taskId, base.issueNumber, null, {
        platform: base.context.platform, capabilities: base.context.capabilities,
        operations: [{ name: 'pr:create', status: 'failed', reasonCode: 'PR_CREATE_OUTCOME_UNKNOWN' }],
        error: { code: 'PR_CREATE_OUTCOME_UNKNOWN', message: response.error.message, retryable: true }
      });
    } else return result('failed', base.resolved.taskId, base.issueNumber, null, {
      platform: base.context.platform, capabilities: base.context.capabilities,
      operations: [{ name: 'pr:create', status: 'failed', reasonCode: response.error.code }], error: response.error
    });
    if (!pullRequest) return result('failed', base.resolved.taskId, base.issueNumber, null, {
      error: { code: 'PR_CREATE_RESPONSE_INVALID', message: 'PR create response lacks validated identity', retryable: false }
    });
    created = true;
  }
  const refreshed = resolvedContext(taskRef, options);
  if (!refreshed.ok) return result('failed', base.resolved.taskId, base.issueNumber, null, {
    pullRequest, error: { code: 'PR_CREATED_BIND_FAILED', message: pullRequest.url, retryable: false }
  });
  const bound = bindIdentity(refreshed, pullRequest, options.agent);
  if (bound.status === 'failed') return result('failed', base.resolved.taskId, base.issueNumber, null, {
    platform: base.context.platform, capabilities: base.context.capabilities,
    resource: { kind: 'pull-request', number: pullRequest.number }, pullRequest,
    operations: [{ name: created ? 'pr:create' : 'pr:reuse', status: 'applied', reasonCode: null }, { name: 'task:bind-pr', status: 'failed', reasonCode: bound.error.code }],
    error: { code: 'PR_CREATED_BIND_FAILED', message: `${pullRequest.url}: ${bound.error.message}`, retryable: false }
  });
  return result('applied', base.resolved.taskId, base.issueNumber, pullRequest.number, {
    changed: true, platform: base.context.platform, capabilities: base.context.capabilities,
    resource: { kind: 'pull-request', number: pullRequest.number }, pullRequest,
    operations: [{ name: created ? 'pr:create' : 'pr:reuse', status: created ? 'applied' : 'no-op', reasonCode: null }, { name: 'task:bind-pr', status: 'applied', reasonCode: null }], error: null
  });
}

function createPlatformPullRequest(taskRef: string, options: CreateOptions): PullRequestResult {
  const base = resolvedContext(taskRef, options);
  if (!base.ok) return base.output;
  if (!options.base || !options.head || !options.title.trim() || !options.body.trim()) {
    return result('failed', base.resolved.taskId, base.issueNumber, base.prNumber, {
      error: { code: 'PR_PAYLOAD_INVALID', message: 'base, head, title and body are required', retryable: false }
    });
  }
  if (base.prNumber) return inspectPlatformPullRequest(taskRef, options);
  try {
    return withTaskExecutionLock(
      base.resolved.repoRoot,
      base.resolved.taskId,
      'platform-pr.create',
      () => createPlatformPullRequestUnlocked(taskRef, options)
    );
  } catch (error) {
    if (error instanceof TaskExecutionLockError) {
      return result('blocked', base.resolved.taskId, base.issueNumber, null, {
        platform: base.context.platform,
        capabilities: base.context.capabilities,
        error: { code: error.code, message: error.message, retryable: true }
      });
    }
    return result('failed', base.resolved.taskId, base.issueNumber, null, {
      platform: base.context.platform,
      capabilities: base.context.capabilities,
      error: {
        code: 'PR_CREATE_FAILED',
        message: error instanceof Error ? error.message : String(error),
        retryable: false
      }
    });
  }
}

function syncPlatformPullRequest(taskRef: string, options: SyncOptions): PullRequestResult {
  const base = resolvedContext(taskRef, options);
  if (!base.ok) return base.output;
  if (!base.prNumber) return result('failed', base.resolved.taskId, base.issueNumber, null, {
    error: { code: 'PR_NOT_LINKED', message: 'Task has no valid pr_number', retryable: false }
  });
  const fetched = inspectGitHubPullRequest(base.client, base.context.platform.repository!, base.prNumber, base.resolved.repoRoot);
  if (!fetched.ok) return result(fetched.error.retryable ? 'blocked' : 'failed', base.resolved.taskId, base.issueNumber, base.prNumber, { error: fetched.error });
  if (!options.metadata && !options.closingIssue) return result('failed', base.resolved.taskId, base.issueNumber, base.prNumber, {
    error: { code: 'PR_PAYLOAD_INVALID', message: 'sync requires a desired-state option', retryable: false }
  });
  if (!base.issueNumber) return result('degraded', base.resolved.taskId, null, base.prNumber, {
    pullRequest: fetched.value, error: { code: 'ISSUE_NOT_LINKED', message: 'Task has no linked Issue to copy metadata from', retryable: false }
  });
  const issue = inspectPlatformIssue(taskRef, { cwd: base.resolved.repoRoot, client: base.client });
  if (!issue.issue) return result(issue.status, base.resolved.taskId, base.issueNumber, base.prNumber, {
    platform: base.context.platform, capabilities: base.context.capabilities, pullRequest: fetched.value, error: issue.error
  });
  const planned = planPullRequestMetadata({
    pullRequest: fetched.value,
    issue: issue.issue,
    taskType: base.frontmatter.type || 'task',
    issueNumber: base.issueNumber,
    capabilities: base.context.capabilities
  }).operations.filter((operation) => options.metadata || operation.name === 'closing-issue')
    .filter((operation) => options.closingIssue || operation.name !== 'closing-issue');
  const operations: PlatformOperation[] = planned.map(({ name, status, reasonCode }) => ({ name, status, reasonCode }));
  if (options.dryRun) return result(planned.some((operation) => operation.status === 'planned') ? 'planned' : 'no-op', base.resolved.taskId, base.issueNumber, base.prNumber, {
    platform: base.context.platform, capabilities: base.context.capabilities, pullRequest: fetched.value, operations, error: null
  });
  const payload: Record<string, unknown> = {};
  for (const operation of planned) {
    if (operation.status !== 'planned') continue;
    if (operation.name === 'labels') payload.labels = operation.value;
    if (operation.name === 'assignees') payload.assignees = operation.value;
    if (operation.name === 'closing-issue') payload.body = operation.value;
    if (operation.name === 'milestone') {
      const milestones = base.client.json<unknown[]>(['api', '--paginate', '--slurp', `repos/${base.context.platform.repository}/milestones?state=open&per_page=100`], { cwd: base.resolved.repoRoot });
      if (!milestones.ok) return result(milestones.error.retryable ? 'blocked' : 'failed', base.resolved.taskId, base.issueNumber, base.prNumber, { pullRequest: fetched.value, operations, error: milestones.error });
      const flat = milestones.value.flatMap((entry) => Array.isArray(entry) ? entry : [entry]) as Array<{ title?: string; number?: number }>;
      payload.milestone = flat.find((entry) => entry.title === operation.value)?.number ?? null;
    }
  }
  if (Object.keys(payload).length === 0) {
    const degraded = planned.some((operation) => operation.status === 'skipped');
    return result(degraded ? 'degraded' : 'no-op', base.resolved.taskId, base.issueNumber, base.prNumber, {
      platform: base.context.platform, capabilities: base.context.capabilities, resource: { kind: 'pull-request', number: base.prNumber }, pullRequest: fetched.value, operations, error: null
    });
  }
  const patched = base.client.json<RemotePullRequest>(['api', `repos/${base.context.platform.repository}/issues/${base.prNumber}`, '-X', 'PATCH', '--input', '-'], {
    cwd: base.resolved.repoRoot, method: 'PATCH', input: JSON.stringify(payload)
  });
  if (!patched.ok) return result(patched.error.retryable ? 'blocked' : 'failed', base.resolved.taskId, base.issueNumber, base.prNumber, { pullRequest: fetched.value, operations, error: patched.error });
  return result(planned.some((operation) => operation.status === 'skipped') ? 'degraded' : 'applied', base.resolved.taskId, base.issueNumber, base.prNumber, {
    changed: true, platform: base.context.platform, capabilities: base.context.capabilities,
    resource: { kind: 'pull-request', number: base.prNumber }, pullRequest: fetched.value,
    operations: operations.map((operation) => operation.status === 'planned' ? { ...operation, status: 'applied' } : operation), error: null
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
  selectExternalPullRequest,
  selectPullRequest,
  syncPlatformPullRequest
};
export type { BindOptions, CreateOptions, ExternalPullRequestResult, ExternalPullRequestSelection, PullRequestResult, PullRequestSnapshot, ResolveExternalOptions, SyncOptions };
