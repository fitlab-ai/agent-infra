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
  ResourceIdentity,
  ReleaseNotesFacts,
  RepositoryMetadataSnapshot,
  ReleaseSnapshot,
  RemoteCommentSnapshot,
  RequiredCheckSnapshot,
  ReviewSnapshot,
  VerificationRemoteFacts
} from './provider-contract.ts';
import { resourceIdentityNumber, resourceIdentityString } from './resource-identity.ts';
import { syncLabelDelta } from './in-label-sync.ts';

const CURRENT_USER_QUERY = 'query { viewer { login } }';
const ISSUE_TYPES_QUERY = `query($owner:String!){organization(login:$owner){issueTypes(first:20){nodes{id name pinnedFields{__typename ... on IssueFieldSingleSelect{id name options{id name}} ... on IssueFieldDate{id name} ... on IssueFieldText{id name} ... on IssueFieldNumber{id name}}}}}}`;
const ISSUE_FIELDS_QUERY = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){issue(number:$number){id issueType{id name pinnedFields{__typename ... on IssueFieldSingleSelect{id name options{id name}} ... on IssueFieldDate{id name} ... on IssueFieldText{id name} ... on IssueFieldNumber{id name}}} issueFieldValues(first:50){nodes{__typename ... on IssueFieldSingleSelectValue{name optionId field{... on IssueFieldSingleSelect{id name}}} ... on IssueFieldDateValue{value field{... on IssueFieldDate{id name}}} ... on IssueFieldTextValue{value field{... on IssueFieldText{id name}}} ... on IssueFieldNumberValue{value field{... on IssueFieldNumber{id name}}}}}}}}`;

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
  const repositoryValue = repository.value as { fork?: boolean; full_name?: string; owner?: { type?: string }; parent?: { full_name?: string } } | null;
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
      authenticated: capabilities.authenticated,
      ...(repositoryValue?.owner?.type ? { metadata: { ownerType: repositoryValue.owner.type } } : {})
    }
  };
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
  | { ok: false; error: { code: string; message: string; retryable: boolean } } {
  const wanted = expectedHeadRepository(repositoryName, head);
  if (!wanted.ref || !/^[A-Za-z0-9._/-]+$/.test(wanted.ref)) return {
    ok: false,
    error: { code: 'PR_HEAD_INVALID', message: 'Pull request head ref is invalid', retryable: false }
  };
  const remotes = configuredGitRemotes(cwd);
  const remote = remotes.find((item) => item.repository.toLowerCase() === wanted.repository.toLowerCase())
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

function invalid(code: string, message: string): ProviderResult<never> {
  return { ok: false, error: { code, message, retryable: false } };
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

function commentSnapshot(value: any): RemoteCommentSnapshot {
  return {
    id: String(value.id),
    author: value.user?.login ? { id: String(value.user.login), name: String(value.user.login) } : null,
    body: String(value.body || ''),
    createdAt: String(value.created_at || ''),
    updatedAt: String(value.updated_at || value.created_at || '')
  };
}

function createReceipt(remoteId: string): ProviderResult<MutationReceipt> {
  return { ok: true, value: { changed: true, remoteId } };
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
          ? { ...synced.error, code: 'IN_LABEL_SYNC_PARTIAL', message: `In-label synchronization is partial or unknown: ${synced.error.message}` }
          : { code: 'IN_LABEL_SYNC_PARTIAL', message: 'In-label synchronization is partial or unknown', retryable: true }
      };
      return synced;
    }
    changed ||= synced.changed;
  }
  return { status: changed ? 'applied' as const : 'no-op' as const, changed, error: null };
}

function createGitHubOperations(client: GitHubClient): Pick<PlatformProvider, 'issues' | 'comments' | 'changeRequests' | 'checks' | 'reviews' | 'releases' | 'verification'> {
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
      const module = await import('./issues.ts');
      const fetched = module.inspectGitHubIssue(client, repository(context), number, context.workingDirectory);
      if (!fetched.ok) return fetched;
      const graph = module.graphState(client, repository(context), number, context.workingDirectory);
      return { ok: true, value: issueSnapshot(fetched.value, graph || undefined) };
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
      return createReceipt(String(number));
    },
    async update({ context, target, currentLabels, patch }) {
      const number = resourceIdentityNumber(target);
      if (!number) return invalid('ISSUE_NUMBER_INVALID', 'Issue number must be positive');
      const { issueType, fields, labels, ...restPatch } = patch;
      let requestPatch = restPatch;
      let changed = false;
      if (labels !== undefined) {
        let before = currentLabels;
        if (!before) {
          const current = client.json<any>(['api', `repos/${repository(context)}/issues/${number}`], { cwd: context.workingDirectory });
          if (!current.ok) return current;
          before = Array.isArray(current.value?.labels)
            ? current.value.labels.map((label: any) => typeof label === 'string' ? label : label?.name).filter((label: any): label is string => typeof label === 'string')
            : [];
        }
        const synced = syncLabels(client, repository(context), number, context.workingDirectory, before || [], labels!, ['status:', 'in:']);
        if (synced.status === 'failed' || synced.status === 'blocked') return synced.error
          ? { ok: false, error: synced.error }
          : invalid('IN_LABEL_SYNC_FAILED', 'Issue label synchronization failed');
        changed ||= synced.changed;
      }
      if (typeof patch.milestone === 'string') {
        const milestones = client.json<any>(['api', '--paginate', '--slurp', `repos/${repository(context)}/milestones?state=open&per_page=100`], { cwd: context.workingDirectory });
        if (!milestones.ok) return milestones;
        const values = Array.isArray(milestones.value)
          ? milestones.value.flatMap((entry: any) => Array.isArray(entry) ? entry : [entry])
          : [];
        const selected = values.find((item: any) => item?.title === patch.milestone);
        if (!Number.isSafeInteger(selected?.number) || selected.number <= 0) {
          return invalid('MILESTONE_IDENTITY_INVALID', 'Milestone title does not resolve to a positive number');
        }
        requestPatch = { ...restPatch, milestone: selected.number } as typeof restPatch;
      }
      if (issueType !== undefined || fields !== undefined) {
        const [owner, name] = repository(context).split('/');
        const current = client.json<any>(['api', 'graphql', '-f', `query=${ISSUE_FIELDS_QUERY}`, '-F', `owner=${owner}`, '-F', `name=${name}`, '-F', `number=${number}`], { cwd: context.workingDirectory });
        if (!current.ok) return current;
        const currentIssue = current.value?.data?.repository?.issue;
        const issueId = currentIssue?.id;
        if (!issueId) return invalid('ISSUE_GRAPH_IDENTITY_INVALID', 'Issue GraphQL response lacks issue identity');
        let targetType = currentIssue.issueType;
        if (issueType !== undefined) {
          const types = client.json<any>(['api', 'graphql', '-f', `query=${ISSUE_TYPES_QUERY}`, '-F', `owner=${owner}`], { cwd: context.workingDirectory });
          if (!types.ok) return types;
          targetType = (types.value?.data?.organization?.issueTypes?.nodes || []).find((item: any) => item?.name === issueType);
          if (!targetType) return invalid('ISSUE_TYPE_NOT_FOUND', 'Issue type was not found');
          if (targetType.id !== currentIssue.issueType?.id) {
            const updatedType = client.json(['api', 'graphql', '--input', '-'], {
              cwd: context.workingDirectory,
              method: 'POST',
              input: JSON.stringify({
                query: 'mutation($issueId:ID!,$issueTypeId:ID){updateIssueIssueType(input:{issueId:$issueId,issueTypeId:$issueTypeId}){issue{id}}}',
                variables: { issueId, issueTypeId: targetType.id }
              })
            });
            if (!updatedType.ok) return updatedType;
            changed = true;
          }
        }
        if (fields !== undefined) {
          const values = Object.entries(fields).flatMap(([name, value]) => {
            const field = (targetType?.pinnedFields || []).find((candidate: any) => candidate?.name === name);
            if (!field?.id) return [];
            if (field.__typename === 'IssueFieldSingleSelect') {
              const option = (field.options || []).find((candidate: any) => candidate?.name === value);
              return option?.id ? [{ fieldId: field.id, singleSelectOptionId: option.id }] : [];
            }
            const key = field.__typename === 'IssueFieldDate' ? 'dateValue' : field.__typename === 'IssueFieldNumber' ? 'numberValue' : 'textValue';
            return [{ fieldId: field.id, [key]: value }];
          });
          if (values.length > 0) {
            const updatedFields = client.json(['api', 'graphql', '--input', '-'], {
              cwd: context.workingDirectory,
              method: 'POST',
              input: JSON.stringify({
                query: 'mutation($issueId:ID!,$issueFields:[IssueFieldCreateOrUpdateInput!]!){setIssueFieldValue(input:{issueId:$issueId,issueFields:$issueFields}){issue{id}}}',
                variables: { issueId, issueFields: values }
              })
            });
            if (!updatedFields.ok) return updatedFields;
            changed = true;
          }
        }
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
      return { ok: true, value: values.filter((entry: any) => entry && entry.id !== undefined).map(commentSnapshot) };
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
        return { ok: false, error: { code: 'PR_LOCAL_HEAD_UNAVAILABLE', message: error instanceof Error ? error.message : String(error), retryable: false } };
      }
      const remote = verifyRemoteBranch(context.workingDirectory, repository(context), head);
      if (!remote.ok) return remote;
      if (remote.value !== localHead) return {
        ok: false,
        error: { code: 'PR_REMOTE_HEAD_MISMATCH', message: `Remote head ${remote.value} does not match local HEAD ${localHead}`, retryable: false }
      };
      return { ok: true, value: { sha: localHead } };
    },
    async inspect({ context, target }) {
      const number = resourceIdentityNumber(target);
      if (!number) return invalid('PR_NUMBER_INVALID', 'Pull request number must be positive');
      const module = await import('./pull-requests.ts');
      const fetched = module.inspectGitHubPullRequest(client, repository(context), number, context.workingDirectory);
      if (!fetched.ok) return fetched;
      return { ok: true, value: changeRequestSnapshot(fetched.value) };
    },
    async listClosing({ context, issue }) {
      const number = resourceIdentityNumber(issue);
      if (!number) return invalid('ISSUE_NUMBER_INVALID', 'Issue number must be positive');
      const module = await import('./pull-requests.ts');
      const fetched = module.inspectGitHubIssueClosingChangeRequests(client, repository(context), number, context.workingDirectory);
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
        let before = currentLabels;
        if (!before) {
          const current = client.json<any>(['api', `repos/${repository(context)}/pulls/${number}`], { cwd: context.workingDirectory });
          if (!current.ok) return current;
          before = Array.isArray(current.value?.labels)
            ? current.value.labels.map((label: any) => typeof label === 'string' ? label : label?.name).filter((label: any): label is string => typeof label === 'string')
            : [];
        }
        const synced = syncLabels(client, repository(context), number, context.workingDirectory, before || [], labels!, ['in:', 'type:']);
        if (synced.status === 'failed' || synced.status === 'blocked') return synced.error
          ? { ok: false, error: synced.error }
          : invalid('IN_LABEL_SYNC_FAILED', 'Pull request label synchronization failed');
        changed ||= synced.changed;
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
          const milestones = client.json<any>(['api', '--paginate', '--slurp', `repos/${repository(context)}/milestones?state=open&per_page=100`], { cwd: context.workingDirectory });
          if (!milestones.ok) return milestones;
          const values = Array.isArray(milestones.value) ? milestones.value.flatMap((entry: any) => Array.isArray(entry) ? entry : [entry]) : [];
          const selected = values.find((entry: any) => entry?.title === milestone);
          if (!Number.isSafeInteger(selected?.number) || selected.number <= 0) return invalid('MILESTONE_IDENTITY_INVALID', 'Milestone title does not resolve to a positive number');
          issuePatch.milestone = selected.number;
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
      const module = await import('./github-provider.ts');
      return module.resolveGitHubChangeRequestGitEvidence({
        cwd: context.workingDirectory,
        repository: repository(context),
        number,
        baseRepository: repository(context),
        baseRef: expected.targetBranch || 'main'
      });
    }
  };

  const checks: NonNullable<PlatformProvider['checks']> = {
    async inspectRequired({ context, changeRequest }) {
      const number = resourceIdentityNumber(changeRequest);
      if (!number) return invalid('PR_NUMBER_INVALID', 'Pull request number must be positive');
      const module = await import('./pr-checks.ts');
      const fetched = module.inspectGitHubRequiredChecks(client, repository(context), number, context.workingDirectory);
      if (!fetched.ok) return fetched;
      return { ok: true, value: fetched.value.map((check: any): RequiredCheckSnapshot => ({ name: check.name, status: check.bucket, conclusion: check.conclusion, detailsUrl: check.detailsUrl })) };
    },
    async resolveRun({ context, changeRequest, checkName, detailsUrl }) {
      const number = resourceIdentityNumber(changeRequest);
      if (!number) return invalid('PR_NUMBER_INVALID', 'Pull request number must be positive');
      const module = await import('./pr-checks.ts');
      const direct = detailsUrl ? module.parseRunJobIdentity(detailsUrl) : null;
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
      const value: ReleaseSnapshot = { id: String(response.value?.id || tag), tag: String(response.value?.tagName || tag), title: String(response.value?.name || tag), body: String(response.value?.body || ''), draft: Boolean(response.value?.isDraft), prerelease: Boolean(response.value?.isPrerelease), publishedAt: response.value?.publishedAt ? new Date(String(response.value.publishedAt)).toISOString() : null, displayUrl: response.value?.url ? String(response.value.url) : undefined, workflows: Array.isArray(runs.value) ? runs.value as Array<Record<string, import('./provider-contract.ts').JsonValue>> : [] };
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
        const tag = resourceIdentityString(release) || '';
        const result = module.publishGitHubReleaseNotes({ repository: repository(context), tag, title, notesFile }, { cwd: context.workingDirectory, client });
        if (result.status === 'failed' || result.status === 'blocked') return { ok: false, error: result.error || { code: 'RELEASE_NOTES_PUBLISH_FAILED', message: 'Release notes publish failed', retryable: false } };
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
        return { ok: false, error: collected.error || { code: 'RELEASE_NOTES_COLLECTION_FAILED', message: 'Release notes could not be collected', retryable: false } };
      }
      const mergedPullRequests = collected.pullRequests.map((item: any): ChangeRequestSnapshot => ({
        id: String(item.number), identity: { kind: 'number', value: Number(item.number) }, number: Number(item.number),
        state: 'closed', title: String(item.title || ''), body: String(item.body || ''),
        mergedAt: new Date(String(item.mergedAt)).toISOString(), displayUrl: String(item.url || ''),
        labels: Array.isArray(item.labels) ? item.labels.map((label: any) => String(label.name || label)) : [],
        assignees: [], mergeCommitSha: null
      }));
      const closingIssues: IssueSnapshot[] = collected.pullRequests.flatMap((item: any) =>
        Array.isArray(item.closingIssuesReferences) ? item.closingIssuesReferences.map((issue: any) => ({
          id: String(issue.number), identity: { kind: 'number', value: Number(issue.number) }, number: Number(issue.number),
          state: 'closed' as const, title: String(issue.title || ''), body: '', labels: Array.isArray(issue.labels) ? issue.labels.map((label: any) => String(label.name || label)) : [],
          assignees: [], milestone: null, fields: {}, displayUrl: String(issue.url || '')
        })) : []
      );
      const actors = [...collected.authors.values()].flatMap((items) => items.map((item: any) => ({
        ...(item.login ? { id: String(item.login) } : {}), ...(item.name ? { name: String(item.name) } : {})
      })));
      return {
        ok: true,
        value: {
          history: commitOids.map((sha) => ({ sha, message: '', authoredAt: toTime, author: actors.find((actor) => actor.id) || null })),
          mergedPullRequests,
          closingIssues,
          actors
        }
      };
    }
  };

  const verification: NonNullable<PlatformProvider['verification']> = {
    async fetchRemoteFacts(input) {
      const issue = input.issue && issues.inspect
        ? await issues.inspect({ context: input.context, target: input.issue })
        : { ok: true as const, value: null };
      if (!issue.ok) return issue;
      const commentFacts = input.includeComments && input.issue && comments.list
        ? await comments.list({ context: input.context, parent: input.issue })
        : { ok: true as const, value: [] as RemoteCommentSnapshot[] };
      if (!commentFacts.ok) return commentFacts;
      const changeRequest = input.changeRequest && changeRequests.inspect
        ? await changeRequests.inspect({ context: input.context, target: input.changeRequest })
        : { ok: true as const, value: null };
      if (!changeRequest.ok) return changeRequest;
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

  return { issues, comments, changeRequests, checks, reviews, releases, verification };
}

function createGitHubProvider(
  input: PlatformProviderFactoryInput,
  client: GitHubClient = createGitHubClient()
): PlatformProvider {
  return {
    type: input.providerType,
    contractVersion: 1,
    identity: { issue: 'number', 'pull-request': 'number', comment: 'number', release: 'key' },
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
