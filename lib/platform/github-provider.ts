import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import semver from 'semver';

import {
  createGitHubClient,
  MINIMUM_GITHUB_CLI_VERSION
} from './github-client.ts';
import type { GitHubClient } from './github-client.ts';
import type {
  ChangeRequestSnapshot,
  CheckLogSnapshot,
  CheckRunSnapshot,
  GitEvidenceSnapshot,
  IssueSnapshot,
  MutationReceipt,
  PlatformContextSnapshot,
  ProviderOperationContext,
  PlatformProvider,
  PlatformProviderFactoryInput,
  ProviderResult,
  ReleaseSnapshot,
  RemoteCommentSnapshot,
  RequiredCheckSnapshot,
  ReviewSnapshot,
  VerificationRemoteFacts
} from './provider-contract.ts';

const CURRENT_USER_QUERY = 'query { viewer { login } }';

function parseGitHubRemote(remote: string): string | null {
  const trimmed = remote.trim().replace(/\.git$/, '');
  const match = trimmed.match(/^(?:https?:\/\/github\.com\/|ssh:\/\/(?:git@)?github\.com\/|git@github\.com:)([^/\s]+\/[^/\s]+)$/i);
  return match?.[1] || null;
}

function defaultGitRemote(cwd: string): string | null {
  try {
    return execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe']
    }).trim();
  } catch {
    return null;
  }
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
    /^(https?:\/\/github\.com\/|ssh:\/\/(?:git@)?github\.com\/|git@github\.com:)[^\/\s]+\/[^\/\s]+(?:\.git)?$/i
  );
  return match ? `${match[1]}${repository}.git` : null;
}

