import fs from 'node:fs';

import { parseTaskFrontmatter } from '../task/frontmatter.ts';
import { resolveTaskRef } from '../task/resolve-ref.ts';
import { extractSection } from '../task/sections.ts';
import { captureTaskWriteMetadata, writeTask } from '../task/write.ts';
import { resolvePlatformContext } from './context.ts';
import { createGitHubClient } from './github-client.ts';
import type { GitHubClient } from './github-client.ts';
import { inspectPlatformIssue } from './issues.ts';
import { planPullRequestMetadata } from './pull-request-metadata.ts';
import { platformResult } from './types.ts';
import type { PlatformOperation, PlatformResult } from './types.ts';

type PullRequestSnapshot = {
  repository: string;
  number: number;
  nodeId: string;
  url: string;
  state: 'open' | 'closed';
  title: string;
  body: string;
  draft: boolean;
  head: { repository: string; ref: string; sha: string };
  base: { repository: string; ref: string; sha: string };
  mergedAt: string | null;
  mergeCommitSha: string | null;
  labels: string[];
  assignees: string[];
  milestone: string | null;
};

type PullRequestResult = PlatformResult & {
  task: { id: string | null; issueNumber: number | null; prNumber: number | null };
  pullRequest: PullRequestSnapshot | null;
};
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

function normalizePullRequest(remote: RemotePullRequest, repository: string): PullRequestSnapshot | null {
  const number = Number(remote.number);
  const headRepository = remote.head?.repo?.full_name;
  const baseRepository = remote.base?.repo?.full_name;
  if (!Number.isInteger(number) || number <= 0 || !remote.node_id || !remote.html_url ||
      !remote.head?.ref || !remote.head.sha || !headRepository || !remote.base?.ref || !baseRepository) return null;
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
    milestone: remote.milestone?.title || null
  };
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

function resolvedContext(taskRef: string, options: SharedOptions) {
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
  const client = options.client || createGitHubClient();
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

function inspectPlatformPullRequest(taskRef: string, options: SharedOptions = {}): PullRequestResult {
  const base = resolvedContext(taskRef, options);
  if (!base.ok) return base.output;
  if (!base.prNumber) return result('no-op', base.resolved.taskId, base.issueNumber, null, {
    platform: base.context.platform, capabilities: base.context.capabilities,
    error: { code: 'PR_NOT_LINKED', message: 'Task has no valid pr_number', retryable: false }
  });
  const fetched = inspectGitHubPullRequest(base.client, base.context.platform.repository!, base.prNumber, base.resolved.repoRoot);
  if (!fetched.ok) return result(fetched.error.retryable ? 'blocked' : 'failed', base.resolved.taskId, base.issueNumber, base.prNumber, {
    platform: base.context.platform, capabilities: base.context.capabilities,
    resource: { kind: 'pull-request', number: base.prNumber }, error: fetched.error
  });
  return result('no-op', base.resolved.taskId, base.issueNumber, base.prNumber, {
    platform: base.context.platform, capabilities: base.context.capabilities,
    resource: { kind: 'pull-request', number: base.prNumber }, pullRequest: fetched.value, error: null
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

function createPlatformPullRequest(taskRef: string, options: CreateOptions): PullRequestResult {
  const base = resolvedContext(taskRef, options);
  if (!base.ok) return base.output;
  if (!options.base || !options.head || !options.title.trim() || !options.body.trim()) return result('failed', base.resolved.taskId, base.issueNumber, base.prNumber, {
    error: { code: 'PR_PAYLOAD_INVALID', message: 'base, head, title and body are required', retryable: false }
  });
  if (base.prNumber) return inspectPlatformPullRequest(taskRef, options);
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
  inspectPlatformPullRequest,
  normalizePullRequest,
  selectPullRequest,
  syncPlatformPullRequest
};
export type { BindOptions, CreateOptions, PullRequestResult, PullRequestSnapshot, SyncOptions };
