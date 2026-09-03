import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { buildDefaultBody } from '../task/commands/issue-body.ts';
import { extractTitle, parseTaskFrontmatter } from '../task/frontmatter.ts';
import { requirementFieldLabels, renderTemplateBody } from '../task/issue-form.ts';
import { resolveTaskRef } from '../task/resolve-ref.ts';
import { extractSection, findSectionHeading } from '../task/sections.ts';
import { writeTask } from '../task/write.ts';
import { resolvePlatformProviderContext } from './context.ts';
import type { PlatformClient } from './context.ts';
import {
  DEFAULT_REQUIREMENT_SECTION_ANCHORS,
  chooseMilestone,
  desiredIssueType,
  normalizeOption,
  planIssueMetadata
} from './issue-metadata.ts';
import type { IssueDesiredState, PlannedOperation, Requirement, RequirementSectionAnchor } from './issue-metadata.ts';
import { platformResult } from './types.ts';
import type { PlatformResult } from './types.ts';
import {
  labelDelta,
  planInLabelUpdate,
  syncLabelDelta,
  validateInLabelMapping,
  validateRepositoryLabelPayload
} from './in-label-sync.ts';
import {
  providerError,
  providerOperationContext,
  providerStatus,
  providerResourceIdentity,
  providerResourceToken,
  unsupportedProviderOperation
} from './provider-bridge.ts';
import { resourceIdentityEquals, resourceIdentityNumber, resourceIdentityString, serializeResourceIdentity } from './resource-identity.ts';
import { taskIssueIdentity } from './task-identities.ts';
import type { ResourceIdentity } from './resource-identity.ts';

type GitHubClient = PlatformClient;
import type { IssueSnapshot as ProviderIssueSnapshot, RepositoryMetadataSnapshot } from './provider-contract.ts';

type IssueSnapshot = {
  repository: string;
  number: number;
  identity?: ResourceIdentity;
  databaseId: number | null;
  nodeId: string;
  url: string;
  state: 'open' | 'closed';
  title: string;
  body: string;
  labels: string[];
  assignees: string[];
  milestone: string | null;
  issueType: string | null;
  fields: Record<string, string | number | null>;
};
type IssueResult = PlatformResult & {
  task: { id: string | null; issueNumber: number | null };
  issue: IssueSnapshot | null;
};
type SharedOptions = { cwd?: string; client?: PlatformClient };
type CreateOptions = SharedOptions & { agent: string; dryRun?: boolean };
type BindOptions = SharedOptions & { issue: string | number; agent: string; dryRun?: boolean };
type SyncOptions = SharedOptions & {
  agent: string;
  status?: string | 'none';
  assignees?: 'current' | 'none';
  milestone?: 'initial' | 'specific' | 'none';
  requirements?: boolean;
  issueType?: boolean;
  fields?: boolean;
  inLabels?: 'from-diff' | 'none';
  base?: string;
  state?: 'open' | 'closed';
  closeReason?: 'completed' | 'not_planned';
  dryRun?: boolean;
};

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

