import { ISSUE_FIELDS_QUERY, graphState, inspectGitHubIssue, inspectGitHubPullRequest, inspectGitHubIssueClosingChangeRequests, inspectGitHubRequiredChecks, parseRunJobIdentity, fetchCheckLogText } from './github-data.ts';
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
  IssueSnapshot,
  LabelDefinition,
  LabelReconciliation,
  MutationReceipt,
  MilestoneInitialization,
  PlatformContextSnapshot,
  ProviderError,
  ProviderOperationContext,
  PlatformProvider,
  PlatformProviderFactoryInput,
  ProviderResult,
  ResourceIdentity,
  ReleaseNotesFacts,
  RepositoryMetadataSnapshot,
  ReleaseSnapshot,
  RemoteCommentSnapshot,
  ReviewSnapshot,
  SecurityAlertSnapshot,
  VerificationRemoteFacts
} from './provider-contract.ts';
import { resourceIdentityNumber, resourceIdentityString } from './resource-identity.ts';
import { extractPullRequestFileNames, syncLabelDelta } from './in-label-sync.ts';
import type { PlatformError } from './types.ts';

function providerError(error: PlatformError | ProviderError): ProviderError {
  return { code: error.code, message: error.message };
}

function publicProviderErrors(provider: PlatformProvider): PlatformProvider {
  const sanitize = async (call: () => Promise<unknown>): Promise<unknown> => {
    const result = await call();
    if (!result || typeof result !== 'object' || (result as { ok?: unknown }).ok !== false) return result;
    const envelope = result as { error?: PlatformError | ProviderError };
    return envelope.error ? { ...(result as Record<string, unknown>), error: providerError(envelope.error) } : result;
  };
  const wrapped: PlatformProvider = { ...provider, context: { ...provider.context } };
  wrapped.context.resolve = (input) => sanitize(() => provider.context.resolve(input)) as ReturnType<PlatformProvider['context']['resolve']>;
  for (const groupName of ['issues', 'comments', 'changeRequests', 'checks', 'reviews', 'releases', 'securityAlerts', 'repositoryMetadata', 'verification'] as const) {
    const group = provider[groupName];
    if (!group) continue;
    const target: Record<string, unknown> = { ...group };
    for (const method of Object.keys(group)) {
      const original = group[method as keyof typeof group] as (...args: never[]) => Promise<unknown>;
      target[method] = (input: unknown) => sanitize(() => original(input as never));
    }
    (wrapped as unknown as Record<string, unknown>)[groupName] = target;
  }
  return wrapped;
}

const CURRENT_USER_QUERY = 'query { viewer { login } }';
const ISSUE_TYPES_QUERY = `query($owner:String!){organization(login:$owner){issueTypes(first:20){nodes{id name pinnedFields{__typename ... on IssueFieldSingleSelect{id name options{id name}} ... on IssueFieldDate{id name} ... on IssueFieldText{id name} ... on IssueFieldNumber{id name}}}}}}`;
const CLOSING_ISSUES_QUERY = 'query($owner:String!,$name:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$name){pullRequest(number:$number){closingIssuesReferences(first:100,after:$cursor){nodes{number} pageInfo{hasNextPage endCursor}}}}}';

function parseGitHubRemote(remote: string): string | null {
  const trimmed = remote.trim().replace(/\.git$/, '');
  const match = trimmed.match(/^(?:https?:\/\/github\.com\/|ssh:\/\/(?:git@)?github\.com\/|git@github\.com:)([^/\s]+\/[^/\s]+)$/i);
  return match?.[1] || null;
}

function defaultGitRemote(cwd: string): string | null {
  try {
    return execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
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
  client,
  cwd,
  repository,
  number,
  baseRepository,
  baseRef
}: {
  client: GitHubClient;
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
      }
    };
  }
  const repositoryInfo = client.json<{ full_name?: unknown; default_branch?: unknown }>(['api', `repos/${repository}`], { cwd });
  if (!repositoryInfo.ok || !repositoryInfo.value || repositoryInfo.value.full_name !== repository || typeof repositoryInfo.value.default_branch !== 'string' || !repositoryInfo.value.default_branch) {
    return { ok: false as const, error: { code: 'PR_MERGE_EVIDENCE_SOURCE_UNAVAILABLE', message: 'Unable to resolve repository default branch' } };
  }
  return {
    ok: true as const,
    value: { remoteUrl, reviewedHeadRef, targetHeadRef, defaultBranch: repositoryInfo.value.default_branch }
  };
}

function listGitHubCommitPullRequestAssociations(client: GitHubClient, repository: string, commitSha: string, cwd: string) {
  const response = client.json<unknown>(['api', '--paginate', '--slurp', `repos/${repository}/commits/${commitSha}/pulls?per_page=100`], { cwd });
  if (!response.ok) return response;
  if (!Array.isArray(response.value) || response.value.some((page) => !Array.isArray(page))) {
    return { ok: false as const, error: { code: 'PR_MERGE_EVIDENCE_SOURCE_UNAVAILABLE', message: 'GitHub returned incomplete commit pull request associations' } };
  }
  const pullRequestNumbers: number[] = [];
  for (const page of response.value) {
    for (const item of page) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        return { ok: false as const, error: { code: 'PR_MERGE_EVIDENCE_SOURCE_UNAVAILABLE', message: 'GitHub returned an invalid commit pull request association' } };
      }
      const record = item as { number?: unknown; base?: { repo?: { full_name?: unknown } } };
      if (!Number.isSafeInteger(record.number) || Number(record.number) <= 0 || record.base?.repo?.full_name !== repository) {
        return { ok: false as const, error: { code: 'PR_MERGE_EVIDENCE_SOURCE_UNAVAILABLE', message: 'GitHub returned an inconsistent commit pull request identity' } };
      }
      pullRequestNumbers.push(Number(record.number));
    }
  }
  return { ok: true as const, value: { repository, pullRequestNumbers } };
}

function failure(error: PlatformError | ProviderError): ProviderResult<PlatformContextSnapshot> {
  return { ok: false, error: providerError(error) };
}

function contextSnapshot(upstream: string, currentUser: string | null, values: Record<string, boolean>, ownerType?: string): ProviderResult<PlatformContextSnapshot> {
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
      authenticated: capabilities.authenticated,
      ...(ownerType ? { metadata: { ownerType } } : {})
    }
  };
}

function resolveGitHubRemote(remoteInput: string | null | undefined, cwd: string): ProviderResult<string> {
  const remote = remoteInput || defaultGitRemote(cwd);
  if (!remote) {
    return { ok: false, error: providerError({ code: 'REMOTE_MISSING', message: 'Git origin remote is not configured' }) };
  }
  const ownerRepo = parseGitHubRemote(remote);
  if (!ownerRepo) {
    return { ok: false, error: providerError({
      code: /github\.com/i.test(remote) ? 'REMOTE_INVALID' : 'PLATFORM_UNSUPPORTED',
      message: 'Unable to parse GitHub owner/repo from configured remote',
    }) };
  }
  return { ok: true, value: ownerRepo };
}

