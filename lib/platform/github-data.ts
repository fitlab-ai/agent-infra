import type { PlatformClient as GitHubClient } from './context.ts';
import type { PlatformIssueSnapshot as IssueSnapshot, PlatformChangeRequestSnapshot as PullRequestSnapshot } from './snapshots.ts';
import type { RequiredCheckSnapshot } from './provider-contract.ts';
import { checkStatusBucket } from './check-status.ts';

type RemoteIssue = {
  number?: number;
  id?: number;
  node_id?: string;
  html_url?: string;
  state?: string;
  title?: string;
  body?: string | null;
  labels?: Array<string | { name?: string }>;
  assignees?: Array<{ login?: string }>;
  milestone?: { title?: string } | null;
  type?: { name?: string } | null;
  pull_request?: unknown;
};

type IssueFieldSchema = {
  id: string;
  name: string;
  kind: 'single-select' | 'date' | 'text' | 'number';
  options: Array<{ id: string; name: string }>;
};

type IssueTypeSchema = { id: string; name: string; fields: IssueFieldSchema[] };

type CurrentField = { id: string; name: string; kind: IssueFieldSchema['kind']; value: string | number | null };

const ISSUE_FIELDS_QUERY = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){issue(number:$number){id issueType{id name pinnedFields{__typename ... on IssueFieldSingleSelect{id name options{id name}} ... on IssueFieldDate{id name} ... on IssueFieldText{id name} ... on IssueFieldNumber{id name}}} issueFieldValues(first:50){nodes{__typename ... on IssueFieldSingleSelectValue{name optionId field{... on IssueFieldSingleSelect{id name}}} ... on IssueFieldDateValue{value field{... on IssueFieldDate{id name}}} ... on IssueFieldTextValue{value field{... on IssueFieldText{id name}}} ... on IssueFieldNumberValue{value field{... on IssueFieldNumber{id name}}}}}}}}`;

function normalizeIssue(remote: RemoteIssue, repository: string, fallbackNumber?: number): IssueSnapshot | null {
  const number = Number.isInteger(remote.number) && Number(remote.number) > 0
    ? Number(remote.number)
    : fallbackNumber;
  if (!number || !Number.isSafeInteger(number) || remote.pull_request) return null;
  return {
    repository,
    number,
    databaseId: Number.isInteger(remote.id) ? Number(remote.id) : null,
    nodeId: remote.node_id || `issue-${number}`,
    url: remote.html_url || `https://github.com/${repository}/issues/${number}`,
    state: String(remote.state || '').toLowerCase() === 'closed' ? 'closed' : 'open',
    title: remote.title || '',
    body: remote.body || '',
    labels: (remote.labels || []).map((label) => typeof label === 'string' ? label : label.name || '').filter(Boolean).sort(),
    assignees: (remote.assignees || []).map((assignee) => assignee.login || '').filter(Boolean).sort(),
    milestone: remote.milestone?.title || null,
    issueType: remote.type?.name || null,
    fields: {}
  };
}

function fieldKind(value: { __typename?: string }): IssueFieldSchema['kind'] | null {
  if (value.__typename === 'IssueFieldSingleSelect' || value.__typename === 'IssueFieldSingleSelectValue') return 'single-select';
  if (value.__typename === 'IssueFieldDate' || value.__typename === 'IssueFieldDateValue') return 'date';
  if (value.__typename === 'IssueFieldText' || value.__typename === 'IssueFieldTextValue') return 'text';
  if (value.__typename === 'IssueFieldNumber' || value.__typename === 'IssueFieldNumberValue') return 'number';
  return null;
}

function normalizeFieldSchemas(value: unknown): IssueFieldSchema[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw) => {
    const item = raw as { id?: string; name?: string; __typename?: string; options?: Array<{ id?: string; name?: string }> };
    const kind = fieldKind(item);
    return item.id && item.name && kind ? [{
      id: item.id,
      name: item.name,
      kind,
      options: (item.options || []).flatMap((option) => option.id && option.name ? [{ id: option.id, name: option.name }] : [])
    }] : [];
  });
}

function normalizeCurrentFields(value: unknown): { issueId: string | null; type: IssueTypeSchema | null; values: CurrentField[] } {
  const issue = (value as { data?: { repository?: { issue?: {
    id?: string;
    issueType?: { id?: string; name?: string; pinnedFields?: unknown[] } | null;
    issueFieldValues?: { nodes?: unknown[] };
  } } } })?.data?.repository?.issue;
  const type = issue?.issueType?.name ? {
    id: issue.issueType.id || issue.issueType.name,
    name: issue.issueType.name,
    fields: normalizeFieldSchemas(issue.issueType.pinnedFields)
  } : null;
  const values = (issue?.issueFieldValues?.nodes || []).flatMap((raw) => {
    const item = raw as { __typename?: string; name?: string; value?: string | number; field?: { id?: string; name?: string } };
    const kind = fieldKind(item);
    const value = kind === 'single-select' ? item.name : item.value;
    return item.field?.name && kind && value !== undefined
      ? [{ id: item.field.id || item.field.name, name: item.field.name, kind, value: value ?? null }]
      : [];
  });
  return { issueId: issue?.id || null, type, values };
}