function resolveGitHubChangeRequestGitEvidence({
  cwd,
  repository,
  number,
  baseRepository,
  baseRef
}: {
  cwd: string;
  repository: string;
  number: number;
  baseRepository: string;
  baseRef: string;
}) {
  if (baseRepository !== repository || number <= 0) {
    return {
      ok: false as const,
      error: {
        code: 'PR_MERGE_EVIDENCE_SOURCE_UNAVAILABLE',
        message: 'Pull request repository identity is inconsistent',
        retryable: false
      }
    };
  }
  const reviewedHeadRef = `refs/pull/${number}/head`;
  const targetHeadRef = `refs/heads/${baseRef}`;
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

function failure(error: { code: string; message: string; retryable: boolean }): ProviderResult<PlatformContextSnapshot> {
  return { ok: false, error };
}

function resolveContext(
  client: GitHubClient,
  input: Parameters<PlatformProvider['context']['resolve']>[0]
): ProviderResult<PlatformContextSnapshot> {
  const cwd = input.workingDirectory;
  const version = client.version({ cwd });
  if (!version.ok) return failure(version.error);
  if (!semver.gte(version.value, MINIMUM_GITHUB_CLI_VERSION)) {
    return failure({
      code: 'GH_CLI_VERSION_UNSUPPORTED',
      message: 'GitHub CLI ' + version.value + ' is unsupported; install gh >= ' + MINIMUM_GITHUB_CLI_VERSION,
      retryable: false
    });
  }
  const remote = input.gitRemote || defaultGitRemote(cwd);
  if (!remote) {
    return failure({ code: 'REMOTE_MISSING', message: 'Git origin remote is not configured', retryable: false });
  }
  const ownerRepo = parseGitHubRemote(remote);
  if (!ownerRepo) {
    return failure({
      code: /github\.com/i.test(remote) ? 'REMOTE_INVALID' : 'PLATFORM_UNSUPPORTED',
      message: 'Unable to parse GitHub owner/repo from configured remote',
      retryable: false
    });
  }
  const repository = client.json(['api', 'repos/' + ownerRepo], { cwd });
  if (!repository.ok) return failure(repository.error);
  const repositoryValue = repository.value as { fork?: boolean; full_name?: string; parent?: { full_name?: string } } | null;
  const upstream = repositoryValue?.fork ? repositoryValue.parent?.full_name : repositoryValue?.full_name;
  if (!upstream) return failure({
    code: 'UPSTREAM_UNRESOLVED',
    message: 'Unable to resolve the upstream repository',
    retryable: false
  });
  const user = client.json(['api', 'graphql', '-f', 'query=' + CURRENT_USER_QUERY], { cwd });
  if (!user.ok) return failure(user.error);
  const userValue = user.value as { data?: { viewer?: { login?: string } } } | null;
  const currentUser = userValue?.data?.viewer?.login || null;
  const permissions = client.json(['api', 'repos/' + upstream], { cwd });
  if (!permissions.ok) return failure(permissions.error);
  const permissionValue = permissions.value as { permissions?: Record<string, boolean> } | null;
  const values = permissionValue?.permissions || {};
  const capabilities = {
    authenticated: Boolean(currentUser),
    comment: Boolean(currentUser),
    triage: Boolean(values.triage || values.push || values.admin),
    push: Boolean(values.push || values.admin),
    admin: Boolean(values.admin)
  };
  return {
    ok: true,
    value: {
      type: 'github',
      scope: { id: upstream, label: upstream },
      currentUser: currentUser ? { id: currentUser, name: currentUser } : null,
      capabilities,
      authenticated: capabilities.authenticated
    }
  };
}

function repository(context: ProviderOperationContext): string {
  return context.scopeId;
}

function invalid(code: string, message: string): ProviderResult<never> {
  return { ok: false, error: { code, message, retryable: false } };
}

function changeRequestSnapshot(value: any): ChangeRequestSnapshot {
  return {
    id: value.nodeId,
    number: value.number,
    state: value.state,
    title: value.title,
    body: value.body,
    baseSha: value.base.sha,
    headSha: value.head.sha,
    mergedAt: value.mergedAt,
    displayUrl: value.url,
    draft: value.draft,
    labels: value.labels,
    assignees: value.assignees,
    milestone: value.milestone,
    mergeCommitSha: value.mergeCommitSha,
    mergeability: value.mergeability,
    head: value.head,
    base: value.base
  };
}

function issueSnapshot(value: any): IssueSnapshot {
  return {
    id: value.nodeId,
    number: value.number,
    state: value.state,
    title: value.title,
    body: value.body,
    labels: value.labels,
    assignees: value.assignees,
    milestone: value.milestone,
    fields: value.fields,
    displayUrl: value.url
  };
}

function commentSnapshot(value: any): RemoteCommentSnapshot {
  return {
    id: String(value.id),
    author: value.user?.login ? { id: String(value.user.login), name: String(value.user.login) } : null,
    body: String(value.body || ''),
    createdAt: String(value.created_at || ''),
    updatedAt: String(value.updated_at || value.created_at || '')
  };
}

function createReceipt(remoteId: string, url?: string): ProviderResult<MutationReceipt> {
  return { ok: true, value: { changed: true, remoteId, ...(url ? { url } : {}) } };
}

function createGitHubOperations(client: GitHubClient): Pick<PlatformProvider, 'issues' | 'comments' | 'changeRequests' | 'checks' | 'reviews' | 'releases' | 'verification'> {
  const issues: NonNullable<PlatformProvider['issues']> = {
    async inspect({ context, target }) {
      const number = target.number;
      if (!number) return invalid('ISSUE_NUMBER_INVALID', 'Issue number must be positive');
      const module = await import('./issues.ts');
      const fetched = module.inspectGitHubIssue(client, repository(context), number, context.workingDirectory);
      if (!fetched.ok) return fetched;
      return { ok: true, value: issueSnapshot(fetched.value) };
    },
    async create({ context, desired }) {
      const response = client.json<any>(['api', `repos/${repository(context)}/issues`, '-X', 'POST', '--input', '-'], {
        cwd: context.workingDirectory,
        method: 'POST',
        input: JSON.stringify({
          title: desired.title,
          body: desired.body,
          labels: desired.labels,
          assignees: desired.assignees,
          ...(desired.milestone ? { milestone: desired.milestone } : {})
        })
      });
      if (!response.ok) return response;
      const number = Number(response.value?.number);
      if (!Number.isInteger(number) || number <= 0) return invalid('ISSUE_CREATE_RESPONSE_INVALID', 'Issue create response lacks issue number');
      return createReceipt(String(number), response.value?.html_url);
    },
    async update({ context, target, patch }) {
      if (!target.number) return invalid('ISSUE_NUMBER_INVALID', 'Issue number must be positive');
      const response = client.json<any>(['api', `repos/${repository(context)}/issues/${target.number}`, '-X', 'PATCH', '--input', '-'], {
        cwd: context.workingDirectory,
        method: 'PATCH',
        input: JSON.stringify(patch)
      });
      if (!response.ok) return response;
      return createReceipt(String(target.number));
    }
  };

  const comments: NonNullable<PlatformProvider['comments']> = {
    async list({ context, parent }) {
      if (!parent.number) return invalid('ISSUE_NUMBER_INVALID', 'Issue number must be positive');
      const response = client.json<any>(['api', '--paginate', '--slurp', `repos/${repository(context)}/issues/${parent.number}/comments?per_page=100`], { cwd: context.workingDirectory });
      if (!response.ok) return response;
      const values = Array.isArray(response.value) ? response.value.flatMap((entry: any) => Array.isArray(entry) ? entry : [entry]) : [];
      return { ok: true, value: values.filter((entry: any) => entry && entry.id !== undefined).map(commentSnapshot) };
    },
    async write({ context, parent, body, existingComment }) {
      if (!parent.number) return invalid('ISSUE_NUMBER_INVALID', 'Issue number must be positive');
      const commentId = existingComment?.id;
      const endpoint = commentId ? `repos/${repository(context)}/issues/comments/${commentId}` : `repos/${repository(context)}/issues/${parent.number}/comments`;
      const response = client.json<any>(['api', endpoint, '-X', commentId ? 'PATCH' : 'POST', '--input', '-'], {
        cwd: context.workingDirectory,
        method: commentId ? 'PATCH' : 'POST',
        input: JSON.stringify({ body })
      });
      if (!response.ok) return response;
      return createReceipt(String(response.value?.id || commentId || ''));
    },
    async delete({ context, comment }) {
      if (!comment.id) return invalid('COMMENT_ID_INVALID', 'Comment id is required');
      const response = client.text(['api', `repos/${repository(context)}/issues/comments/${comment.id}`, '-X', 'DELETE'], { cwd: context.workingDirectory, method: 'DELETE' });
      if (!response.ok) return response;
      return createReceipt(String(comment.id));
    }
  };

  const changeRequests: NonNullable<PlatformProvider['changeRequests']> = {
    async inspect({ context, target }) {
      if (!target.number) return invalid('PR_NUMBER_INVALID', 'Pull request number must be positive');
      const module = await import('./pull-requests.ts');
      const fetched = module.inspectGitHubPullRequest(client, repository(context), target.number, context.workingDirectory);
      if (!fetched.ok) return fetched;
      return { ok: true, value: changeRequestSnapshot(fetched.value) };
    },
    async listClosing({ context, issue }) {
      if (!issue.number) return invalid('ISSUE_NUMBER_INVALID', 'Issue number must be positive');
      const module = await import('./pull-requests.ts');
      const fetched = module.inspectGitHubIssueClosingChangeRequests(client, repository(context), issue.number, context.workingDirectory);
      if (!fetched.ok) return fetched;
      return { ok: true, value: fetched.value.map(changeRequestSnapshot) };
    },
    async create({ context, base, head, title, body, draft }) {
      const response = client.json<any>(['api', `repos/${repository(context)}/pulls`, '-X', 'POST', '--input', '-'], {
        cwd: context.workingDirectory,
        method: 'POST',
        input: JSON.stringify({ title, body, head, base, draft })
      });
      if (!response.ok) return response;
      const number = Number(response.value?.number);
      if (!Number.isInteger(number) || number <= 0) return invalid('PR_CREATE_RESPONSE_INVALID', 'Pull request create response lacks number');
      return createReceipt(String(number), response.value?.html_url);
    },
    async update({ context, target, patch }) {
      if (!target.number) return invalid('PR_NUMBER_INVALID', 'Pull request number must be positive');
      const response = client.json<any>(['api', `repos/${repository(context)}/pulls/${target.number}`, '-X', 'PATCH', '--input', '-'], {
        cwd: context.workingDirectory,
        method: 'PATCH',
        input: JSON.stringify(patch)
      });
      if (!response.ok) return response;
      return createReceipt(String(target.number));
    },
    async resolveGitEvidence({ context, target, expected }) {
      if (!target.number) return invalid('PR_NUMBER_INVALID', 'Pull request number must be positive');
      const module = await import('./github-provider.ts');
      return module.resolveGitHubChangeRequestGitEvidence({
        cwd: context.workingDirectory,
        repository: repository(context),
        number: target.number,
        baseRepository: repository(context),
        baseRef: expected.targetBranch || 'main'
      });
    }
  };

  const checks: NonNullable<PlatformProvider['checks']> = {
    async inspectRequired({ context, changeRequest }) {
      if (!changeRequest.number) return invalid('PR_NUMBER_INVALID', 'Pull request number must be positive');
      const module = await import('./pr-checks.ts');
      const fetched = module.inspectGitHubRequiredChecks(client, repository(context), changeRequest.number, context.workingDirectory);
      if (!fetched.ok) return fetched;
      return { ok: true, value: fetched.value.map((check: any): RequiredCheckSnapshot => ({ name: check.name, status: check.bucket, conclusion: check.conclusion, detailsUrl: check.detailsUrl })) };
    },
    async resolveRun({ context, changeRequest, checkName, detailsUrl }) {
      if (!changeRequest.number) return invalid('PR_NUMBER_INVALID', 'Pull request number must be positive');
      const module = await import('./pr-checks.ts');
      const direct = detailsUrl ? module.parseRunJobIdentity(detailsUrl) : null;
      if (direct) {
        const run = client.json<any>(['api', `repos/${repository(context)}/actions/runs/${direct.runId}`], { cwd: context.workingDirectory });
        if (!run.ok) return run;
        return { ok: true, value: { runId: String(direct.runId), jobId: direct.jobId ? String(direct.jobId) : undefined } } as ProviderResult<CheckRunSnapshot>;
      }
      const listed = client.json<any>(['api', `repos/${repository(context)}/commits/${changeRequest.number}/check-runs`], { cwd: context.workingDirectory });
      if (!listed.ok) return listed;
      const candidate = (listed.value?.check_runs || []).find((run: any) => run.name === checkName && run.id);
      return candidate
        ? { ok: true, value: { runId: String(candidate.id), jobId: candidate.job_id ? String(candidate.job_id) : undefined, name: checkName, status: String(candidate.status || ''), conclusion: candidate.conclusion, detailsUrl: candidate.details_url } }
        : invalid('CHECK_RUN_NOT_FOUND', 'Check run was not found');
    },
    async fetchLogs({ context, runId, jobId }) {
      const module = await import('./pr-checks.ts');
      const args = jobId
        ? ['api', `repos/${repository(context)}/actions/jobs/${jobId}/logs`]
        : ['run', 'view', runId, '--repo', repository(context), '--log-failed'];
      const fetched = module.fetchCheckLogText(client, args, context.workingDirectory);
      if (!fetched.ok) return fetched;
      return { ok: true, value: { runId, jobId, text: fetched.value || '' } } as ProviderResult<CheckLogSnapshot>;
    }
  };

  const reviews: NonNullable<PlatformProvider['reviews']> = {
    async list({ context, changeRequest }) {
      if (!changeRequest.number) return invalid('PR_NUMBER_INVALID', 'Pull request number must be positive');
      const response = client.json<any[]>(['api', '--paginate', '--slurp', `repos/${repository(context)}/pulls/${changeRequest.number}/reviews?per_page=100`], { cwd: context.workingDirectory });
      if (!response.ok) return response;
      const values = Array.isArray(response.value) ? response.value.flatMap((entry: any) => Array.isArray(entry) ? entry : [entry]) : [];
      return { ok: true, value: values.filter((review: any) => review?.body).map((review: any): ReviewSnapshot => ({ id: String(review.id || review.node_id || ''), author: review.user?.login ? { id: String(review.user.login), name: String(review.user.login) } : null, commitSha: String(review.commit_id || ''), body: String(review.body), state: String(review.state || ''), submittedAt: String(review.submitted_at || ''), displayUrl: review.html_url })) };
    },
    async publish({ context, changeRequest, identity, event, body }) {
      if (!changeRequest.number) return invalid('PR_NUMBER_INVALID', 'Pull request number must be positive');
      const response = client.json<any>(['api', `repos/${repository(context)}/pulls/${changeRequest.number}/reviews`, '-X', 'POST', '--input', '-'], {
        cwd: context.workingDirectory,
        method: 'POST',
        input: JSON.stringify({ commit_id: identity.commitSha, body, event })
      });
      if (!response.ok) return response;
      return createReceipt(String(response.value?.id || ''));
    }
  };

  const releases: NonNullable<PlatformProvider['releases']> = {
    async inspect({ context, tag }) {
      const response = client.json<any>(['release', 'view', tag, '--repo', repository(context), '--json', 'tagName,isDraft,url'], { cwd: context.workingDirectory });
      if (!response.ok) return response;
      const value: ReleaseSnapshot = { id: String(response.value?.id || tag), tag: String(response.value?.tagName || tag), title: String(response.value?.name || tag), body: String(response.value?.body || ''), draft: Boolean(response.value?.isDraft), prerelease: Boolean(response.value?.isPrerelease), publishedAt: response.value?.publishedAt ? String(response.value.publishedAt) : null, displayUrl: response.value?.url ? String(response.value.url) : undefined };
      return { ok: true, value };
    },
    async create({ context, tag, title, notes }) {
      const args = ['release', 'create', tag, '--repo', repository(context), '--title', title];
      if (notes) args.push('--notes', notes.text);
      const response = client.text(args, { cwd: context.workingDirectory, method: 'POST' });
      if (!response.ok) return response;
      return createReceipt(tag, response.value || undefined);
    },
    async update({ context, release, patch }) {
      const tag = release.key || String(release.id || '');
      const args = ['release', 'edit', tag, '--repo', repository(context)];
      if (patch.title) args.push('--title', patch.title);
      if (patch.body) args.push('--notes', patch.body);
      const response = client.text(args, { cwd: context.workingDirectory, method: 'PATCH' });
      if (!response.ok) return response;
      return createReceipt(tag, response.value || undefined);
    },
    async reconcileMilestones({ context, desired }) {
      const listed = client.json<any>(['api', '--paginate', '--slurp', `repos/${repository(context)}/milestones?state=all&per_page=100`], { cwd: context.workingDirectory });
      if (!listed.ok) return listed;
      const values = Array.isArray(listed.value) ? listed.value.flatMap((entry: any) => Array.isArray(entry) ? entry : [entry]) : [];
      const created: string[] = [];
      const closed: string[] = [];
      for (const item of desired) {
        const current = values.find((candidate: any) => candidate.title === item.title);
        if (current) {
          if (item.state === 'closed' && current.state !== 'closed') {
            const response = client.json(['api', '--method', 'PATCH', `repos/${repository(context)}/milestones/${current.number}`, '-f', 'state=closed'], { cwd: context.workingDirectory });
            if (!response.ok) return response;
            closed.push(item.title);
          }
          continue;
        }
        const response = client.json(['api', '--method', 'POST', `repos/${repository(context)}/milestones`, '-f', `title=${item.title}`, '-f', `description=${item.description}`], { cwd: context.workingDirectory });
        if (!response.ok) return response;
        created.push(item.title);
      }
      return { ok: true, value: { changed: created.length > 0 || closed.length > 0, created, closed } };
    },
    async publishNotes({ context, release, title, notes }) {
      const module = await import('./github-release-notes.ts');
      const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-infra-release-notes-'));
      const notesFile = path.join(temporaryRoot, 'notes.md');
      fs.writeFileSync(notesFile, notes.text);
      try {
        const result = module.publishGitHubReleaseNotes({ repository: repository(context), tag: release.key || String(release.id || ''), title, notesFile }, { cwd: context.workingDirectory, client });
        if (result.status === 'failed' || result.status === 'blocked') return { ok: false, error: result.error || { code: 'RELEASE_NOTES_PUBLISH_FAILED', message: 'Release notes publish failed', retryable: false } };
        return { ok: true, value: { changed: result.changed, remoteId: release.key || String(release.id || '') } };
      } finally {
        fs.rmSync(temporaryRoot, { recursive: true, force: true });
      }
    }
  };

  const verification: NonNullable<PlatformProvider['verification']> = {
    async fetchRemoteFacts(input) {
      const module = await import('./verification-sync.ts');
      const result = await module.fetchGitHubRemoteData({
        ...input,
        providerType: 'github',
        provider: null,
        loadedContext: null,
        upstreamRepo: repository(input.context),
        taskDir: input.context.workingDirectory,
        issueNumber: input.issue?.number || null,
        prNumber: input.changeRequest?.number || null,
        config: { verify_issue_fields: input.includeFields }
      }, client);
      if (result.earlyReturn) return { ok: false, error: { code: 'PLATFORM_PROVIDER_OPERATION_FAILED', message: result.earlyReturn.message || 'GitHub verification data could not be fetched', retryable: result.earlyReturn.status === 'blocked' } };
      return {
        ok: true,
        value: {
          issue: result.issue ? {
            id: String(input.issue?.number || ''),
            number: input.issue?.number,
            state: String(result.issue.state || '').toLowerCase() === 'closed' ? 'closed' : 'open',
            title: '',
            body: String(result.issue.body || ''),
            labels: (result.issue.labels || []).map((item: any) => String(item.name || item)),
            assignees: [],
            milestone: result.issue.milestone?.title || null,
            fields: result.issueFields || {}
          } : null,
          comments: (result.comments || []).map((comment: any) => commentSnapshot(comment)),
          changeRequest: input.changeRequest ? {
            id: String(input.changeRequest.number || ''),
            number: input.changeRequest.number,
            state: '',
            title: '',
            body: '',
            headSha: result.prHeadSha,
            labels: result.prLabels || [],
            assignees: result.prAssignees || []
          } : null,
          commit: null,
          fields: result.issueFields || {}
        }
      } as ProviderResult<VerificationRemoteFacts>;
    }
  };

  return { issues, comments, changeRequests, checks, reviews, releases, verification };
}

function createGitHubProvider(
  input: PlatformProviderFactoryInput,
  client: GitHubClient = createGitHubClient()
): PlatformProvider {
  return {
    type: input.providerType,
    contractVersion: 1,
    ...createGitHubOperations(client),
    context: {
      async resolve(contextInput) {
        return resolveContext(client, contextInput);
      }
    }
  };
}

export {
  configuredGitRemotes,
  createGitHubProvider,
  defaultGitRemote,
  parseGitHubRemote,
  resolveGitHubChangeRequestGitEvidence
};