const ISSUE_TYPES_QUERY = `query($owner:String!){organization(login:$owner){issueTypes(first:20){nodes{id name pinnedFields{__typename ... on IssueFieldSingleSelect{id name options{id name}} ... on IssueFieldDate{id name} ... on IssueFieldText{id name} ... on IssueFieldNumber{id name}}}}}}`;
const ISSUE_FIELDS_QUERY = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){issue(number:$number){id issueType{id name pinnedFields{__typename ... on IssueFieldSingleSelect{id name options{id name}} ... on IssueFieldDate{id name} ... on IssueFieldText{id name} ... on IssueFieldNumber{id name}}} issueFieldValues(first:50){nodes{__typename ... on IssueFieldSingleSelectValue{name optionId field{... on IssueFieldSingleSelect{id name}}} ... on IssueFieldDateValue{value field{... on IssueFieldDate{id name}}} ... on IssueFieldTextValue{value field{... on IssueFieldText{id name}}} ... on IssueFieldNumberValue{value field{... on IssueFieldNumber{id name}}}}}}}}`;

function result(
  status: PlatformResult['status'],
  taskId: string | null,
  issueNumber: number | null,
  overrides: Partial<IssueResult> = {}
): IssueResult {
  return {
    ...platformResult(status),
    task: { id: taskId, issueNumber },
    issue: null,
    ...overrides
  };
}

async function resolvedContext(taskRef: string, options: SharedOptions) {
  const resolved = resolveTaskRef(taskRef, options.cwd ? { repoRoot: options.cwd } : {});
  if (!resolved.ok) return { ok: false as const, output: result('failed', resolved.taskId, null, {
    error: { code: resolved.code, message: resolved.message, retryable: false }
  }) };
  const content = fs.readFileSync(resolved.taskMdPath, 'utf8');
  const frontmatter = parseTaskFrontmatter(content);
  const issueIdentity = taskIssueIdentity(frontmatter);
  const issueNumber = resourceIdentityNumber(issueIdentity);
  const loaded = await resolvePlatformProviderContext({ cwd: resolved.repoRoot, client: options.client });
  const context = loaded.ok ? loaded.value.context : loaded.context;
  const usable = (context.status === 'no-op' || context.status === 'degraded') && context.platform.repository;
  if (!usable || !loaded.ok) return { ok: false as const, output: result(context.status, resolved.taskId, issueNumber, {
    platform: context.platform, capabilities: context.capabilities, operations: context.operations, error: context.error
  }) };
  return { ok: true as const, resolved, content, frontmatter, issueIdentity, issueNumber, client: options.client, context, provider: loaded.value.provider, providerType: loaded.value.providerType, loadedContext: loaded.value };
}

function normalizeProviderIssue(remote: ProviderIssueSnapshot, repository: string, fallbackNumber: number | null): IssueSnapshot {
  const identity = remote.identity || (remote.number ? { kind: 'number' as const, value: remote.number } : { kind: 'id' as const, value: remote.id });
  const snapshot: IssueSnapshot = {
    repository,
    number: remote.number ?? resourceIdentityNumber(identity) ?? fallbackNumber ?? 0,
    identity,
    databaseId: null,
    nodeId: remote.id,
    url: remote.displayUrl || '',
    state: remote.state,
    title: remote.title,
    body: remote.body,
    labels: [...remote.labels].sort(),
    assignees: [...remote.assignees].sort(),
    milestone: remote.milestone,
    issueType: remote.issueType?.name || null,
    fields: { ...remote.fields }
  };
  Object.defineProperty(snapshot, 'identity', { value: identity, enumerable: false, configurable: true });
  if (remote.issueType) Object.defineProperty(snapshot, 'issueTypeSnapshot', { value: remote.issueType, enumerable: false, configurable: true });
  return snapshot;
}

function planProviderMetadata(
  remote: ProviderIssueSnapshot,
  metadata: RepositoryMetadataSnapshot,
  frontmatter: Record<string, string>,
  options: Pick<SyncOptions, 'issueType' | 'fields'>,
  capabilities: PlatformResult['capabilities']
): PlannedOperation[] {
  if (!options.issueType && !options.fields) return [];
  if (!capabilities.push) return [
    ...(options.issueType ? [{ name: 'issue-type', status: 'skipped' as const, reasonCode: 'PUSH_REQUIRED' }] : []),
    ...(options.fields ? [{ name: 'fields', status: 'skipped' as const, reasonCode: 'PUSH_REQUIRED' }] : [])
  ];
  const target = metadata.issueTypes.find((candidate) => candidate.name === desiredIssueType(frontmatter.type || ''));
  if (!target) return [
    ...(options.issueType ? [{ name: 'issue-type', status: 'skipped' as const, reasonCode: 'ISSUE_TYPES_UNSUPPORTED' }] : []),
    ...(options.fields ? [{ name: 'fields', status: 'skipped' as const, reasonCode: 'ISSUE_TYPES_UNSUPPORTED' }] : [])
  ];
  const operations: PlannedOperation[] = [];
  if (options.issueType) {
    operations.push(remote.issueType && resourceIdentityEquals(remote.issueType.identity, target.identity)
      ? { name: 'issue-type', status: 'no-op', reasonCode: null }
      : { name: 'issue-type', status: 'planned', reasonCode: null, value: target.name });
  }
  if (options.fields) {
    const fields = target.fields.map((field) => ({
      id: resourceIdentityString(field.identity) || '',
      name: field.name,
      kind: field.kind,
      options: field.options.map((option) => ({ id: resourceIdentityString(option.identity) || '', name: option.name }))
    }));
    const desired = desiredFieldValues(frontmatter, fields);
    const values = Object.fromEntries(desired.map((field) => [field.name, field.value]));
    const changed = Object.entries(values).some(([name, value]) => remote.fields[name] !== value);
    operations.push(changed
      ? { name: 'fields', status: 'planned', reasonCode: null, value: values }
      : { name: 'fields', status: 'no-op', reasonCode: null });
  }
  return operations;
}

function providerIssueError(base: Awaited<ReturnType<typeof resolvedContext>> & { ok: true }, error: { code: string; message: string; retryable: boolean }, issueIdentity: ResourceIdentity | null): IssueResult {
  const issueNumber = resourceIdentityNumber(issueIdentity);
  return result(providerStatus(error), base.resolved.taskId, issueNumber, {
    platform: base.context.platform,
    capabilities: base.context.capabilities,
    resource: { kind: 'issue', number: issueNumber, ...(issueIdentity ? { identity: issueIdentity } : {}) },
    error: providerError(error, 'PLATFORM_PROVIDER_OPERATION_FAILED')
  });
}

async function inspectExternalIssue(
  base: Awaited<ReturnType<typeof resolvedContext>> & { ok: true },
  issueIdentity: ResourceIdentity
): Promise<IssueResult> {
  const operation = base.provider.issues?.inspect
    ? await base.provider.issues.inspect({ context: providerOperationContext(base.loadedContext), target: issueIdentity })
    : unsupportedProviderOperation(base.provider, 'issues.inspect');
  if (!operation.ok) return providerIssueError(base, operation.error, issueIdentity);
  const issue = normalizeProviderIssue(operation.value, base.context.platform.repository!, resourceIdentityNumber(issueIdentity));
  return result('no-op', base.resolved.taskId, resourceIdentityNumber(issueIdentity), {
    platform: base.context.platform,
    capabilities: base.context.capabilities,
    resource: { kind: 'issue', number: resourceIdentityNumber(issueIdentity), identity: issueIdentity },
    issue,
    error: null
  });
}

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

function normalizeIssueTypes(value: unknown): IssueTypeSchema[] {
  const nodes = (value as { data?: { organization?: { issueTypes?: { nodes?: unknown[] } } } })?.data?.organization?.issueTypes?.nodes;
  return (nodes || []).flatMap((raw) => {
    const item = raw as { id?: string; name?: string; pinnedFields?: unknown[] };
    return item.id && item.name ? [{ id: item.id, name: item.name, fields: normalizeFieldSchemas(item.pinnedFields) }] : [];
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

function inspectGitHubIssueMetadata(client: GitHubClient, repository: string, issue: number, cwd: string) {
  const fetched = fetchIssue(client, repository, issue, cwd);
  if (!fetched.ok) return fetched;
  const remote = fetched.value;
  return {
    ok: true as const,
    value: {
      state: String(remote.state || '').toLowerCase() === 'closed' ? 'closed' as const : 'open' as const,
      labels: (remote.labels || []).map((label: string | { name?: string }) => typeof label === 'string' ? label : label.name || '').filter(Boolean).sort(),
      body: remote.body || '',
      milestone: remote.milestone?.title || null
    }
  };
}

async function inspectPlatformIssue(taskRef: string, options: SharedOptions = {}): Promise<IssueResult> {
  const base = await resolvedContext(taskRef, options);
  if (!base.ok) return base.output;
  if (!base.issueIdentity) return result('no-op', base.resolved.taskId, null, {
    platform: base.context.platform, capabilities: base.context.capabilities,
    error: { code: 'ISSUE_NOT_LINKED', message: 'Task has no valid platform issue identity', retryable: false }
  });
  return inspectExternalIssue(base, base.issueIdentity);
}

function taskTitle(content: string): string {
  return extractTitle(content).replace(/^(?:任务：|Task:\s*)/i, '');
}

function configuredScope(repoRoot: string, content: string): string | null {
  try {
    const config = JSON.parse(fs.readFileSync(path.join(repoRoot, '.agents', '.airc.json'), 'utf8'));
    const candidates = Object.keys(config?.labels?.in || {}).filter((name) =>
      new RegExp(`(^|[^a-z0-9])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`, 'i').test(content)
    );
    return candidates.length === 1 ? candidates[0]! : null;
  } catch {
    return null;
  }
}

function conventionalTitle(content: string, taskType: string, repoRoot: string): string {
  const type = ({ feature: 'feat', bug: 'fix', bugfix: 'fix', refactor: 'refactor', refactoring: 'refactor', docs: 'docs', documentation: 'docs' } as Record<string, string>)[taskType] || 'chore';
  const scope = configuredScope(repoRoot, content);
  return `${type}${scope ? `(${scope})` : ''}: ${taskTitle(content)}`;
}

function selectedIssueForm(repoRoot: string, taskType: string): string | null {
  const formDir = path.join(repoRoot, '.github', 'ISSUE_TEMPLATE');
  try {
    const files = fs.readdirSync(formDir).filter((file) => file.endsWith('.yml') && file !== 'config.yml').sort();
    const tokens = taskType === 'bugfix' ? ['bug'] : taskType === 'feature' ? ['feature'] : [taskType];
    const selected = files.find((file) => tokens.some((token) => file.toLowerCase().includes(token)))
      || files.find((file) => file.toLowerCase().includes('other'))
      || files[0];
    return selected ? path.join(formDir, selected) : null;
  } catch {
    return null;
  }
}

function requirementSectionAnchors(repoRoot: string, taskType: string): RequirementSectionAnchor[] {
  const anchors = [...DEFAULT_REQUIREMENT_SECTION_ANCHORS];
  const selected = selectedIssueForm(repoRoot, taskType);
  if (!selected) return anchors;
  try {
    for (const heading of requirementFieldLabels(fs.readFileSync(selected, 'utf8'))) {
      if (!anchors.some((anchor) => anchor.level === 3 && anchor.heading === heading)) {
        anchors.push({ level: 3, heading });
      }
    }
  } catch {
    // Invalid forms use the same default-body fallback as Issue creation.
  }
  return anchors;
}

function deterministicIssueBody(repoRoot: string, content: string, taskType: string): string {
  const selected = selectedIssueForm(repoRoot, taskType);
  if (selected) {
    try {
      return renderTemplateBody(fs.readFileSync(selected, 'utf8'), {
        title: taskTitle(content),
        description: extractSection(content, ['描述', 'Description']),
        requirements: extractSection(content, ['需求', 'Requirements']),
        taskInput: extractSection(content, ['任务输入', 'Task Input']),
        taskInputHeading: findSectionHeading(content, ['任务输入', 'Task Input'])
      });
    } catch {
      // Invalid or unavailable forms fall back to the deterministic default body.
    }
  }
  return buildDefaultBody(content);
}

async function createPlatformIssue(taskRef: string, options: CreateOptions): Promise<IssueResult> {
  const base = await resolvedContext(taskRef, options);
  if (!base.ok) return base.output;
  if (base.issueIdentity) return inspectPlatformIssue(taskRef, options);
  const repository = base.context.platform.repository!;
  let repositoryLabels: string[] = [];
  let milestones: string[] = [];
  if (base.context.capabilities.triage) {
    const metadata = base.provider.issues?.describeRepository
      ? await base.provider.issues.describeRepository({ context: providerOperationContext(base.loadedContext) })
      : unsupportedProviderOperation(base.provider, 'issues.describeRepository');
    if (!metadata.ok) return providerIssueError(base, metadata.error, null);
    repositoryLabels = metadata.value.labels.map((label) => label.name);
    milestones = metadata.value.milestones.map((milestone) => milestone.title);
  }
  const typeLabel = ({
    bug: 'type: bug', bugfix: 'type: bug', feature: 'type: feature', enhancement: 'type: enhancement',
    refactor: 'type: enhancement', refactoring: 'type: enhancement', documentation: 'type: documentation',
    docs: 'type: documentation', 'dependency-upgrade': 'type: dependency-upgrade', task: 'type: task', chore: 'type: task'
  } as Record<string, string>)[base.frontmatter.type || ''];
  const explicitMilestone = base.frontmatter.milestone && milestones.some((item) => item === base.frontmatter.milestone)
    ? base.frontmatter.milestone
    : chooseMilestone('initial', milestones);
  const payload = {
    title: conventionalTitle(base.content, base.frontmatter.type || 'task', base.resolved.repoRoot),
    body: deterministicIssueBody(base.resolved.repoRoot, base.content, base.frontmatter.type || 'task'),
    assignees: base.context.platform.currentUser ? [base.context.platform.currentUser] : [],
    ...(typeLabel && repositoryLabels.includes(typeLabel) ? { labels: [typeLabel] } : {}),
    ...(explicitMilestone ? { milestone: explicitMilestone } : {})
  };
  if (options.dryRun) return result('planned', base.resolved.taskId, null, {
    platform: base.context.platform, capabilities: base.context.capabilities,
    operations: [{ name: 'issue:create', status: 'planned', reasonCode: null }], error: null
  });
  {
    const created = base.provider.issues?.create
      ? await base.provider.issues.create({
        context: providerOperationContext(base.loadedContext),
        desired: {
          title: payload.title,
          body: payload.body,
          labels: payload.labels || [],
          assignees: payload.assignees,
          milestone: typeof payload.milestone === 'string' ? payload.milestone : null,
          fields: {}
        },
        mutation: { idempotencyKey: `issue:create:${base.resolved.taskId}` }
      })
      : unsupportedProviderOperation(base.provider, 'issues.create');
    if (!created.ok) return providerIssueError(base, created.error, null);
    let createdIdentity: ResourceIdentity;
    try {
      createdIdentity = providerResourceIdentity(base.provider, 'issue', created.value.remoteId);
    } catch (error) {
      return result('failed', base.resolved.taskId, null, {
        platform: base.context.platform, capabilities: base.context.capabilities,
        error: { code: 'ISSUE_CREATE_RESPONSE_INVALID', message: error instanceof Error ? error.message : String(error), retryable: false }
      });
    }
    const inspected = base.provider.issues?.inspect
      ? await base.provider.issues.inspect({
        context: providerOperationContext(base.loadedContext),
        target: createdIdentity
      })
      : unsupportedProviderOperation(base.provider, 'issues.inspect');
    if (!inspected.ok) return providerIssueError(base, inspected.error, createdIdentity);
    const issueNumber = resourceIdentityNumber(inspected.value.identity || createdIdentity);
    const written = writeTask({
      taskRef: base.resolved.taskId, expectedState: 'active', mutations: [{ kind: 'frontmatter', set: { platform_issue_identity: serializeResourceIdentity(inspected.value.identity || createdIdentity) } }]
    }, { repoRoot: base.resolved.repoRoot });
    if (written.status === 'failed') return result('failed', base.resolved.taskId, null, {
      platform: base.context.platform, capabilities: base.context.capabilities,
      resource: { kind: 'issue', number: issueNumber, identity: inspected.value.identity || createdIdentity },
      error: { code: 'ISSUE_CREATED_BIND_FAILED', message: written.error.message, retryable: false }
    });
    return result('applied', base.resolved.taskId, issueNumber, {
      changed: true,
      platform: base.context.platform,
      capabilities: base.context.capabilities,
      resource: { kind: 'issue', number: issueNumber, identity: inspected.value.identity || createdIdentity },
      operations: [{ name: 'issue:create', status: 'applied', reasonCode: null }, { name: 'task:bind', status: 'applied', reasonCode: null }],
      issue: normalizeProviderIssue(inspected.value, repository, issueNumber),
      error: null
    });
  }
}

async function bindPlatformIssue(taskRef: string, options: BindOptions): Promise<IssueResult> {
  const base = await resolvedContext(taskRef, options);
  if (!base.ok) return base.output;
  let identity: ResourceIdentity;
  try { identity = providerResourceToken(base.provider, 'issue', String(options.issue)); }
  catch (error) { return result('failed', base.resolved.taskId, base.issueNumber, { error: { code: 'PLATFORM_IDENTITY_TOKEN_INVALID', message: error instanceof Error ? error.message : String(error), retryable: false } }); }
  if (base.issueIdentity && !resourceIdentityEquals(base.issueIdentity, identity)) return result('failed', base.resolved.taskId, base.issueNumber, {
    error: { code: 'ISSUE_BIND_CONFLICT', message: 'Task is already bound to a different Issue identity', retryable: false }
  });
  const fetched = base.provider.issues?.inspect
    ? await base.provider.issues.inspect({ context: providerOperationContext(base.loadedContext), target: identity })
    : unsupportedProviderOperation(base.provider, 'issues.inspect');
  if (!fetched.ok) return providerIssueError(base, fetched.error, identity);
  const issue = normalizeProviderIssue(fetched.value, base.context.platform.repository!, resourceIdentityNumber(identity));
  if (base.issueIdentity && resourceIdentityEquals(base.issueIdentity, identity)) return result('no-op', base.resolved.taskId, resourceIdentityNumber(identity), { issue, error: null });
  const written = writeTask({ taskRef: base.resolved.taskId, expectedState: 'active', dryRun: options.dryRun, mutations: [{ kind: 'frontmatter', set: { platform_issue_identity: serializeResourceIdentity(identity) } }] }, { repoRoot: base.resolved.repoRoot });
  if (written.status === 'failed') return result('failed', base.resolved.taskId, null, { issue, error: { code: written.error.code, message: written.error.message, retryable: false } });
  return result(options.dryRun ? 'planned' : 'applied', base.resolved.taskId, options.dryRun ? null : resourceIdentityNumber(identity), {
    changed: !options.dryRun, issue, resource: { kind: 'issue', number: resourceIdentityNumber(identity), identity }, operations: [{ name: 'task:bind', status: options.dryRun ? 'planned' : 'applied', reasonCode: null }], error: null
  });
}

function requirementsFromTask(content: string): Requirement[] {
  const section = extractSection(content, ['需求', 'Requirements']);
  return [...section.matchAll(/^\s*[-*+]\s+\[([ xX])\]\s+(.+?)\s*$/gm)].map((match) => ({
    checked: match[1]!.toLowerCase() === 'x', text: match[2]!
  }));
}

function flattenPages(value: unknown): unknown[] {
  return Array.isArray(value) ? value.flatMap((item) => Array.isArray(item) ? item : [item]) : [];
}

function listNames(value: unknown): string[] {
  return flattenPages(value).map((item) => typeof item === 'string' ? item : String((item as { name?: string }).name || '')).filter(Boolean);
}

function milestoneBasis(repoRoot: string, current: string | null): string | null {
  if (!current || !/^\d+\.\d+\.x$/.test(current)) return current;
  try {
    const refs = execFileSync('git', ['branch', '-r'], { cwd: repoRoot, encoding: 'utf8' });
    const releaseRefs = refs.split('\n').map((line) => line.trim()).filter((line) => /^origin\/\d+\.\d+\.x$/.test(line));
    if (releaseRefs.length === 0) return current;
    const currentRef = `origin/${current}`;
    if (releaseRefs.includes(currentRef)) {
      try {
        execFileSync('git', ['merge-base', '--is-ancestor', currentRef, 'HEAD'], { cwd: repoRoot, stdio: 'ignore' });
        return current;
      } catch {
        // Continue with the main-branch ancestry check.
      }
    }
    try {
      execFileSync('git', ['merge-base', '--is-ancestor', 'origin/main', 'HEAD'], { cwd: repoRoot, stdio: 'ignore' });
      return null;
    } catch {
      return current;
    }
  } catch {
    return current;
  }
}

function applyRestOperations(snapshot: IssueSnapshot, operations: PlannedOperation[]) {
  const payload: Record<string, unknown> = {};
  for (const operation of operations) {
    if (operation.status !== 'planned') continue;
    if (operation.name === 'assignees') payload.assignees = operation.value;
    if (operation.name === 'requirements') payload.body = operation.value;
    if (operation.name === 'state') payload.state = operation.value;
    if (operation.name === 'milestone') payload.milestone = operation.value;
    if (operation.name === 'issue-type') payload.issueType = operation.value;
    if (operation.name === 'fields') payload.fields = operation.value;
  }
  return payload;
}

function applyLabelDeltaToSnapshot(current: string[], target: readonly string[], prefix: string): string[] {
  const delta = labelDelta(current, target, prefix);
  const targetLabels = [...new Set(target.filter((label) => label.startsWith(prefix)))];
  return [...new Set([
    ...current.filter((label) => !delta.remove.includes(label)),
    ...targetLabels
  ])].sort();
}

type DesiredFieldValue = {
  fieldId: string;
  name: string;
  kind: IssueFieldSchema['kind'];
  value: string | number;
  input: Record<string, string | number | boolean>;
};

function desiredFieldValues(frontmatter: Record<string, string>, fields: IssueFieldSchema[]): DesiredFieldValue[] {
  const mapping: Array<[string, string]> = [
    ['priority', 'Priority'], ['effort', 'Effort'], ['start_date', 'Start date'], ['target_date', 'Target date']
  ];
  const desired: DesiredFieldValue[] = [];
  for (const [key, name] of mapping) {
    const raw = frontmatter[key];
    const field = fields.find((candidate) => candidate.name === name);
    if (!raw || !field) continue;
    if (field.kind === 'single-select') {
      const option = field.options.find((candidate) => candidate.name === normalizeOption(raw));
      if (option) desired.push({ fieldId: field.id, name, kind: field.kind, value: option.name, input: { fieldId: field.id, singleSelectOptionId: option.id } });
      continue;
    }
    if (field.kind === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(raw)) continue;
    if (field.kind === 'number' && !Number.isFinite(Number(raw))) continue;
    const value = field.kind === 'number' ? Number(raw) : raw;
    const keyName = field.kind === 'date' ? 'dateValue' : field.kind === 'number' ? 'numberValue' : 'textValue';
    desired.push({ fieldId: field.id, name, kind: field.kind, value, input: { fieldId: field.id, [keyName]: value } });
  }
  return desired;
}

function planGraphMetadata(
  client: GitHubClient,
  repository: string,
  issue: number,
  cwd: string,
  frontmatter: Record<string, string>,
  options: Pick<SyncOptions, 'issueType' | 'fields'>,
  capabilities: PlatformResult['capabilities']
): { operations: PlannedOperation[]; issueId: string | null } {
  if (!options.issueType && !options.fields) return { operations: [], issueId: null };
  if (!capabilities.push) return {
    operations: [
      ...(options.issueType ? [{ name: 'issue-type', status: 'skipped' as const, reasonCode: 'PUSH_REQUIRED' }] : []),
      ...(options.fields ? [{ name: 'fields', status: 'skipped' as const, reasonCode: 'PUSH_REQUIRED' }] : [])
    ], issueId: null
  };
  const [owner] = repository.split('/');
  const typesResult = client.json<unknown>(['api', 'graphql', '-f', `query=${ISSUE_TYPES_QUERY}`, '-F', `owner=${owner}`], { cwd });
  if (!typesResult.ok) return { operations: [{ name: 'issue-schema', status: 'failed', reasonCode: typesResult.error.code }], issueId: null };
  const types = normalizeIssueTypes(typesResult.value);
  if (types.length === 0) return {
    operations: [
      ...(options.issueType ? [{ name: 'issue-type', status: 'skipped' as const, reasonCode: 'ISSUE_TYPES_UNSUPPORTED' }] : []),
      ...(options.fields ? [{ name: 'fields', status: 'skipped' as const, reasonCode: 'ISSUE_TYPES_UNSUPPORTED' }] : [])
    ], issueId: null
  };
  const current = graphState(client, repository, issue, cwd);
  if (!current?.issueId) return { operations: [{ name: 'issue-schema', status: 'failed', reasonCode: 'ISSUE_GRAPH_IDENTITY_INVALID' }], issueId: null };
  const target = types.find((type) => type.name === desiredIssueType(frontmatter.type || ''));
  if (!target) return { operations: [{ name: 'issue-type', status: 'failed', reasonCode: 'ISSUE_TYPE_NOT_FOUND' }], issueId: current.issueId };
  const operations: PlannedOperation[] = [];
  if (options.issueType) operations.push(current.type?.id === target.id
    ? { name: 'issue-type', status: 'no-op', reasonCode: null }
    : { name: 'issue-type', status: 'planned', reasonCode: null, value: { issueTypeId: target.id } });
  if (options.fields) {
    const desired = desiredFieldValues(frontmatter, target.fields);
    const inputs = desired.filter((field) => current.values.find((value) => value.name === field.name)?.value !== field.value).map((field) => field.input);
    if (current.type?.id !== target.id) {
      const targetNames = new Set(target.fields.map((field) => field.name));
      for (const old of current.values) if (!targetNames.has(old.name)) inputs.push({ fieldId: old.id, delete: true });
    }
    operations.push(inputs.length === 0
      ? { name: 'fields', status: 'no-op', reasonCode: null }
      : { name: 'fields', status: 'planned', reasonCode: null, value: inputs });
  }
  return { operations, issueId: current.issueId };
}

function executeGraphOperation(
  client: GitHubClient,
  cwd: string,
  issueId: string,
  operation: PlannedOperation
) {
  if (operation.name === 'issue-type') {
    const query = 'mutation($issueId:ID!,$issueTypeId:ID){updateIssueIssueType(input:{issueId:$issueId,issueTypeId:$issueTypeId}){issue{id}}}';
    const typeId = (operation.value as { issueTypeId: string }).issueTypeId;
    return client.json(['api', 'graphql', '--input', '-'], {
      cwd, method: 'POST', input: JSON.stringify({ query, variables: { issueId, issueTypeId: typeId } })
    });
  }
  const query = 'mutation($issueId:ID!,$issueFields:[IssueFieldCreateOrUpdateInput!]!){setIssueFieldValue(input:{issueId:$issueId,issueFields:$issueFields}){issue{id}}}';
  return client.json(['api', 'graphql', '--input', '-'], {
    cwd, method: 'POST', input: JSON.stringify({ query, variables: { issueId, issueFields: operation.value } })
  });
}

async function syncPlatformIssue(taskRef: string, options: SyncOptions): Promise<IssueResult> {
  const base = await resolvedContext(taskRef, options);
  if (!base.ok) return base.output;
  if (!base.issueIdentity) return result('failed', base.resolved.taskId, null, { error: { code: 'ISSUE_NOT_LINKED', message: 'Task has no valid platform issue identity', retryable: false } });
  const repository = base.context.platform.repository!;
  const inspected = base.provider.issues?.inspect
    ? await base.provider.issues.inspect({ context: providerOperationContext(base.loadedContext), target: base.issueIdentity })
    : unsupportedProviderOperation(base.provider, 'issues.inspect');
  if (!inspected.ok) return providerIssueError(base, inspected.error, base.issueIdentity);
  const snapshot = normalizeProviderIssue(inspected.value, repository, resourceIdentityNumber(base.issueIdentity));
  let providerMetadata: RepositoryMetadataSnapshot | null = null;
  let repositoryLabels: string[] = [];
  let milestones: string[] = [];
  if (base.context.capabilities.triage && (options.status !== undefined || options.inLabels !== undefined || options.milestone !== undefined || options.issueType || options.fields)) {
    const metadata = base.provider.issues?.describeRepository
      ? await base.provider.issues.describeRepository({ context: providerOperationContext(base.loadedContext) })
      : unsupportedProviderOperation(base.provider, 'issues.describeRepository');
    if (!metadata.ok) return providerIssueError(base, metadata.error, base.issueIdentity);
    providerMetadata = metadata.value;
    repositoryLabels = metadata.value.labels.map((label) => label.name);
    milestones = metadata.value.milestones.map((milestone) => milestone.title);
  }
  const desired: IssueDesiredState = {
    status: options.status,
    assignees: options.assignees,
    milestone: options.milestone,
    requirements: options.requirements ? requirementsFromTask(base.content) : undefined,
    state: options.state
  };
  const plan = planIssueMetadata({
    snapshot: options.milestone === 'specific'
      ? { ...snapshot, milestone: milestoneBasis(base.resolved.repoRoot, snapshot.milestone) }
      : snapshot,
    desired, repositoryLabels: new Set(repositoryLabels), milestones,
    currentUser: base.context.platform.currentUser,
    requirementAnchors: requirementSectionAnchors(base.resolved.repoRoot, base.frontmatter.type || 'task'),
    capabilities: base.context.capabilities
  });
  if (options.inLabels === 'none') {
    const labels = snapshot.labels.filter((label) => !label.startsWith('in:')).sort();
    plan.operations.splice(plan.operations.findIndex((operation) => operation.name === 'assignees') >= 0 ? 1 : plan.operations.length, 0,
      base.context.capabilities.triage
        ? labels.join('\0') === snapshot.labels.join('\0')
          ? { name: 'labels:in', status: 'no-op', reasonCode: null }
          : { name: 'labels:in', status: 'planned', reasonCode: null, value: labels }
        : { name: 'labels:in', status: 'skipped', reasonCode: 'TRIAGE_REQUIRED' });
  }
  if (options.inLabels === 'from-diff') {
    const taskBase = typeof base.frontmatter.delivery_base_ref === 'string'
      ? base.frontmatter.delivery_base_ref.trim()
      : '';
    if (!taskBase) {
      plan.operations.push({ name: 'labels:in', status: 'failed', reasonCode: 'IN_LABEL_SYNC_BASE_MISSING' });
    } else if (options.base && options.base !== taskBase) {
      plan.operations.push({ name: 'labels:in', status: 'failed', reasonCode: 'IN_LABEL_SYNC_BASE_MISMATCH' });
    } else {
      try {
        const changed = execFileSync('git', ['diff', `${taskBase}...HEAD`, '--name-only'], {
          cwd: base.resolved.repoRoot, encoding: 'utf8'
        }).trim().split(/\r?\n/).filter(Boolean);
        const config = JSON.parse(fs.readFileSync(`${base.resolved.repoRoot}/.agents/.airc.json`, 'utf8')) as {
          labels?: { in?: Record<string, unknown> };
        };
        const mapping = validateInLabelMapping(config.labels?.in);
        if (!mapping.ok) {
          plan.operations.push({ name: 'labels:in', status: 'failed', reasonCode: mapping.error.code });
        } else {
          const planned = planInLabelUpdate({
            changedFiles: changed,
            currentLabels: snapshot.labels,
            mapping: mapping.value,
            repositoryLabels: new Set(repositoryLabels)
          });
          if (planned.error) {
            plan.operations.push({ name: 'labels:in', status: 'failed', reasonCode: planned.error.code });
          } else {
            plan.operations.push(planned.changed
              ? { name: 'labels:in', status: 'planned', reasonCode: null, value: planned.labels }
              : { name: 'labels:in', status: 'no-op', reasonCode: null });
          }
        }
      } catch {
        if (!plan.operations.some((operation) => operation.name === 'labels:in' && operation.status === 'failed')) {
          plan.operations.push({ name: 'labels:in', status: 'failed', reasonCode: 'IN_LABEL_SYNC_EVIDENCE_UNAVAILABLE' });
        }
      }
    }
  }
  if (options.issueType || options.fields) {
    plan.operations.push(...(providerMetadata
      ? planProviderMetadata(inspected.value, providerMetadata, base.frontmatter, options, base.context.capabilities)
      : [{ name: 'issue-type', status: 'skipped' as const, reasonCode: 'ISSUE_TYPES_UNSUPPORTED' }]));
  }
  const failure = plan.operations.find((operation) => operation.status === 'failed');
  if (failure) return result('failed', base.resolved.taskId, base.issueNumber, { issue: snapshot, operations: plan.operations, error: { code: failure.reasonCode || 'ISSUE_SYNC_FAILED', message: `Operation ${failure.name} failed`, retryable: false } });
  const planned = plan.operations.filter((operation) => operation.status === 'planned');
  const skipped = plan.operations.some((operation) => operation.status === 'skipped');
  if (options.dryRun) return result(planned.length ? 'planned' : skipped ? 'degraded' : 'no-op', base.resolved.taskId, base.issueNumber, { issue: snapshot, operations: plan.operations, error: null });
  if (planned.length === 0) return result(skipped ? 'degraded' : 'no-op', base.resolved.taskId, base.issueNumber, { issue: snapshot, operations: plan.operations, error: null });
  const payload = applyRestOperations(snapshot, planned) as Partial<{
    title: string; body: string; labels: string[]; assignees: string[];
    milestone: string | null; state: 'open' | 'closed'; fields: Record<string, string | number | null>;
  }>;
  const updated = base.provider.issues?.update
    ? await base.provider.issues.update({ context: providerOperationContext(base.loadedContext), target: base.issueIdentity, patch: payload, mutation: { idempotencyKey: `issue:update:${base.resolved.taskId}` } })
    : unsupportedProviderOperation(base.provider, 'issues.update');
  if (!updated.ok) return providerIssueError(base, updated.error, base.issueIdentity);
  return result(skipped ? 'degraded' : 'applied', base.resolved.taskId, base.issueNumber, {
    changed: updated.value.changed, platform: base.context.platform, capabilities: base.context.capabilities,
    resource: { kind: 'issue', number: base.issueNumber, identity: base.issueIdentity }, issue: snapshot,
    operations: plan.operations.map((operation) => operation.status === 'planned' ? { ...operation, status: 'applied' } : operation), error: null
  });
}

export {
  bindPlatformIssue,
  createPlatformIssue,
  graphState,
  inspectGitHubIssue,
  inspectGitHubIssueMetadata,
  inspectPlatformIssue,
  normalizeIssue,
  requirementSectionAnchors,
  syncPlatformIssue
};
export type { BindOptions, CreateOptions, IssueResult, IssueSnapshot, SyncOptions };
