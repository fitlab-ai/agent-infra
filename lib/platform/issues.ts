import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { buildDefaultBody } from '../task/commands/issue-body.ts';
import { extractTitle, parseTaskFrontmatter } from '../task/frontmatter.ts';
import { requirementFieldLabels, renderTemplateBody } from '../task/issue-form.ts';
import { resolveTaskRef } from '../task/resolve-ref.ts';
import { extractSection, findSectionHeading } from '../task/sections.ts';
import { writeTask } from '../task/write.ts';
import { resolvePlatformContext } from './context.ts';
import { createGitHubClient } from './github-client.ts';
import type { GitHubClient } from './github-client.ts';
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
import { planInLabelUpdate } from './in-label-sync.ts';

type IssueSnapshot = {
  repository: string;
  number: number;
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
type SharedOptions = { cwd?: string; client?: GitHubClient };
type CreateOptions = SharedOptions & { agent: string; dryRun?: boolean };
type BindOptions = SharedOptions & { issue: number; agent: string; dryRun?: boolean };
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

function resolvedContext(taskRef: string, options: SharedOptions) {
  const resolved = resolveTaskRef(taskRef, options.cwd ? { repoRoot: options.cwd } : {});
  if (!resolved.ok) return { ok: false as const, output: result('failed', resolved.taskId, null, {
    error: { code: resolved.code, message: resolved.message, retryable: false }
  }) };
  const content = fs.readFileSync(resolved.taskMdPath, 'utf8');
  const frontmatter = parseTaskFrontmatter(content);
  const rawIssue = Number(frontmatter.issue_number);
  const issueNumber = Number.isInteger(rawIssue) && rawIssue > 0 ? rawIssue : null;
  const client = options.client || createGitHubClient();
  const context = resolvePlatformContext({ cwd: resolved.repoRoot, client });
  const usable = (context.status === 'no-op' || context.status === 'degraded') && context.platform.repository;
  if (!usable) return { ok: false as const, output: result(context.status, resolved.taskId, issueNumber, {
    platform: context.platform, capabilities: context.capabilities, operations: context.operations, error: context.error
  }) };
  return { ok: true as const, resolved, content, frontmatter, issueNumber, client, context };
}

function normalizeIssue(remote: RemoteIssue, repository: string): IssueSnapshot | null {
  if (!Number.isInteger(remote.number) || Number(remote.number) <= 0 || !remote.node_id || remote.pull_request) return null;
  return {
    repository,
    number: Number(remote.number),
    databaseId: Number.isInteger(remote.id) ? Number(remote.id) : null,
    nodeId: remote.node_id,
    url: remote.html_url || `https://github.com/${repository}/issues/${remote.number}`,
    state: remote.state === 'closed' ? 'closed' : 'open',
    title: remote.title || '',
    body: remote.body || '',
    labels: (remote.labels || []).map((label) => typeof label === 'string' ? label : label.name || '').filter(Boolean).sort(),
    assignees: (remote.assignees || []).map((assignee) => assignee.login || '').filter(Boolean).sort(),
    milestone: remote.milestone?.title || null,
    issueType: null,
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
  const type = issue?.issueType?.id && issue.issueType.name ? {
    id: issue.issueType.id, name: issue.issueType.name, fields: normalizeFieldSchemas(issue.issueType.pinnedFields)
  } : null;
  const values = (issue?.issueFieldValues?.nodes || []).flatMap((raw) => {
    const item = raw as { __typename?: string; name?: string; value?: string | number; field?: { id?: string; name?: string } };
    const kind = fieldKind(item);
    const value = kind === 'single-select' ? item.name : item.value;
    return item.field?.id && item.field.name && kind && value !== undefined
      ? [{ id: item.field.id, name: item.field.name, kind, value: value ?? null }]
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
  const snapshot = normalizeIssue(fetched.value, repository);
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
      labels: (remote.labels || []).map((label) => typeof label === 'string' ? label : label.name || '').filter(Boolean).sort(),
      body: remote.body || '',
      milestone: remote.milestone?.title || null
    }
  };
}

function inspectPlatformIssue(taskRef: string, options: SharedOptions = {}): IssueResult {
  const base = resolvedContext(taskRef, options);
  if (!base.ok) return base.output;
  if (!base.issueNumber) return result('no-op', base.resolved.taskId, null, {
    platform: base.context.platform, capabilities: base.context.capabilities,
    error: { code: 'ISSUE_NOT_LINKED', message: 'Task has no valid issue_number', retryable: false }
  });
  const fetched = inspectGitHubIssue(base.client, base.context.platform.repository!, base.issueNumber, base.resolved.repoRoot);
  if (!fetched.ok) return result(fetched.error.retryable ? 'blocked' : 'failed', base.resolved.taskId, base.issueNumber, {
    platform: base.context.platform, capabilities: base.context.capabilities,
    resource: { kind: 'issue', number: base.issueNumber }, error: fetched.error
  });
  const issue = fetched.value;
  if (base.context.capabilities.push) {
    const graph = graphState(base.client, base.context.platform.repository!, base.issueNumber, base.resolved.repoRoot);
    if (graph) {
      issue.issueType = graph.type?.name || null;
      issue.fields = Object.fromEntries(graph.values.map((field) => [field.name, field.value]));
    }
  }
  return result('no-op', base.resolved.taskId, base.issueNumber, {
    platform: base.context.platform, capabilities: base.context.capabilities,
    resource: { kind: 'issue', number: base.issueNumber }, issue, error: null
  });
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

function createPlatformIssue(taskRef: string, options: CreateOptions): IssueResult {
  const base = resolvedContext(taskRef, options);
  if (!base.ok) return base.output;
  if (base.issueNumber) return inspectPlatformIssue(taskRef, options);
  const repository = base.context.platform.repository!;
  let repositoryLabels: string[] = [];
  let milestones: Array<{ title: string; number: number }> = [];
  if (base.context.capabilities.triage) {
    const labels = base.client.json<unknown>(['api', '--paginate', '--slurp', `repos/${repository}/labels?per_page=100`], { cwd: base.resolved.repoRoot });
    if (labels.ok) repositoryLabels = listNames(labels.value);
    const listed = base.client.json<unknown>(['api', '--paginate', '--slurp', `repos/${repository}/milestones?state=open&per_page=100`], { cwd: base.resolved.repoRoot });
    if (listed.ok) milestones = flattenPages(listed.value).map((item) => ({
      title: String((item as { title?: string }).title || ''), number: Number((item as { number?: number }).number)
    })).filter((item) => item.title && Number.isInteger(item.number));
  }
  const typeLabel = ({
    bug: 'type: bug', bugfix: 'type: bug', feature: 'type: feature', enhancement: 'type: enhancement',
    refactor: 'type: enhancement', refactoring: 'type: enhancement', documentation: 'type: documentation',
    docs: 'type: documentation', 'dependency-upgrade': 'type: dependency-upgrade', task: 'type: task', chore: 'type: task'
  } as Record<string, string>)[base.frontmatter.type || ''];
  const explicitMilestone = base.frontmatter.milestone && milestones.some((item) => item.title === base.frontmatter.milestone)
    ? base.frontmatter.milestone
    : chooseMilestone('initial', milestones.map((item) => item.title));
  const payload = {
    title: conventionalTitle(base.content, base.frontmatter.type || 'task', base.resolved.repoRoot),
    body: deterministicIssueBody(base.resolved.repoRoot, base.content, base.frontmatter.type || 'task'),
    assignees: base.context.platform.currentUser ? [base.context.platform.currentUser] : [],
    ...(typeLabel && repositoryLabels.includes(typeLabel) ? { labels: [typeLabel] } : {}),
    ...(explicitMilestone ? { milestone: milestones.find((item) => item.title === explicitMilestone)?.number } : {})
  };
  if (options.dryRun) return result('planned', base.resolved.taskId, null, {
    platform: base.context.platform, capabilities: base.context.capabilities,
    operations: [{ name: 'issue:create', status: 'planned', reasonCode: null }], error: null
  });
  const created = base.client.json<RemoteIssue>(['api', `repos/${repository}/issues`, '-X', 'POST', '--input', '-'], {
    cwd: base.resolved.repoRoot, method: 'POST', input: JSON.stringify(payload)
  });
  if (!created.ok) return result(created.error.retryable ? 'blocked' : 'failed', base.resolved.taskId, null, {
    platform: base.context.platform, capabilities: base.context.capabilities,
    operations: [{ name: 'issue:create', status: 'failed', reasonCode: created.error.code }], error: {
      ...created.error,
      code: created.error.retryable ? 'ISSUE_CREATE_OUTCOME_UNKNOWN' : created.error.code
    }
  });
  const issueNumber = Number(created.value.number);
  if (!Number.isInteger(issueNumber) || issueNumber <= 0 || !created.value.node_id || !created.value.html_url) {
    return result('failed', base.resolved.taskId, null, {
      platform: base.context.platform, capabilities: base.context.capabilities,
      error: { code: 'ISSUE_CREATE_RESPONSE_INVALID', message: 'Issue create response lacks validated identity', retryable: false }
    });
  }
  const written = writeTask({
    taskRef: base.resolved.taskId, expectedState: 'active', mutations: [{ kind: 'frontmatter', set: { issue_number: issueNumber } }]
  }, { repoRoot: base.resolved.repoRoot });
  if (written.status === 'failed') return result('failed', base.resolved.taskId, null, {
    platform: base.context.platform, capabilities: base.context.capabilities,
    resource: { kind: 'issue', number: issueNumber },
    operations: [{ name: 'issue:create', status: 'applied', reasonCode: null }, { name: 'task:bind', status: 'failed', reasonCode: written.error.code }],
    error: { code: 'ISSUE_CREATED_BIND_FAILED', message: `${created.value.html_url}: ${written.error.message}`, retryable: false }
  });
  return result('applied', base.resolved.taskId, issueNumber, {
    changed: true, platform: base.context.platform, capabilities: base.context.capabilities,
    resource: { kind: 'issue', number: issueNumber },
    operations: [{ name: 'issue:create', status: 'applied', reasonCode: null }, { name: 'task:bind', status: 'applied', reasonCode: null }],
    issue: normalizeIssue({
      ...created.value,
      state: 'open',
      title: payload.title,
      body: payload.body,
      labels: [],
      assignees: payload.assignees.map((login) => ({ login })),
      milestone: null
    }, repository),
    error: null
  });
}

function bindPlatformIssue(taskRef: string, options: BindOptions): IssueResult {
  const base = resolvedContext(taskRef, options);
  if (!base.ok) return base.output;
  if (!Number.isInteger(options.issue) || options.issue <= 0) return result('failed', base.resolved.taskId, base.issueNumber, {
    error: { code: 'ISSUE_NUMBER_INVALID', message: 'Issue number must be positive', retryable: false }
  });
  if (base.issueNumber && base.issueNumber !== options.issue) return result('failed', base.resolved.taskId, base.issueNumber, {
    error: { code: 'ISSUE_BIND_CONFLICT', message: `Task is already bound to Issue #${base.issueNumber}`, retryable: false }
  });
  const fetched = fetchIssue(base.client, base.context.platform.repository!, options.issue, base.resolved.repoRoot);
  if (!fetched.ok) return result(fetched.error.retryable ? 'blocked' : 'failed', base.resolved.taskId, base.issueNumber, { error: fetched.error });
  const issue = normalizeIssue(fetched.value, base.context.platform.repository!);
  if (!issue) return result('failed', base.resolved.taskId, base.issueNumber, { error: { code: 'ISSUE_IDENTITY_INVALID', message: 'Remote resource is not a valid Issue', retryable: false } });
  if (base.issueNumber === options.issue) return result('no-op', base.resolved.taskId, options.issue, { issue, error: null });
  const written = writeTask({ taskRef: base.resolved.taskId, expectedState: 'active', dryRun: options.dryRun, mutations: [{ kind: 'frontmatter', set: { issue_number: options.issue } }] }, { repoRoot: base.resolved.repoRoot });
  if (written.status === 'failed') return result('failed', base.resolved.taskId, null, { issue, error: { code: written.error.code, message: written.error.message, retryable: false } });
  return result(options.dryRun ? 'planned' : 'applied', base.resolved.taskId, options.dryRun ? null : options.issue, {
    changed: !options.dryRun, issue, operations: [{ name: 'task:bind', status: options.dryRun ? 'planned' : 'applied', reasonCode: null }], error: null
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
  let labels = [...snapshot.labels];
  let labelsChanged = false;
  for (const operation of operations) {
    if (operation.status !== 'planned') continue;
    if (operation.name === 'labels:status') {
      labels = [
        ...labels.filter((label) => !label.startsWith('status:')),
        ...(operation.value as string[]).filter((label) => label.startsWith('status:'))
      ];
      labelsChanged = true;
    }
    if (operation.name === 'labels:in') {
      labels = [
        ...labels.filter((label) => !label.startsWith('in:')),
        ...(operation.value as string[]).filter((label) => label.startsWith('in:'))
      ];
      labelsChanged = true;
    }
    if (operation.name === 'assignees') payload.assignees = operation.value;
    if (operation.name === 'requirements') payload.body = operation.value;
    if (operation.name === 'state') payload.state = operation.value;
    if (operation.name === 'milestone') payload.milestone = operation.value;
  }
  if (labelsChanged) payload.labels = [...new Set(labels)].sort();
  return payload;
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

function syncPlatformIssue(taskRef: string, options: SyncOptions): IssueResult {
  const base = resolvedContext(taskRef, options);
  if (!base.ok) return base.output;
  if (!base.issueNumber) return result('failed', base.resolved.taskId, null, { error: { code: 'ISSUE_NOT_LINKED', message: 'Task has no valid issue_number', retryable: false } });
  const repository = base.context.platform.repository!;
  const fetched = fetchIssue(base.client, repository, base.issueNumber, base.resolved.repoRoot);
  if (!fetched.ok) return result(fetched.error.retryable ? 'blocked' : 'failed', base.resolved.taskId, base.issueNumber, { error: fetched.error });
  const snapshot = normalizeIssue(fetched.value, repository);
  if (!snapshot) return result('failed', base.resolved.taskId, base.issueNumber, { error: { code: 'ISSUE_IDENTITY_INVALID', message: 'Remote resource is not a valid Issue', retryable: false } });
  let repositoryLabels: string[] = [];
  if (options.status !== undefined || options.inLabels !== undefined) {
    const labels = base.client.json<unknown>(['api', '--paginate', '--slurp', `repos/${repository}/labels?per_page=100`], { cwd: base.resolved.repoRoot });
    if (!labels.ok) return result(labels.error.retryable ? 'blocked' : 'failed', base.resolved.taskId, base.issueNumber, { issue: snapshot, error: labels.error });
    repositoryLabels = listNames(labels.value).flatMap((name) => name);
  }
  let milestones: Array<{ title: string; number: number }> = [];
  if (options.milestone !== undefined) {
    const listed = base.client.json<unknown>(['api', '--paginate', '--slurp', `repos/${repository}/milestones?state=open&per_page=100`], { cwd: base.resolved.repoRoot });
    if (!listed.ok) return result(listed.error.retryable ? 'blocked' : 'failed', base.resolved.taskId, base.issueNumber, { issue: snapshot, error: listed.error });
    milestones = flattenPages(listed.value).map((item) => ({ title: String((item as { title?: string }).title || ''), number: Number((item as { number?: number }).number) })).filter((item) => item.title && Number.isInteger(item.number));
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
    desired, repositoryLabels: new Set(repositoryLabels), milestones: milestones.map((item) => item.title),
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
        const planned = planInLabelUpdate({
          changedFiles: changed,
          currentLabels: snapshot.labels,
          mapping: config.labels?.in || {},
          repositoryLabels: new Set(repositoryLabels)
        });
        plan.operations.push(planned.changed
          ? { name: 'labels:in', status: 'planned', reasonCode: null, value: planned.labels }
          : { name: 'labels:in', status: 'no-op', reasonCode: null });
      } catch {
        plan.operations.push({ name: 'labels:in', status: 'failed', reasonCode: 'IN_LABEL_SYNC_EVIDENCE_UNAVAILABLE' });
      }
    }
  }
  const graph = planGraphMetadata(
    base.client, repository, base.issueNumber, base.resolved.repoRoot, base.frontmatter,
    options, base.context.capabilities
  );
  plan.operations.push(...graph.operations);
  const failure = plan.operations.find((operation) => operation.status === 'failed');
  if (failure) return result('failed', base.resolved.taskId, base.issueNumber, { issue: snapshot, operations: plan.operations, error: { code: failure.reasonCode || 'ISSUE_SYNC_FAILED', message: `Operation ${failure.name} failed`, retryable: false } });
  const planned = plan.operations.filter((operation) => operation.status === 'planned');
  const skipped = plan.operations.some((operation) => operation.status === 'skipped');
  if (options.dryRun) return result(planned.length ? 'planned' : skipped ? 'degraded' : 'no-op', base.resolved.taskId, base.issueNumber, { issue: snapshot, operations: plan.operations, error: null });
  if (planned.length === 0) return result(skipped ? 'degraded' : 'no-op', base.resolved.taskId, base.issueNumber, { issue: snapshot, operations: plan.operations, error: null });
  const restPlanned = planned.filter((operation) => !['issue-type', 'fields'].includes(operation.name));
  const graphPlanned = planned.filter((operation) => ['issue-type', 'fields'].includes(operation.name));
  const payload = applyRestOperations(snapshot, restPlanned);
  if (typeof payload.milestone === 'string') payload.milestone = milestones.find((item) => item.title === payload.milestone)?.number ?? payload.milestone;
  if (options.closeReason) payload.state_reason = options.closeReason;
  if (Object.keys(payload).length > 0) {
    const patched = base.client.json<unknown>(['api', `repos/${repository}/issues/${base.issueNumber}`, '-X', 'PATCH', '--input', '-'], {
      cwd: base.resolved.repoRoot, method: 'PATCH', input: JSON.stringify(payload)
    });
    if (!patched.ok) {
      const inLabelWrite = restPlanned.some((operation) => operation.name === 'labels:in');
      const error = inLabelWrite && patched.error.retryable
        ? { ...patched.error, code: 'IN_LABEL_SYNC_PARTIAL', message: `In-label synchronization is partial or unknown: ${patched.error.message}` }
        : patched.error;
      return result(error.retryable ? 'blocked' : 'failed', base.resolved.taskId, base.issueNumber, { issue: snapshot, operations: plan.operations, error });
    }
  }
  let finalSnapshot = snapshot;
  const inLabelWrite = restPlanned.find((operation) => operation.name === 'labels:in' && operation.status === 'planned');
  if (inLabelWrite) {
    const reread = inspectGitHubIssue(base.client, repository, base.issueNumber, base.resolved.repoRoot);
    if (!reread.ok) return result('blocked', base.resolved.taskId, base.issueNumber, {
      issue: snapshot, operations: plan.operations,
      error: { ...reread.error, code: 'IN_LABEL_SYNC_PARTIAL', message: `In-label synchronization is partial or unknown: ${reread.error.message}` }
    });
    const expected = (inLabelWrite.value as string[]).filter((label) => label.startsWith('in:')).sort();
    const actual = reread.value.labels.filter((label) => label.startsWith('in:')).sort();
    if (expected.join('\0') !== actual.join('\0')) return result('blocked', base.resolved.taskId, base.issueNumber, {
      issue: reread.value, operations: plan.operations,
      error: { code: 'IN_LABEL_SYNC_PARTIAL', message: 'Issue in: labels did not converge after update', retryable: true }
    });
    finalSnapshot = reread.value;
  }
  for (const operation of graphPlanned) {
    if (!graph.issueId) return result('failed', base.resolved.taskId, base.issueNumber, { issue: snapshot, operations: plan.operations, error: { code: 'ISSUE_GRAPH_IDENTITY_INVALID', message: 'Issue GraphQL identity is unavailable', retryable: false } });
    const written = executeGraphOperation(base.client, base.resolved.repoRoot, graph.issueId, operation);
    if (!written.ok) return result(written.error.retryable ? 'blocked' : 'failed', base.resolved.taskId, base.issueNumber, { issue: snapshot, operations: plan.operations, error: written.error });
  }
  return result(skipped ? 'degraded' : 'applied', base.resolved.taskId, base.issueNumber, {
    changed: true, platform: base.context.platform, capabilities: base.context.capabilities,
    resource: { kind: 'issue', number: base.issueNumber }, issue: finalSnapshot,
    operations: plan.operations.map((operation) => operation.status === 'planned' ? { ...operation, status: 'applied' } : operation), error: null
  });
}

export {
  bindPlatformIssue,
  createPlatformIssue,
  inspectGitHubIssue,
  inspectGitHubIssueMetadata,
  inspectPlatformIssue,
  normalizeIssue,
  requirementSectionAnchors,
  syncPlatformIssue
};
export type { BindOptions, CreateOptions, IssueResult, IssueSnapshot, SyncOptions };