function contextRepository(value: unknown): ProviderResult<{ upstream: string; repositoryValue: { owner?: { type?: string } } | null }> {
  const repositoryValue = value as { fork?: boolean; full_name?: string; owner?: { type?: string }; parent?: { full_name?: string } } | null;
  const upstream = repositoryValue?.fork ? repositoryValue.parent?.full_name : repositoryValue?.full_name;
  if (!upstream) return { ok: false, error: providerError({
    code: 'UPSTREAM_UNRESOLVED',
    message: 'Unable to resolve the upstream repository',
  }) };
  return { ok: true, value: { upstream, repositoryValue } };
}

function contextCurrentUser(value: unknown): string | null {
  const userValue = value as { data?: { viewer?: { login?: string } } } | null;
  return userValue?.data?.viewer?.login || null;
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
    });
  }
  const remote = resolveGitHubRemote(input.gitRemote, cwd);
  if (!remote.ok) return { ok: false, error: remote.error };
  const ownerRepo = remote.value;
  const repository = client.json(['api', 'repos/' + ownerRepo], { cwd });
  if (!repository.ok) return failure(repository.error);
  const resolvedRepository = contextRepository(repository.value);
  if (!resolvedRepository.ok) return { ok: false, error: resolvedRepository.error };
  const { upstream, repositoryValue } = resolvedRepository.value;
  const user = client.json(['api', 'graphql', '-f', 'query=' + CURRENT_USER_QUERY], { cwd });
  if (!user.ok) return failure(user.error);
  const currentUser = contextCurrentUser(user.value);
  const permissions = client.json(['api', 'repos/' + upstream], { cwd });
  if (!permissions.ok) return failure(permissions.error);
  const permissionValue = permissions.value as { permissions?: Record<string, boolean> } | null;
  const values = permissionValue?.permissions || {};
  return contextSnapshot(upstream, currentUser, values, repositoryValue?.owner?.type);
}

function repository(context: ProviderOperationContext): string {
  return context.scopeId;
}

function expectedHeadRepository(repositoryName: string, head: string): { repository: string; ref: string } {
  const colon = head.indexOf(':');
  if (colon === -1) return { repository: repositoryName, ref: head };
  const repoName = repositoryName.split('/')[1] || '';
  return { repository: `${head.slice(0, colon)}/${repoName}`, ref: head.slice(colon + 1) };
}

function repositoryHead(cwd: string): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
  }).trim();
}

function verifyRemoteBranch(cwd: string, repositoryName: string, head: string):
  | { ok: true; value: string }
  | { ok: false; error: ProviderError } {
  const wanted = expectedHeadRepository(repositoryName, head);
  if (!wanted.ref || !/^[A-Za-z0-9._/-]+$/.test(wanted.ref)) return {
    ok: false,
    error: { code: 'PR_HEAD_INVALID', message: 'Pull request head ref is invalid' }
  };
  const remotes = configuredGitRemotes(cwd);
  const remote = remotes.find((item) => item.repository.toLowerCase() === wanted.repository.toLowerCase())
    ?? remotes.find((item) => item.name === 'origin');
  if (!remote) return {
    ok: false,
    error: { code: 'PR_REMOTE_BRANCH_MISSING', message: `No configured remote can verify ${wanted.repository}:${wanted.ref}` }
  };
  try {
    const output = execFileSync('git', ['ls-remote', '--refs', remote.name, `refs/heads/${wanted.ref}`], {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
    }).trim();
    const match = output.split(/\r?\n/).map((line) => line.trim()).find((line) => line.endsWith(`refs/heads/${wanted.ref}`));
    const sha = match?.split(/\s+/)[0] || null;
    if (!sha || !/^[a-f0-9]{40}$/i.test(sha)) return {
      ok: false,
      error: { code: 'PR_REMOTE_BRANCH_MISSING', message: `Remote branch ${wanted.repository}:${wanted.ref} does not exist` }
    };
    return { ok: true, value: sha };
  } catch (error) {
    return {
      ok: false,
      error: { code: 'PR_REMOTE_BRANCH_UNAVAILABLE', message: error instanceof Error ? error.message : String(error) }
    };
  }
}

function invalid(code: string, message: string): ProviderResult<never> {
  return { ok: false, error: { code, message } };
}