function graphState(client: GitHubClient, repository: string, issue: number, cwd: string) {
  const [owner, name] = repository.split('/');
  if (!owner || !name) return null;
  const current = client.json<unknown>([
    'api', 'graphql', '-f', `query=${ISSUE_FIELDS_QUERY}`, '-F', `owner=${owner}`, '-F', `name=${name}`, '-F', `number=${issue}`
  ], { cwd });
  if (!current.ok) return null;
  return normalizeCurrentFields(current.value);
}

function fetchIssue(client: GitHubClient, repository: string, issue: number, cwd: string) {
  return client.json<RemoteIssue>(['api', `repos/${repository}/issues/${issue}`], { cwd });
}

function inspectGitHubIssue(client: GitHubClient, repository: string, issue: number, cwd: string) {
  const fetched = fetchIssue(client, repository, issue, cwd);
  if (!fetched.ok) return fetched;
  const snapshot = normalizeIssue(fetched.value, repository, issue);
  return snapshot
    ? { ok: true as const, value: snapshot }
    : { ok: false as const, error: { code: 'ISSUE_IDENTITY_INVALID', message: 'Remote resource is not a valid Issue', retryable: false } };
}

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

const CLOSING_PULL_REQUESTS_QUERY = `query($owner:String!,$name:String!,$issue:Int!,$cursor:String){repository(owner:$owner,name:$name){issue(number:$issue){closedByPullRequestsReferences(first:100,after:$cursor){nodes{number id url state title body isDraft headRefName headRefOid headRepository{nameWithOwner} baseRefName baseRefOid baseRepository{nameWithOwner} mergedAt mergeCommit{oid} labels(first:100){nodes{name}} assignees(first:100){nodes{login}} milestone{title}} pageInfo{hasNextPage endCursor}}}}}`;

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

function inspectGitHubPullRequest(client: GitHubClient, repository: string, number: number, cwd: string) {
  const fetched = client.json<RemotePullRequest>(['api', `repos/${repository}/pulls/${number}`], { cwd });
  if (!fetched.ok) return fetched;
  const pullRequest = normalizePullRequest(fetched.value, repository);
  return pullRequest
    ? { ok: true as const, value: pullRequest }
    : { ok: false as const, error: { code: 'PR_IDENTITY_INVALID', message: 'Remote resource is not a valid pull request', retryable: false } };
}

function normalizeGitHubChecks(value: unknown): RequiredCheckSnapshot[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw) => {
    const item = raw as Record<string, unknown>;
    const name = String(item.name || item.context || '');
    return name ? [{
      name,
      status: checkStatusBucket(String(item.bucket || item.status || item.conclusion || item.state || '')),
      conclusion: item.conclusion ? String(item.conclusion) : item.state ? String(item.state) : null,
      detailsUrl: item.link ? String(item.link) : item.detailsUrl ? String(item.detailsUrl) : null
    }] : [];
  });
}

function inspectGitHubRequiredChecks(client: GitHubClient, repository: string, number: number, cwd: string) {
  const inspected = client.json<unknown>([
    'pr', 'checks', String(number), '--repo', repository,
    '--json', 'name,state,bucket,link,workflow,startedAt,completedAt'
  ], { cwd });
  return inspected.ok
    ? { ok: true as const, value: normalizeGitHubChecks(inspected.value) }
    : { ok: false as const, error: inspected.error };
}

function parseRunJobIdentity(detailsUrl: string): { runId: number; jobId: number | null } | null {
  try {
    const url = new URL(detailsUrl);
    if (url.hostname !== 'github.com') return null;
    const match = url.pathname.match(/\/actions\/runs\/(\d+)(?:\/job\/(\d+))?/);
    if (!match) return null;
    return { runId: Number(match[1]), jobId: match[2] ? Number(match[2]) : null };
  } catch {
    return null;
  }
}

function fetchCheckLogText(client: GitHubClient, args: string[], cwd: string) {
  if (!client.text) return { ok: false as const, error: { code: 'PLATFORM_CLIENT_TEXT_UNAVAILABLE', message: 'Platform client does not support text responses', retryable: false } };
  const fetched = client.text(args, { cwd });
  if (fetched.ok || args[0] !== 'api' || !/response contains terminal escape sequences/i.test(fetched.error.message)) {
    return fetched;
  }
  return client.text([...args, '--allow-escape-sequences'], { cwd });
}

export { ISSUE_FIELDS_QUERY, graphState, inspectGitHubIssue, normalizePullRequest, inspectGitHubIssueClosingChangeRequests, inspectGitHubPullRequest, inspectGitHubRequiredChecks, parseRunJobIdentity, fetchCheckLogText };
export type { IssueFieldSchema, RemotePullRequest };