function changeRequestSnapshot(value: any): ChangeRequestSnapshot {
  return {
    id: value.nodeId,
    identity: { kind: 'number', value: value.number },
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

function issueSnapshot(value: any, graph?: { type: any; values: Array<{ name: string; value: string | number | null }> }): IssueSnapshot {
  const issueType = graph?.type ? {
    identity: { kind: 'id' as const, value: String(graph.type.id) },
    name: String(graph.type.name),
    fields: (graph.type.fields || []).map((field: any) => ({
      identity: { kind: 'id' as const, value: String(field.id) },
      name: String(field.name),
      kind: field.kind,
      options: (field.options || []).map((option: any) => ({ identity: { kind: 'id' as const, value: String(option.id) }, name: String(option.name) }))
    }))
  } : value.issueType ? {
    identity: { kind: 'key' as const, value: String(value.issueType) },
    name: String(value.issueType),
    fields: []
  } : null;
  return {
    id: value.nodeId,
    identity: { kind: 'number', value: value.number },
    number: value.number,
    state: value.state,
    title: value.title,
    body: value.body,
    labels: value.labels,
    assignees: value.assignees,
    milestone: value.milestone,
    fields: graph ? Object.fromEntries(graph.values.map((field) => [field.name, field.value])) : value.fields,
    issueType,
    displayUrl: value.url
  };
}

function commentSnapshot(value: any, createdSequence: number | null = null): RemoteCommentSnapshot {
  return {
    id: String(value.id),
    author: value.user?.login ? { id: String(value.user.login), name: String(value.user.login) } : null,
    body: String(value.body || ''),
    createdAt: String(value.created_at || ''),
    updatedAt: String(value.updated_at || value.created_at || '')
    ,createdSequence
  };
}

function createReceipt(remoteId: string): ProviderResult<MutationReceipt> {
  return { ok: true, value: { changed: true, remoteId } };
}

function partialFailure<T>(response: { ok: false; error: PlatformError | ProviderError }, value: T): ProviderResult<T> {
  return { ok: false, error: providerError(response.error), value };
}

function labelReconciliation(
  created: string[],
  updated: string[],
  removed: string[],
  skipped: string[]
): LabelReconciliation {
  return {
    changed: created.length > 0 || updated.length > 0 || removed.length > 0,
    created,
    updated,
    removed,
    skipped
  };
}

function milestoneInitialization(created: string[], skipped: string[]): MilestoneInitialization {
  return { changed: created.length > 0, created, skipped };
}

function githubResourceToken(identity: ResourceIdentity | null | undefined): string | null {
  return resourceIdentityString(identity) || (identity?.kind === 'number' ? String(identity.value) : null);
}

function syncLabels(
  client: GitHubClient,
  repositoryName: string,
  number: number,
  cwd: string,
  current: readonly string[],
  target: readonly string[],
  prefixes: readonly string[]
) {
  let changed = false;
  for (const prefix of prefixes) {
    const synced = syncLabelDelta(client, repositoryName, number, cwd, current, target, prefix);
    if (synced.status === 'failed' || synced.status === 'blocked') {
      if (changed || synced.changed) return {
        status: 'blocked' as const,
        changed: true,
        error: synced.error
          ? { ...providerError(synced.error), code: 'IN_LABEL_SYNC_PARTIAL', message: `In-label synchronization is partial or unknown: ${synced.error.message}` }
          : { code: 'IN_LABEL_SYNC_PARTIAL', message: 'In-label synchronization is partial or unknown' }
      };
      return synced;
    }
    changed ||= synced.changed;
  }
  return { status: changed ? 'applied' as const : 'no-op' as const, changed, error: null };
}

function syncGitHubUpdateLabels(
  client: GitHubClient,
  repositoryName: string,
  number: number,
  cwd: string,
  resource: 'issues' | 'pulls',
  currentLabels: readonly string[] | undefined,
  labels: readonly string[],
  prefixes: readonly string[]
): ProviderResult<{ changed: boolean }> {
  let before = currentLabels;
  if (!before) {
    const current = client.json<any>(['api', `repos/${repositoryName}/${resource}/${number}`], { cwd });
    if (!current.ok) return current;
    before = Array.isArray(current.value?.labels)
      ? current.value.labels.map((label: any) => typeof label === 'string' ? label : label?.name).filter((label: any): label is string => typeof label === 'string')
      : [];
  }
  const synced = syncLabels(client, repositoryName, number, cwd, before || [], labels, prefixes);
  if (synced.status === 'failed' || synced.status === 'blocked') return synced.error
    ? { ok: false, error: synced.error }
    : invalid('IN_LABEL_SYNC_FAILED', `${resource === 'issues' ? 'Issue' : 'Pull request'} label synchronization failed`);
  return { ok: true, value: { changed: synced.changed } };
}

function resolveOpenMilestoneNumber(client: GitHubClient, repositoryName: string, cwd: string, title: string) {
  const response = client.json<any>(['api', '--paginate', '--slurp', `repos/${repositoryName}/milestones?state=open&per_page=100`], { cwd });
  if (!response.ok) return response;
  const values = Array.isArray(response.value) ? response.value.flatMap((entry: any) => Array.isArray(entry) ? entry : [entry]) : [];
  const selected = values.find((item: any) => item?.title === title);
  if (!Number.isSafeInteger(selected?.number) || selected.number <= 0) {
    return invalid('MILESTONE_IDENTITY_INVALID', 'Milestone title does not resolve to a positive number');
  }
  return { ok: true as const, value: selected.number };
}

function updateGitHubIssueTypeAndFields(
  client: GitHubClient,
  repositoryName: string,
  cwd: string,
  number: number,
  issueType: string | null | undefined,
  fields: Record<string, unknown> | undefined
): ProviderResult<{ changed: boolean }> {
  const [owner, name] = repositoryName.split('/');
  const current = client.json<any>(['api', 'graphql', '-f', `query=${ISSUE_FIELDS_QUERY}`, '-F', `owner=${owner}`, '-F', `name=${name}`, '-F', `number=${number}`], { cwd });
  if (!current.ok) return current;
  const currentIssue = current.value?.data?.repository?.issue;
  const issueId = currentIssue?.id;
  if (!issueId) return invalid('ISSUE_GRAPH_IDENTITY_INVALID', 'Issue GraphQL response lacks issue identity');
  const typeUpdate = updateGitHubIssueType(client, cwd, owner || '', issueId, currentIssue.issueType, issueType);
  if (!typeUpdate.ok) return typeUpdate;
  const fieldsUpdate = updateGitHubIssueFields(client, cwd, issueId, typeUpdate.value.issueType, fields);
  if (!fieldsUpdate.ok) return fieldsUpdate;
  return { ok: true, value: { changed: typeUpdate.value.changed || fieldsUpdate.value.changed } };
}

function updateGitHubIssueType(client: GitHubClient, cwd: string, owner: string, issueId: string, currentType: any, issueType: string | null | undefined): ProviderResult<{ issueType: any; changed: boolean }> {
  if (issueType === undefined) return { ok: true, value: { issueType: currentType, changed: false } };
  const types = client.json<any>(['api', 'graphql', '-f', `query=${ISSUE_TYPES_QUERY}`, '-F', `owner=${owner || ''}`], { cwd });
  if (!types.ok) return types;
  const targetType = (types.value?.data?.organization?.issueTypes?.nodes || []).find((item: any) => item?.name === issueType);
  if (!targetType) return invalid('ISSUE_TYPE_NOT_FOUND', 'Issue type was not found');
  if (targetType.id === currentType?.id) return { ok: true, value: { issueType: targetType, changed: false } };
  const updated = client.json(['api', 'graphql', '--input', '-'], {
    cwd, method: 'POST', input: JSON.stringify({
      query: 'mutation($issueId:ID!,$issueTypeId:ID){updateIssueIssueType(input:{issueId:$issueId,issueTypeId:$issueTypeId}){issue{id}}}',
      variables: { issueId, issueTypeId: targetType.id }
    })
  });
  return updated.ok ? { ok: true, value: { issueType: targetType, changed: true } } : updated;
}

function githubIssueFieldInput(field: any, value: unknown): Record<string, unknown> | null {
  if (field.__typename === 'IssueFieldSingleSelect') {
    const option = (field.options || []).find((candidate: any) => candidate?.name === value);
    return option?.id ? { fieldId: field.id, singleSelectOptionId: option.id } : null;
  }
  const key = field.__typename === 'IssueFieldDate' ? 'dateValue' : field.__typename === 'IssueFieldNumber' ? 'numberValue' : 'textValue';
  return { fieldId: field.id, [key]: value };
}

function updateGitHubIssueFields(client: GitHubClient, cwd: string, issueId: string, issueType: any, fields: Record<string, unknown> | undefined): ProviderResult<{ changed: boolean }> {
  if (fields === undefined) return { ok: true, value: { changed: false } };
  const values = Object.entries(fields).flatMap(([name, value]) => {
    const field = (issueType?.pinnedFields || []).find((candidate: any) => candidate?.name === name);
    return field?.id ? [githubIssueFieldInput(field, value)].filter((item): item is Record<string, unknown> => item !== null) : [];
  });
  if (values.length === 0) return { ok: true, value: { changed: false } };
  const updated = client.json(['api', 'graphql', '--input', '-'], {
    cwd, method: 'POST', input: JSON.stringify({
      query: 'mutation($issueId:ID!,$issueFields:[IssueFieldCreateOrUpdateInput!]!){setIssueFieldValue(input:{issueId:$issueId,issueFields:$issueFields}){issue{id}}}',
      variables: { issueId, issueFields: values }
    })
  });
  return updated.ok ? { ok: true, value: { changed: true } } : updated;
}

function parseClosingIssuePage(value: unknown): ProviderResult<{ identities: ResourceIdentity[]; hasNextPage: boolean; endCursor: string | null }> {
  const connection = (value as {
    data?: { repository?: { pullRequest?: { closingIssuesReferences?: {
      nodes?: unknown[]; pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
    } } } };
  })?.data?.repository?.pullRequest?.closingIssuesReferences;
  if (!connection || !Array.isArray(connection.nodes) || !connection.pageInfo) return invalid('IN_LABEL_SYNC_ASSOCIATION_INVALID', 'Closing Issue response is incomplete');
  const identities: ResourceIdentity[] = [];
  for (const node of connection.nodes) {
    const issue = Number((node as { number?: unknown })?.number);
    if (!Number.isSafeInteger(issue) || issue <= 0) return invalid('IN_LABEL_SYNC_ASSOCIATION_INVALID', 'Closing Issue identity is invalid');
    identities.push({ kind: 'number', value: issue });
  }
  return { ok: true, value: { identities, hasNextPage: Boolean(connection.pageInfo.hasNextPage), endCursor: connection.pageInfo.endCursor || null } };
}

function uniqueResourceIdentities(identities: ResourceIdentity[]): ResourceIdentity[] {
  const seen = new Set<string>();
  return identities.filter((identity) => {
    const key = `${identity.kind}:${identity.value}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function fetchClosingIssues(client: GitHubClient, repositoryName: string, cwd: string, number: number): ProviderResult<ResourceIdentity[]> {
  const [owner, name] = repositoryName.split('/');
  if (!owner || !name) return invalid('IN_LABEL_SYNC_REPOSITORY_INVALID', 'Repository identity is invalid');
  const identities: ResourceIdentity[] = [];
  let cursor: string | null = null;
  for (;;) {
    const args = ['api', 'graphql', '-f', `query=${CLOSING_ISSUES_QUERY}`, '-F', `owner=${owner}`, '-F', `name=${name}`, '-F', `number=${number}`];
    if (cursor) args.push('-F', `cursor=${cursor}`);
    const response = client.json<unknown>(args, { cwd });
    if (!response.ok) return response;
    const page = parseClosingIssuePage(response.value);
    if (!page.ok) return { ok: false, error: page.error };
    identities.push(...page.value.identities);
    if (!page.value.hasNextPage) return { ok: true, value: uniqueResourceIdentities(identities) };
    if (!page.value.endCursor || page.value.endCursor === cursor) {
      return invalid('IN_LABEL_SYNC_ASSOCIATION_INVALID', 'Closing Issue pagination cursor is invalid');
    }
    cursor = page.value.endCursor;
  }
}

function updateDesiredGitHubLabel(client: GitHubClient, repositoryName: string, cwd: string, label: LabelDefinition, existing: any): ProviderResult<boolean> {
  if (!existing) {
    const created = client.json(['api', `repos/${repositoryName}/labels`, '-X', 'POST', '--input', '-'], {
      cwd, method: 'POST', input: JSON.stringify({ name: label.name, color: label.color, description: label.description })
    });
    return created.ok ? { ok: true, value: true } : created;
  }
  const matches = typeof existing.color === 'string' && existing.color.toUpperCase() === label.color.toUpperCase()
    && String(existing.description || '') === label.description;
  if (matches) return { ok: true, value: false };
  const updated = client.json(['api', `repos/${repositoryName}/labels/${encodeURIComponent(label.name)}`, '-X', 'PATCH', '--input', '-'], {
    cwd, method: 'PATCH', input: JSON.stringify({ new_name: label.name, color: label.color, description: label.description })
  });
  return updated.ok ? { ok: true, value: true } : updated;
}

function removeStaleGitHubInLabels(client: GitHubClient, repositoryName: string, cwd: string, current: Map<string, any>, desiredNames: Set<string>): ProviderResult<string[]> {
  const removed: string[] = [];
  for (const name of current.keys()) {
    if (!name.startsWith('in:') || desiredNames.has(name)) continue;
    const response = client.text(['api', `repos/${repositoryName}/labels/${encodeURIComponent(name)}`, '-X', 'DELETE'], { cwd, method: 'DELETE' });
    if (!response.ok) return partialFailure(response, removed);
    removed.push(name);
  }
  return { ok: true, value: removed };
}

function reconcileGitHubLabels(
  client: GitHubClient,
  repositoryName: string,
  cwd: string,
  desired: LabelDefinition[],
  cleanupStaleIn: boolean
): ProviderResult<LabelReconciliation> {
  const listed = client.json<any>(['api', '--paginate', '--slurp', `repos/${repositoryName}/labels?per_page=100`], { cwd });
  if (!listed.ok) return listed;
  if (!Array.isArray(listed.value)) return invalid('LABEL_RESPONSE_INVALID', 'The platform returned an invalid label list');
  const values = listed.value.flatMap((entry: any) => Array.isArray(entry) ? entry : [entry]);
  if (values.some((entry: any) => !entry || typeof entry.name !== 'string' || !entry.name)) {
    return invalid('LABEL_RESPONSE_INVALID', 'The platform returned a label without a valid name');
  }
  const current = new Map<string, any>(values.map((entry: any) => [String(entry.name), entry]));
  const created: string[] = [];
  const updated: string[] = [];
  const skipped: string[] = [];
  const removed: string[] = [];
  for (const label of desired) {
    const result = updateDesiredGitHubLabel(client, repositoryName, cwd, label, current.get(label.name));
    if (!result.ok) return partialFailure(result, labelReconciliation(created, updated, removed, skipped));
    if (!result.value) skipped.push(label.name);
    else if (current.has(label.name)) updated.push(label.name);
    else created.push(label.name);
  }
  const desiredNames = new Set(desired.map((label) => label.name));
  if (cleanupStaleIn) {
    const cleanup = removeStaleGitHubInLabels(client, repositoryName, cwd, current, desiredNames);
    removed.push(...(cleanup.value || []));
    if (!cleanup.ok) return partialFailure(cleanup, labelReconciliation(created, updated, removed, skipped));
  }
  return { ok: true, value: labelReconciliation(created, updated, removed, skipped) };
}

function releaseSnapshot(response: any, runs: any, tag: string): ReleaseSnapshot {
  return {
    id: String(response?.id || tag), tag: String(response?.tagName || tag),
    title: String(response?.name || tag), body: String(response?.body || ''),
    ...releaseSnapshotDetails(response, runs)
  };
}

function releaseSnapshotDetails(response: any, runs: any) {
  return {
    draft: Boolean(response?.isDraft), prerelease: Boolean(response?.isPrerelease),
    publishedAt: response?.publishedAt ? new Date(String(response.publishedAt)).toISOString() : null,
    displayUrl: response?.url ? String(response.url) : undefined,
    workflows: Array.isArray(runs) ? runs as Array<Record<string, import('./provider-contract.ts').JsonValue>> : []
  };
}

function createGitHubOperations(client: GitHubClient): Pick<PlatformProvider, 'issues' | 'comments' | 'changeRequests' | 'checks' | 'reviews' | 'releases' | 'securityAlerts' | 'repositoryMetadata' | 'verification'> {
  const issues: NonNullable<PlatformProvider['issues']> = {
    async listLabels({ context }) {
      const response = client.json<any>(['api', '--paginate', '--slurp', `repos/${repository(context)}/labels?per_page=100`], { cwd: context.workingDirectory });
      if (!response.ok) return response;
      const values = Array.isArray(response.value)
        ? response.value.flatMap((entry: any) => Array.isArray(entry) ? entry : [entry])
        : [];
      if (values.some((entry: any) => !entry || typeof entry.name !== 'string' || !entry.name.trim())) {
        return invalid('IN_LABEL_SYNC_LABELS_INVALID', 'Repository labels response contains an entry without a valid name');
      }
      return { ok: true, value: [...new Set(values.map((entry: any) => String(entry.name)))].sort() };
    },
    async listMilestones({ context }) {
      const response = client.json<any>(['api', '--paginate', '--slurp', `repos/${repository(context)}/milestones?state=open&per_page=100`], { cwd: context.workingDirectory });
      if (!response.ok) return response;
      const values = Array.isArray(response.value)
        ? response.value.flatMap((entry: any) => Array.isArray(entry) ? entry : [entry])
        : [];
      if (values.some((entry: any) => !entry || typeof entry.title !== 'string' || !entry.title.trim())) {
        return invalid('MILESTONE_IDENTITY_INVALID', 'Milestones response contains an entry without a valid title');
      }
      return { ok: true, value: [...new Set(values.map((entry: any) => String(entry.title)))].sort() };
    },
    async describeRepository({ context }): Promise<ProviderResult<RepositoryMetadataSnapshot>> {
      const repositoryName = repository(context);
      const info = client.json<any>(['api', `repos/${repositoryName}`], { cwd: context.workingDirectory });
      if (!info.ok) return info;
      const labels = client.json<any>(['api', '--paginate', '--slurp', `repos/${repositoryName}/labels?per_page=100`], { cwd: context.workingDirectory });
      if (!labels.ok) return labels;
      const milestones = client.json<any>(['api', '--paginate', '--slurp', `repos/${repositoryName}/milestones?state=open&per_page=100`], { cwd: context.workingDirectory });
      if (!milestones.ok) return milestones;
      const [owner] = repositoryName.split('/');
      const issueTypes = client.json<any>(['api', 'graphql', '-f', `query=${ISSUE_TYPES_QUERY}`, '-F', `owner=${owner}`], { cwd: context.workingDirectory });
      if (!issueTypes.ok) return issueTypes;
      const flatten = (value: unknown): any[] => Array.isArray(value) ? value.flatMap((entry) => Array.isArray(entry) ? entry : [entry]) : [];
      const fields = (raw: any): any[] => (raw || []).flatMap((field: any) => {
        const kind = field.__typename === 'IssueFieldSingleSelect' ? 'single-select'
          : field.__typename === 'IssueFieldDate' ? 'date'
            : field.__typename === 'IssueFieldText' ? 'text'
              : field.__typename === 'IssueFieldNumber' ? 'number' : null;
        return field.id && field.name && kind ? [{
          identity: { kind: 'id', value: String(field.id) }, name: String(field.name), kind,
          options: (field.options || []).filter((option: any) => option?.id && option?.name).map((option: any) => ({ identity: { kind: 'id', value: String(option.id) }, name: String(option.name) }))
        }] : [];
      });
      const typeNodes = issueTypes.value?.data?.organization?.issueTypes?.nodes || [];
      return {
        ok: true,
        value: {
          repository: {
            identity: { kind: 'key', value: repositoryName },
            name: String(info.value?.full_name || repositoryName),
            url: info.value?.html_url ? String(info.value.html_url) : null
          },
          labels: flatten(labels.value).filter((item) => item?.name).map((item) => ({ identity: { kind: 'key', value: String(item.name) }, name: String(item.name) })),
          milestones: flatten(milestones.value).filter((item) => item?.title).map((item) => ({ identity: { kind: 'key', value: String(item.title) }, title: String(item.title), state: item.state === 'closed' ? 'closed' : 'open' })),
          issueTypes: typeNodes.filter((item: any) => item?.id && item?.name).map((item: any) => ({ identity: { kind: 'id', value: String(item.id) }, name: String(item.name), fields: fields(item.pinnedFields) })),
          fields: []
        }
      };
    },
    async inspect({ context, target }) {
      const number = resourceIdentityNumber(target);
      if (!number) return invalid('ISSUE_NUMBER_INVALID', 'Issue number must be positive');
      const fetched = inspectGitHubIssue(client, repository(context), number, context.workingDirectory);
      if (!fetched.ok) return fetched;
      const graph = graphState(client, repository(context), number, context.workingDirectory);
      return { ok: true, value: issueSnapshot(fetched.value, graph || undefined) };
    },
    async create({ context, desired }) {
      let milestone: number | null = null;
      if (desired.milestone) {
        const milestones = client.json<any>(['api', '--paginate', '--slurp', `repos/${repository(context)}/milestones?state=open&per_page=100`], { cwd: context.workingDirectory });
        if (!milestones.ok) return milestones;
        const values = Array.isArray(milestones.value)
          ? milestones.value.flatMap((entry: any) => Array.isArray(entry) ? entry : [entry])
          : [];
        const selected = values.find((item: any) => item?.title === desired.milestone);
        if (!Number.isSafeInteger(selected?.number) || selected.number <= 0) {
          return invalid('MILESTONE_IDENTITY_INVALID', 'Milestone title does not resolve to a positive number');
        }
        milestone = selected.number;
      }
      const response = client.json<any>(['api', `repos/${repository(context)}/issues`, '-X', 'POST', '--input', '-'], {
        cwd: context.workingDirectory,
        method: 'POST',
        input: JSON.stringify({
          title: desired.title,
          body: desired.body,
          labels: desired.labels,
          assignees: desired.assignees,
          ...(milestone ? { milestone } : {})
        })
      });
      if (!response.ok) return response;
      const number = Number(response.value?.number);
      if (!Number.isInteger(number) || number <= 0) return invalid('ISSUE_CREATE_RESPONSE_INVALID', 'Issue create response lacks issue number');
      return createReceipt(String(number));
    },
    async update({ context, target, currentLabels, patch }) {
      const number = resourceIdentityNumber(target);
      if (!number) return invalid('ISSUE_NUMBER_INVALID', 'Issue number must be positive');
      const { issueType, fields, labels, ...restPatch } = patch;
      let requestPatch = restPatch;
      let changed = false;
      if (labels !== undefined) {
        const synced = syncGitHubUpdateLabels(client, repository(context), number, context.workingDirectory, 'issues', currentLabels, labels, ['status:', 'in:']);
        if (!synced.ok) return synced;
        changed ||= synced.value.changed;
      }
      if (typeof patch.milestone === 'string') {
        const milestone = resolveOpenMilestoneNumber(client, repository(context), context.workingDirectory, patch.milestone);
        if (!milestone.ok) return milestone;
        requestPatch = { ...restPatch, milestone: milestone.value } as typeof restPatch;
      }
      if (issueType !== undefined || fields !== undefined) {
        const graphUpdate = updateGitHubIssueTypeAndFields(client, repository(context), context.workingDirectory, number, issueType, fields);
        if (!graphUpdate.ok) return graphUpdate;
        changed ||= graphUpdate.value.changed;
      }
      if (Object.keys(requestPatch).length > 0) {
        const response = client.json<any>(['api', `repos/${repository(context)}/issues/${number}`, '-X', 'PATCH', '--input', '-'], {
          cwd: context.workingDirectory,
          method: 'PATCH',
          input: JSON.stringify(requestPatch)
        });
        if (!response.ok) return response;
        changed = true;
      }
      return { ok: true, value: { changed, remoteId: String(number) } };
    }
  };

  const comments: NonNullable<PlatformProvider['comments']> = {
    async list({ context, parent }) {
      const number = resourceIdentityNumber(parent);
      if (!number) return invalid('ISSUE_NUMBER_INVALID', 'Issue number must be positive');
      const response = client.json<any>(['api', '--paginate', '--slurp', `repos/${repository(context)}/issues/${number}/comments?per_page=100`], { cwd: context.workingDirectory });
      if (!response.ok) return response;
      const values = Array.isArray(response.value) ? response.value.flatMap((entry: any) => Array.isArray(entry) ? entry : [entry]) : [];
      const comments = values.filter((entry: any) => entry && typeof entry === 'object');
      let previous = 0;
      const ordered = comments.length === values.length && comments.every((entry: any) => {
        const id = Number(entry.id);
        if (!Number.isSafeInteger(id) || id <= previous) return false;
        previous = id;
        return true;
      });
      return { ok: true, value: comments.map((comment: any) => commentSnapshot(comment, ordered ? Number(comment.id) : null)) };
    },
    async write({ context, parent, body, existingComment }) {
      const number = resourceIdentityNumber(parent);
      if (!number) return invalid('ISSUE_NUMBER_INVALID', 'Issue number must be positive');
      const commentId = githubResourceToken(existingComment);
      const endpoint = commentId ? `repos/${repository(context)}/issues/comments/${commentId}` : `repos/${repository(context)}/issues/${number}/comments`;
      const response = client.json<any>(['api', endpoint, '-X', commentId ? 'PATCH' : 'POST', '--input', '-'], {
        cwd: context.workingDirectory,
        method: commentId ? 'PATCH' : 'POST',
        input: JSON.stringify({ body })
      });
      if (!response.ok) return response;
      return createReceipt(String(response.value?.id || commentId || ''));
    },
    async delete({ context, comment }) {
      const commentId = githubResourceToken(comment);
      if (!commentId) return invalid('COMMENT_ID_INVALID', 'Comment id is required');
      const response = client.text(['api', `repos/${repository(context)}/issues/comments/${commentId}`, '-X', 'DELETE'], { cwd: context.workingDirectory, method: 'DELETE' });
      if (!response.ok) return response;
      return createReceipt(commentId);
    }
  };

  const changeRequests: NonNullable<PlatformProvider['changeRequests']> = {
    async verifyHead({ context, head }) {
      let localHead: string;
      try {
        localHead = repositoryHead(context.workingDirectory);
      } catch (error) {
        return { ok: false, error: { code: 'PR_LOCAL_HEAD_UNAVAILABLE', message: error instanceof Error ? error.message : String(error) } };
      }
      const remote = verifyRemoteBranch(context.workingDirectory, repository(context), head);
      if (!remote.ok) return remote;
      if (remote.value !== localHead) return {
        ok: false,
        error: { code: 'PR_REMOTE_HEAD_MISMATCH', message: `Remote head ${remote.value} does not match local HEAD ${localHead}` }
      };
      return { ok: true, value: { sha: localHead } };
    },
    async inspect({ context, target }) {
      const number = resourceIdentityNumber(target);
      if (!number) return invalid('PR_NUMBER_INVALID', 'Pull request number must be positive');
      const fetched = inspectGitHubPullRequest(client, repository(context), number, context.workingDirectory);
      if (!fetched.ok) return fetched;
      return { ok: true, value: changeRequestSnapshot(fetched.value) };
    },
    async listFiles({ context, target }) {
      const number = resourceIdentityNumber(target);
      if (!number) return invalid('PR_NUMBER_INVALID', 'Pull request number must be positive');
      const response = client.json<unknown>(['api', '--paginate', '--slurp', `repos/${repository(context)}/pulls/${number}/files?per_page=100`], { cwd: context.workingDirectory });
      if (!response.ok) return response;
      const files = extractPullRequestFileNames(response.value);
      return files
        ? { ok: true, value: files }
        : invalid('IN_LABEL_SYNC_FILES_INVALID', 'Pull request files response is incomplete');
    },
    async listClosingIssues({ context, target }) {
      const number = resourceIdentityNumber(target);
      if (!number) return invalid('PR_NUMBER_INVALID', 'Pull request number must be positive');
      return fetchClosingIssues(client, repository(context), context.workingDirectory, number);
    },
    async listClosing({ context, issue }) {
      const number = resourceIdentityNumber(issue);
      if (!number) return invalid('ISSUE_NUMBER_INVALID', 'Issue number must be positive');
      const fetched = inspectGitHubIssueClosingChangeRequests(client, repository(context), number, context.workingDirectory);
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
      return createReceipt(String(number));
    },
    async update({ context, target, currentLabels, patch }) {
      const number = resourceIdentityNumber(target);
      if (!number) return invalid('PR_NUMBER_INVALID', 'Pull request number must be positive');
      const { labels, assignees, milestone, ...pullRequestPatch } = patch;
      let changed = false;
      if (labels !== undefined) {
        const synced = syncGitHubUpdateLabels(client, repository(context), number, context.workingDirectory, 'pulls', currentLabels, labels, ['in:', 'type:']);
        if (!synced.ok) return synced;
        changed ||= synced.value.changed;
      }
      if (Object.keys(pullRequestPatch).length > 0) {
        const response = client.json<any>(['api', `repos/${repository(context)}/pulls/${number}`, '-X', 'PATCH', '--input', '-'], {
          cwd: context.workingDirectory,
          method: 'PATCH',
          input: JSON.stringify(pullRequestPatch)
        });
        if (!response.ok) return response;
        changed = true;
      }
      const issuePatch: Record<string, unknown> = {};
      if (assignees !== undefined) issuePatch.assignees = assignees;
      if (milestone !== undefined) {
        if (milestone === null) issuePatch.milestone = null;
        else {
          const resolved = resolveOpenMilestoneNumber(client, repository(context), context.workingDirectory, milestone);
          if (!resolved.ok) return resolved;
          issuePatch.milestone = resolved.value;
        }
      }
      if (Object.keys(issuePatch).length > 0) {
        const response = client.json<any>(['api', `repos/${repository(context)}/issues/${number}`, '-X', 'PATCH', '--input', '-'], {
          cwd: context.workingDirectory,
          method: 'PATCH',
          input: JSON.stringify(issuePatch)
        });
        if (!response.ok) return response;
        changed = true;
      }
      return { ok: true, value: { changed, remoteId: String(number) } };
    },
    async resolveGitEvidence({ context, target, expected }) {
      const number = resourceIdentityNumber(target);
      if (!number) return invalid('PR_NUMBER_INVALID', 'Pull request number must be positive');
      return resolveGitHubChangeRequestGitEvidence({
        client,
        cwd: context.workingDirectory,
        repository: repository(context),
        number,
        baseRepository: expected.baseRepository || repository(context),
        baseRef: expected.targetBranch || 'main'
      });
    },
    async listCommitPullRequestAssociations({ context, commitSha }) {
      if (!/^[0-9a-f]{40}$/i.test(commitSha)) return invalid('PR_MERGE_EVIDENCE_SOURCE_UNAVAILABLE', 'Commit identity is invalid');
      return listGitHubCommitPullRequestAssociations(client, repository(context), commitSha, context.workingDirectory);
    }
  };

  const checks: NonNullable<PlatformProvider['checks']> = {
    async inspectRequired({ context, changeRequest }) {
      const number = resourceIdentityNumber(changeRequest);
      if (!number) return invalid('PR_NUMBER_INVALID', 'Pull request number must be positive');
      return inspectGitHubRequiredChecks(client, repository(context), number, context.workingDirectory);
    },
    async resolveRun({ context, changeRequest, checkName, detailsUrl }) {
      const number = resourceIdentityNumber(changeRequest);
      if (!number) return invalid('PR_NUMBER_INVALID', 'Pull request number must be positive');
      const direct = detailsUrl ? parseRunJobIdentity(detailsUrl) : null;
      if (direct) {
        const run = client.json<any>(['api', `repos/${repository(context)}/actions/runs/${direct.runId}`], { cwd: context.workingDirectory });
        if (!run.ok) return run;
        return { ok: true, value: { runId: String(direct.runId), jobId: direct.jobId ? String(direct.jobId) : undefined } } as ProviderResult<CheckRunSnapshot>;
      }
      const listed = client.json<any>(['api', `repos/${repository(context)}/commits/${number}/check-runs`], { cwd: context.workingDirectory });
      if (!listed.ok) return listed;
      const candidate = (listed.value?.check_runs || []).find((run: any) => run.name === checkName && run.id);
      return candidate
        ? { ok: true, value: { runId: String(candidate.id), jobId: candidate.job_id ? String(candidate.job_id) : undefined, name: checkName, status: String(candidate.status || ''), conclusion: candidate.conclusion, detailsUrl: candidate.details_url } }
        : invalid('CHECK_RUN_NOT_FOUND', 'Check run was not found');
    },
    async fetchLogs({ context, runId, jobId }) {
      const args = jobId
        ? ['api', `repos/${repository(context)}/actions/jobs/${jobId}/logs`]
        : ['run', 'view', runId, '--repo', repository(context), '--log-failed'];
      const fetched = fetchCheckLogText(client, args, context.workingDirectory);
      if (!fetched.ok) return fetched;
      return { ok: true, value: { runId, jobId, text: fetched.value || '' } } as ProviderResult<CheckLogSnapshot>;
    }
  };

  const reviews: NonNullable<PlatformProvider['reviews']> = {
    async list({ context, changeRequest }) {
      const number = resourceIdentityNumber(changeRequest);
      if (!number) return invalid('PR_NUMBER_INVALID', 'Pull request number must be positive');
      const response = client.json<any[]>(['api', '--paginate', '--slurp', `repos/${repository(context)}/pulls/${number}/reviews?per_page=100`], { cwd: context.workingDirectory });
      if (!response.ok) return response;
      const values = Array.isArray(response.value) ? response.value.flatMap((entry: any) => Array.isArray(entry) ? entry : [entry]) : [];
      return { ok: true, value: values.filter((review: any) => review?.body).map((review: any): ReviewSnapshot => ({ id: String(review.id || review.node_id || ''), author: review.user?.login ? { id: String(review.user.login), name: String(review.user.login) } : null, commitSha: String(review.commit_id || ''), body: String(review.body), state: String(review.state || ''), submittedAt: String(review.submitted_at || ''), displayUrl: review.html_url })) };
    },
    async publish({ context, changeRequest, identity, event, body }) {
      const number = resourceIdentityNumber(changeRequest);
      if (!number) return invalid('PR_NUMBER_INVALID', 'Pull request number must be positive');
      const response = client.json<any>(['api', `repos/${repository(context)}/pulls/${number}/reviews`, '-X', 'POST', '--input', '-'], {
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
      const runs = client.json<any[]>(['run', 'list', '--repo', repository(context), '--limit', '100', '--json', 'name,workflowName,displayTitle,event,headBranch,headSha,status,conclusion,createdAt,databaseId,attempt,url'], { cwd: context.workingDirectory });
      if (!runs.ok) return runs;
      const value = releaseSnapshot(response.value, runs.value, tag);
      return { ok: true, value };
    },
    async create({ context, tag, title, notes }) {
      const args = ['release', 'create', tag, '--repo', repository(context), '--title', title];
      if (notes) args.push('--notes', notes.text);
      const response = client.text(args, { cwd: context.workingDirectory, method: 'POST' });
      if (!response.ok) return response;
      return createReceipt(tag);
    },
    async update({ context, release, patch }) {
      const tag = resourceIdentityString(release) || '';
      const args = ['release', 'edit', tag, '--repo', repository(context)];
      if (patch.title) args.push('--title', patch.title);
      if (patch.body) args.push('--notes', patch.body);
      const response = client.text(args, { cwd: context.workingDirectory, method: 'PATCH' });
      if (!response.ok) return response;
      return createReceipt(tag);
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
        const response = client.json([
          'api', '--method', 'POST', `repos/${repository(context)}/milestones`,
          '-f', `title=${item.title}`,
          '-f', `description=${item.description}`,
          '-f', `state=${item.state}`
        ], { cwd: context.workingDirectory });
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
        const tag = resourceIdentityString(release) || '';
        const result = module.publishGitHubReleaseNotes({ repository: repository(context), tag, title, notesFile }, { cwd: context.workingDirectory, client });
        if (result.status === 'failed' || result.status === 'blocked') return { ok: false, error: result.error ? providerError(result.error) : { code: 'RELEASE_NOTES_PUBLISH_FAILED', message: 'Release notes publish failed' } };
        return { ok: true, value: { changed: result.changed, remoteId: tag } };
      } finally {
        fs.rmSync(temporaryRoot, { recursive: true, force: true });
      }
    },
    async collectNotes({ context, fromTime, toTime, commitOids, branch, historyLimit }): Promise<ProviderResult<ReleaseNotesFacts>> {
      const module = await import('./github-release-notes.ts');
      const collected = module.fetchGitHubReleaseNoteData({
        repository: repository(context), commitOids, branch, historyLimit, fromTime, toTime
      }, { cwd: context.workingDirectory, client });
      if (collected.status === 'failed' || collected.status === 'blocked' || !('pullRequests' in collected)) {
        return { ok: false, error: collected.error ? providerError(collected.error) : { code: 'RELEASE_NOTES_COLLECTION_FAILED', message: 'Release notes could not be collected' } };
      }
      const mergedPullRequests = collected.pullRequests.map((item: any) => ({
        id: String(item.number), identity: { kind: 'number' as const, value: Number(item.number) }, number: Number(item.number),
        title: String(item.title || ''), body: String(item.body || ''),
        mergedAt: new Date(String(item.mergedAt)).toISOString(), displayUrl: String(item.url || ''),
        labels: Array.isArray(item.labels) ? item.labels.map((label: any) => String(label.name || label)) : [],
        author: item.author,
        closingIssues: item.closingIssues.map((issue: any) => ({
          id: String(issue.number), identity: { kind: 'number', value: Number(issue.number) }, number: Number(issue.number),
          title: String(issue.title || ''), displayUrl: String(issue.url || ''), author: issue.author
        }))
      }));
      return {
        ok: true,
        value: {
          history: collected.history,
          commits: collected.commits,
          mergedPullRequests,
        }
      };
    }
  };

  const securityAlerts: NonNullable<PlatformProvider['securityAlerts']> = {
    async inspect({ context, kind, number }): Promise<ProviderResult<SecurityAlertSnapshot>> {
      if (!Number.isSafeInteger(number) || number <= 0) return invalid('SECURITY_NUMBER_INVALID', 'Alert number must be a positive integer');
      const suffix = kind === 'dependabot' ? 'dependabot' : kind === 'code-scanning' ? 'code-scanning' : null;
      if (!suffix) return invalid('SECURITY_KIND_INVALID', 'Alert kind is invalid');
      const response = client.json<any>(['api', `repos/${repository(context)}/${suffix}/alerts/${number}`], { cwd: context.workingDirectory });
      if (!response.ok) return response;
      const data = response.value;
      if (!data || typeof data !== 'object' || Array.isArray(data)) return invalid('SECURITY_RESPONSE_INVALID', 'The platform returned an invalid security alert');
      const value: SecurityAlertSnapshot = {
        kind,
        number,
        state: typeof data.state === 'string' ? data.state : 'invalid',
        data
      };
      return { ok: true, value };
    },
    async dismiss({ context, kind, number, reason, comment }): Promise<ProviderResult<MutationReceipt>> {
      const suffix = kind === 'dependabot' ? 'dependabot' : kind === 'code-scanning' ? 'code-scanning' : null;
      if (!suffix) return invalid('SECURITY_KIND_INVALID', 'Alert kind is invalid');
      if (!Number.isSafeInteger(number) || number <= 0) return invalid('SECURITY_NUMBER_INVALID', 'Alert number must be a positive integer');
      const response = client.json<any>(['api', `repos/${repository(context)}/${suffix}/alerts/${number}`, '-X', 'PATCH', '--input', '-'], {
        cwd: context.workingDirectory,
        method: 'PATCH',
        input: JSON.stringify({ state: 'dismissed', dismissed_reason: reason, dismissed_comment: comment })
      });
      if (!response.ok) return response;
      return createReceipt(String(response.value?.id || `${kind}:${number}`));
    }
  };

  const repositoryMetadata: NonNullable<PlatformProvider['repositoryMetadata']> = {
    async reconcileLabels({ context, desired, cleanupStaleIn }): Promise<ProviderResult<LabelReconciliation>> {
      return reconcileGitHubLabels(client, repository(context), context.workingDirectory, desired, cleanupStaleIn);
    },
    async reconcileMilestones({ context, desired }): Promise<ProviderResult<MilestoneInitialization>> {
      const listed = client.json<any>(['api', '--paginate', '--slurp', `repos/${repository(context)}/milestones?state=all&per_page=100`], { cwd: context.workingDirectory });
      if (!listed.ok) return listed;
      if (!Array.isArray(listed.value)) return invalid('MILESTONE_RESPONSE_INVALID', 'The platform returned an invalid milestone list');
      const values = Array.isArray(listed.value)
        ? listed.value.flatMap((entry: any) => Array.isArray(entry) ? entry : [entry])
        : [];
      if (values.some((entry: any) => !entry || typeof entry.title !== 'string' || !entry.title)) {
        return invalid('MILESTONE_RESPONSE_INVALID', 'The platform returned a milestone without a valid title');
      }
      const existing = new Set(values.map((entry: any) => String(entry.title)));
      const created: string[] = [];
      const skipped: string[] = [];
      for (const milestone of desired) {
        if (existing.has(milestone.title)) {
          skipped.push(milestone.title);
          continue;
        }
        const response = client.json(['api', `repos/${repository(context)}/milestones`, '-X', 'POST', '--input', '-'], {
          cwd: context.workingDirectory,
          method: 'POST',
          input: JSON.stringify({ title: milestone.title, description: milestone.description, state: milestone.state })
        });
        if (!response.ok) return partialFailure(response, milestoneInitialization(created, skipped));
        existing.add(milestone.title);
        created.push(milestone.title);
      }
      return { ok: true, value: { changed: created.length > 0, created, skipped } };
    }
  };

  const verification: NonNullable<PlatformProvider['verification']> = {
    async fetchRemoteFacts(input) {
      const issue = input.issue && issues.inspect
        ? await issues.inspect({ context: input.context, target: input.issue })
        : { ok: true as const, value: null };
      if (!issue.ok) return { ok: false, error: issue.error };
      const commentFacts = input.includeComments && input.issue && comments.list
        ? await comments.list({ context: input.context, parent: input.issue })
        : { ok: true as const, value: [] as RemoteCommentSnapshot[] };
      if (!commentFacts.ok) return { ok: false, error: commentFacts.error };
      const changeRequest = input.changeRequest && changeRequests.inspect
        ? await changeRequests.inspect({ context: input.context, target: input.changeRequest })
        : { ok: true as const, value: null };
      if (!changeRequest.ok) return { ok: false, error: changeRequest.error };
      return {
        ok: true,
        value: {
          issue: issue.value,
          comments: commentFacts.value,
          changeRequest: changeRequest.value,
          commit: null,
          fields: input.includeFields ? issue.value?.fields || {} : {}
        }
      } as ProviderResult<VerificationRemoteFacts>;
    }
  };

  return { issues, comments, changeRequests, checks, reviews, releases, securityAlerts, repositoryMetadata, verification };
}

function createGitHubProvider(
  input: PlatformProviderFactoryInput,
  client: GitHubClient = createGitHubClient()
): PlatformProvider {
  return publicProviderErrors({
    type: input.providerType,
    contractVersion: 2,
    identity: { issue: 'number', 'pull-request': 'number', comment: 'number', release: 'key' },
    ...createGitHubOperations(client),
    context: {
      async resolve(contextInput) {
        return resolveContext(client, contextInput);
      }
    }
  });
}

export {
  configuredGitRemotes,
  createGitHubProvider,
  defaultGitRemote,
  parseGitHubRemote,
  resolveGitHubChangeRequestGitEvidence,
  listGitHubCommitPullRequestAssociations
};
