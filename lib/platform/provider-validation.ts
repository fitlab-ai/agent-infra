import { parseResourceIdentity } from './resource-identity.ts';
import type {
  ChangeRequestSnapshot,
  CheckLogSnapshot,
  CheckRunSnapshot,
  GitEvidenceSnapshot,
  IssueSnapshot,
  MilestoneReconciliation,
  MutationReceipt,
  PlatformContextSnapshot,
  PlatformError,
  PlatformProvider,
  ProviderResult,
  ReleaseNotesFacts,
  ReleaseSnapshot,
  RemoteCommentSnapshot,
  RepositoryMetadataSnapshot,
  RequiredCheckSnapshot,
  ReviewSnapshot,
  VerificationRemoteFacts
} from './provider-contract.ts';
import type { JsonValue } from './provider-contract.ts';

type ResultValidator<T> = (value: unknown) => T;

function validationError(providerType: string, phase: string, message: string, code = 'PLATFORM_PROVIDER_RESULT_INVALID'): PlatformError {
  return {
    code,
    message,
    retryable: false,
    providerType,
    phase
  };
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const allowed = new Set(keys);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new Error(`${label} contains unknown fields`);
}

function jsonValue(value: unknown, label: string): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((entry, index) => jsonValue(entry, `${label}[${index}]`));
  const item = record(value, label);
  return Object.fromEntries(Object.entries(item).map(([key, entry]) => [key, jsonValue(entry, `${label}.${key}`)]));
}

function jsonObject(value: unknown, label: string): Record<string, JsonValue> {
  const item = record(value, label);
  return Object.fromEntries(Object.entries(item).map(([key, entry]) => [key, jsonValue(entry, `${label}.${key}`)]));
}

function scalarFields(value: unknown, label: string): Record<string, string | number | null> {
  const item = record(value, label);
  return Object.fromEntries(Object.entries(item).map(([key, entry]) => {
    if (entry === null || typeof entry === 'string') return [key, entry];
    if (typeof entry === 'number' && Number.isFinite(entry)) return [key, entry];
    throw new Error(`${label}.${key} must be a string, number, or null`);
  }));
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${label} must be boolean`);
  return value;
}

function fieldKind(value: unknown, label: string): 'single-select' | 'date' | 'text' | 'number' {
  if (value !== 'single-select' && value !== 'date' && value !== 'text' && value !== 'number') throw new Error(`${label} is invalid`);
  return value;
}

function mergeability(value: unknown, label: string): { state: 'mergeable' | 'conflicting' | 'unknown'; detail: string | null } {
  const item = record(value, label);
  exactKeys(item, ['state', 'detail'], label);
  if (item.state !== 'mergeable' && item.state !== 'conflicting' && item.state !== 'unknown') throw new Error(`${label}.state is invalid`);
  return { state: item.state, detail: item.detail === null ? null : stringValue(item.detail, `${label}.detail`) };
}

function stringValue(value: unknown, label: string, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) throw new Error(`${label} must be a string`);
  return value;
}

function nullableString(value: unknown, label: string): string | null {
  return value === null ? null : stringValue(value, label);
}

function timestamp(value: unknown, label: string): string {
  const result = stringValue(value, label);
  if (Number.isNaN(Date.parse(result))) throw new Error(`${label} must be a timestamp`);
  return result;
}

function arrayValue(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function stableUnique<T>(values: T[], key: (value: T) => string, label: string): T[] {
  const seen = new Set<string>();
  for (const value of values) {
    const identityKey = key(value);
    if (seen.has(identityKey)) throw new Error(`${label} contains duplicate identities`);
    seen.add(identityKey);
  }
  return [...values].sort((left, right) => key(left).localeCompare(key(right)));
}

function identity(value: unknown, label: string): ReturnType<typeof parseResourceIdentity> {
  return parseResourceIdentity(value, label);
}

function author(value: unknown, label: string): { id?: string; name?: string } | null {
  if (value === null) return null;
  const item = record(value, label);
  exactKeys(item, ['id', 'name'], label);
  const result: { id?: string; name?: string } = {};
  if (item.id !== undefined) result.id = stringValue(item.id, `${label}.id`);
  if (item.name !== undefined) result.name = stringValue(item.name, `${label}.name`);
  if (!result.id && !result.name) throw new Error(`${label} must identify an author`);
  return result;
}

function validateContext(value: unknown, expectedProviderType?: string): PlatformContextSnapshot {
  const item = record(value, 'context');
  exactKeys(item, ['type', 'scope', 'currentUser', 'capabilities', 'authenticated', 'metadata'], 'context');
  const scope = record(item.scope, 'context.scope');
  exactKeys(scope, ['id', 'label'], 'context.scope');
  const capabilities = record(item.capabilities, 'context.capabilities');
  exactKeys(capabilities, ['authenticated', 'comment', 'triage', 'push', 'admin'], 'context.capabilities');
  const capabilityNames = ['authenticated', 'comment', 'triage', 'push', 'admin'];
  if (capabilityNames.some((name) => typeof capabilities[name] !== 'boolean')) throw new Error('context.capabilities must contain booleans');
  if (typeof item.authenticated !== 'boolean') throw new Error('context.authenticated must be boolean');
  const type = stringValue(item.type, 'context.type');
  if (expectedProviderType !== undefined && type !== expectedProviderType) throw new Error('context.type does not match selected provider');
  return {
    type,
    scope: { id: stringValue(scope.id, 'context.scope.id'), ...(scope.label === undefined ? {} : { label: stringValue(scope.label, 'context.scope.label') }) },
    currentUser: author(item.currentUser, 'context.currentUser'),
    capabilities: {
      authenticated: capabilities.authenticated as boolean,
      comment: capabilities.comment as boolean,
      triage: capabilities.triage as boolean,
      push: capabilities.push as boolean,
      admin: capabilities.admin as boolean
    },
    authenticated: item.authenticated,
    ...(item.metadata === undefined ? {} : { metadata: jsonObject(item.metadata, 'context.metadata') })
  };
}

function validateIssue(value: unknown): IssueSnapshot {
  const item = record(value, 'issue');
  exactKeys(item, ['id', 'identity', 'number', 'title', 'body', 'state', 'labels', 'assignees', 'milestone', 'fields', 'issueType', 'author', 'displayUrl'], 'issue');
  const result: IssueSnapshot = {
    id: item.id === undefined ? '' : stringValue(item.id, 'issue.id'),
    ...(item.identity === undefined ? {} : { identity: identity(item.identity, 'issue.identity') }),
    ...(item.number === undefined ? {} : { number: Number.isSafeInteger(item.number) && (item.number as number) > 0 ? item.number as number : (() => { throw new Error('issue.number is invalid'); })() }),
    title: stringValue(item.title, 'issue.title', true),
    body: stringValue(item.body, 'issue.body', true),
    state: item.state === 'closed' ? 'closed' : item.state === 'open' ? 'open' : (() => { throw new Error('issue.state is invalid'); })(),
    labels: arrayValue(item.labels, 'issue.labels').map((entry) => stringValue(entry, 'issue.labels[]')),
    assignees: arrayValue(item.assignees, 'issue.assignees').map((entry) => stringValue(entry, 'issue.assignees[]')),
    milestone: nullableString(item.milestone, 'issue.milestone'),
    fields: scalarFields(item.fields, 'issue.fields'),
    ...(item.issueType === undefined ? {} : { issueType: item.issueType === null ? null : issueType(item.issueType, 'issue.issueType') }),
    ...(item.author === undefined ? {} : { author: author(item.author, 'issue.author') }),
    ...(item.displayUrl === undefined ? {} : { displayUrl: stringValue(item.displayUrl, 'issue.displayUrl') })
  };
  if (!result.id && !result.identity) throw new Error('issue must expose id or identity');
  if (result.number !== undefined && (!Number.isSafeInteger(result.number) || result.number <= 0)) throw new Error('issue.number is invalid');
  return result;
}

function issueType(value: unknown, label: string): NonNullable<IssueSnapshot['issueType']> {
  const item = record(value, label);
  exactKeys(item, ['identity', 'name', 'fields'], label);
  const fields = arrayValue(item.fields, `${label}.fields`).map((rawField) => {
    const field = record(rawField, `${label}.field`);
    exactKeys(field, ['identity', 'name', 'kind', 'options'], `${label}.field`);
    return {
      identity: identity(field.identity, `${label}.field.identity`),
      name: stringValue(field.name, `${label}.field.name`),
      kind: fieldKind(field.kind, `${label}.field.kind`),
      options: arrayValue(field.options, `${label}.field.options`).map((rawOption) => {
        const option = record(rawOption, `${label}.field.option`);
        exactKeys(option, ['identity', 'name'], `${label}.field.option`);
        return { identity: identity(option.identity, `${label}.field.option.identity`), name: stringValue(option.name, `${label}.field.option.name`) };
      })
    };
  });
  return { identity: identity(item.identity, `${label}.identity`), name: stringValue(item.name, `${label}.name`), fields };
}

function validateComment(value: unknown): RemoteCommentSnapshot {
  const item = record(value, 'comment');
  exactKeys(item, ['id', 'author', 'body', 'createdAt', 'updatedAt'], 'comment');
  return {
    id: stringValue(item.id, 'comment.id'),
    author: author(item.author, 'comment.author'),
    body: stringValue(item.body, 'comment.body', true),
    createdAt: utcTimestamp(item.createdAt, 'comment.createdAt'),
    updatedAt: utcTimestamp(item.updatedAt, 'comment.updatedAt')
  };
}

function validateChangeRequest(value: unknown): ChangeRequestSnapshot {
  const item = record(value, 'changeRequest');
  exactKeys(item, ['id', 'identity', 'number', 'state', 'title', 'body', 'baseSha', 'headSha', 'author', 'mergedAt', 'displayUrl', 'draft', 'labels', 'assignees', 'milestone', 'mergeCommitSha', 'mergeability', 'head', 'base'], 'changeRequest');
  const result = {
    id: item.id === undefined ? '' : stringValue(item.id, 'changeRequest.id'),
    ...(item.identity === undefined ? {} : { identity: identity(item.identity, 'changeRequest.identity') }),
    ...(item.number === undefined ? {} : { number: Number.isSafeInteger(item.number) && (item.number as number) > 0 ? item.number as number : (() => { throw new Error('changeRequest.number is invalid'); })() }),
    state: stringValue(item.state, 'changeRequest.state'),
    title: stringValue(item.title, 'changeRequest.title', true),
    body: stringValue(item.body, 'changeRequest.body', true),
    ...(item.baseSha === undefined ? {} : { baseSha: stringValue(item.baseSha, 'changeRequest.baseSha') }),
    ...(item.headSha === undefined ? {} : { headSha: stringValue(item.headSha, 'changeRequest.headSha') }),
    ...(item.author === undefined ? {} : { author: author(item.author, 'changeRequest.author') }),
    ...(item.mergedAt === undefined ? {} : { mergedAt: item.mergedAt === null ? null : utcTimestamp(item.mergedAt, 'changeRequest.mergedAt') }),
    ...(item.displayUrl === undefined ? {} : { displayUrl: stringValue(item.displayUrl, 'changeRequest.displayUrl') }),
    ...(item.draft === undefined ? {} : { draft: booleanValue(item.draft, 'changeRequest.draft') }),
    ...(item.labels === undefined ? {} : { labels: arrayValue(item.labels, 'changeRequest.labels').map((entry) => stringValue(entry, 'changeRequest.labels[]')) }),
    ...(item.assignees === undefined ? {} : { assignees: arrayValue(item.assignees, 'changeRequest.assignees').map((entry) => stringValue(entry, 'changeRequest.assignees[]')) }),
    ...(item.milestone === undefined ? {} : { milestone: nullableString(item.milestone, 'changeRequest.milestone') }),
    ...(item.mergeCommitSha === undefined ? {} : { mergeCommitSha: item.mergeCommitSha === null ? null : stringValue(item.mergeCommitSha, 'changeRequest.mergeCommitSha') }),
    ...(item.mergeability === undefined ? {} : { mergeability: mergeability(item.mergeability, 'changeRequest.mergeability') }),
    ...(item.head === undefined ? {} : { head: validateRef(item.head, 'changeRequest.head') }),
    ...(item.base === undefined ? {} : { base: validateRef(item.base, 'changeRequest.base') })
  } as ChangeRequestSnapshot;
  if (!result.id && !result.identity) throw new Error('changeRequest must expose id or identity');
  if (result.number !== undefined && (!Number.isSafeInteger(result.number) || result.number <= 0)) throw new Error('changeRequest.number is invalid');
  if (result.mergedAt && Number.isNaN(Date.parse(result.mergedAt))) throw new Error('changeRequest.mergedAt is invalid');
  return result;
}

function validateRef(value: unknown, label: string): { repository: string; ref: string; sha: string } {
  const item = record(value, label);
  exactKeys(item, ['repository', 'ref', 'sha'], label);
  return {
    repository: stringValue(item.repository, `${label}.repository`),
    ref: stringValue(item.ref, `${label}.ref`),
    sha: stringValue(item.sha, `${label}.sha`)
  };
}

function validateReceipt(value: unknown): MutationReceipt {
  const item = record(value, 'receipt');
  exactKeys(item, ['remoteId', 'changed', 'operationId'], 'receipt');
  return {
    remoteId: stringValue(item.remoteId, 'receipt.remoteId'),
    changed: typeof item.changed === 'boolean' ? item.changed : (() => { throw new Error('receipt.changed is invalid'); })(),
    ...(item.operationId === undefined ? {} : { operationId: stringValue(item.operationId, 'receipt.operationId') })
  };
}

function validateMetadata(value: unknown): RepositoryMetadataSnapshot {
  const item = record(value, 'repository metadata');
  exactKeys(item, ['repository', 'labels', 'milestones', 'issueTypes', 'fields'], 'repository metadata');
  const repository = record(item.repository, 'metadata.repository');
  exactKeys(repository, ['identity', 'name', 'url'], 'metadata.repository');
  const mapFields = (raw: unknown, label: string) => arrayValue(raw, label).map((entry) => {
    const field = record(entry, label);
    exactKeys(field, ['identity', 'name', 'kind', 'options'], label);
    return {
      identity: identity(field.identity, `${label}.identity`),
      name: stringValue(field.name, `${label}.name`),
      kind: fieldKind(field.kind, `${label}.kind`),
      options: arrayValue(field.options, `${label}.options`).map((rawOption) => {
        const option = record(rawOption, `${label}.option`);
        exactKeys(option, ['identity', 'name'], `${label}.option`);
        return { identity: identity(option.identity, `${label}.option.identity`), name: stringValue(option.name, `${label}.option.name`) };
      })
    };
  });
  const fields = stableUnique(mapFields(item.fields, 'metadata.fields'), (entry) => JSON.stringify(entry.identity), 'metadata.fields');
  const issueTypes = stableUnique(arrayValue(item.issueTypes, 'metadata.issueTypes').map((raw, index) => {
    const issueType = record(raw, `metadata.issueTypes[${index}]`);
    exactKeys(issueType, ['identity', 'name', 'fields'], `metadata.issueTypes[${index}]`);
    return { identity: identity(issueType.identity, `metadata.issueTypes[${index}].identity`), name: stringValue(issueType.name, `metadata.issueTypes[${index}].name`), fields: stableUnique(mapFields(issueType.fields, `metadata.issueTypes[${index}].fields`), (entry) => JSON.stringify(entry.identity), `metadata.issueTypes[${index}].fields`) };
  }), (entry) => JSON.stringify(entry.identity), 'metadata.issueTypes');
  return {
    repository: { identity: identity(repository.identity, 'metadata.repository.identity'), name: stringValue(repository.name, 'metadata.repository.name'), url: repository.url === null ? null : stringValue(repository.url, 'metadata.repository.url') },
    labels: stableUnique(arrayValue(item.labels, 'metadata.labels').map((raw) => {
      const label = record(raw, 'metadata.label');
      exactKeys(label, ['identity', 'name'], 'metadata.label');
      return { identity: identity(label.identity, 'metadata.label.identity'), name: stringValue(label.name, 'metadata.label.name') };
    }), (entry) => JSON.stringify(entry.identity), 'metadata.labels'),
    milestones: stableUnique(arrayValue(item.milestones, 'metadata.milestones').map((raw) => {
      const milestone = record(raw, 'metadata.milestone');
      exactKeys(milestone, ['identity', 'title', 'state'], 'metadata.milestone');
      if (milestone.state !== 'open' && milestone.state !== 'closed') throw new Error('metadata.milestone.state is invalid');
      return { identity: identity(milestone.identity, 'metadata.milestone.identity'), title: stringValue(milestone.title, 'metadata.milestone.title'), state: milestone.state };
    }), (entry) => JSON.stringify(entry.identity), 'metadata.milestones'),
    issueTypes,
    fields
  };
}

function validateReleaseNotes(value: unknown): ReleaseNotesFacts {
  const item = record(value, 'release notes');
  exactKeys(item, ['history', 'mergedPullRequests', 'closingIssues', 'actors'], 'release notes');
  return {
    history: stableUnique(arrayValue(item.history, 'release notes.history').map((raw) => {
      const entry = record(raw, 'release notes.history[]');
      exactKeys(entry, ['sha', 'message', 'authoredAt', 'author'], 'release notes.history[]');
      return { sha: stringValue(entry.sha, 'history.sha'), message: stringValue(entry.message, 'history.message', true), authoredAt: utcTimestamp(entry.authoredAt, 'history.authoredAt'), author: author(entry.author, 'history.author') };
    }), (entry) => entry.sha, 'release notes.history'),
    mergedPullRequests: stableUnique(arrayValue(item.mergedPullRequests, 'release notes.mergedPullRequests').map(validateChangeRequest), (entry) => JSON.stringify(entry.identity || { kind: 'id', value: entry.id }), 'release notes.mergedPullRequests'),
    closingIssues: stableUnique(arrayValue(item.closingIssues, 'release notes.closingIssues').map(validateIssue), (entry) => JSON.stringify(entry.identity || { kind: 'id', value: entry.id }), 'release notes.closingIssues'),
    actors: stableUnique(arrayValue(item.actors, 'release notes.actors').map((entry) => {
      const actor = author(entry, 'release notes.actor');
      if (!actor) throw new Error('release notes.actor must identify an actor');
      return actor;
    }), (entry) => entry.id || entry.name || '', 'release notes.actors')
  };
}

function utcTimestamp(value: unknown, label: string): string {
  const result = timestamp(value, label);
  if (!result.endsWith('Z')) throw new Error(`${label} must be UTC`);
  return new Date(result).toISOString();
}

const PROVIDER_ERROR_CATALOG: Readonly<Record<string, { message: string; retryable: boolean }>> = {
  AUTH_REQUIRED: { message: 'Platform authentication is required', retryable: false },
  PERMISSION_DENIED: { message: 'Platform permission was denied', retryable: false },
  PLATFORM_DEPENDENCY_MISSING: { message: 'A platform dependency is unavailable', retryable: false },
  PLATFORM_OUTPUT_TOO_LARGE: { message: 'Platform output exceeded the configured limit', retryable: false },
  PLATFORM_CAPABILITY_UNSUPPORTED: { message: 'Platform capability is unsupported', retryable: false },
  PLATFORM_UNSUPPORTED: { message: 'The configured platform is unsupported', retryable: false },
  REMOTE_MISSING: { message: 'The platform remote is not configured', retryable: false },
  REMOTE_INVALID: { message: 'The platform remote is invalid', retryable: false },
  UPSTREAM_UNRESOLVED: { message: 'The platform upstream repository could not be resolved', retryable: false },
  RESOURCE_NOT_FOUND: { message: 'The platform resource was not found', retryable: false },
  PR_NOT_FOUND: { message: 'The pull request was not found', retryable: false },
  ISSUE_NOT_FOUND: { message: 'The issue was not found', retryable: false },
  REMOTE_BUSY: { message: 'Platform provider is temporarily busy', retryable: true },
  NETWORK_TRANSIENT: { message: 'The platform request failed temporarily', retryable: true },
  NETWORK_RETRY: { message: 'The platform request failed temporarily', retryable: true },
  NETWORK_RETRY_EXHAUSTED: { message: 'The platform request retries were exhausted', retryable: true },
  NETWORK_ERROR: { message: 'The platform request failed temporarily', retryable: true },
  INVALID_PLATFORM_RESPONSE: { message: 'The platform returned an invalid response', retryable: true },
  PLATFORM_REQUEST_INVALID: { message: 'The platform rejected the request', retryable: false },
  PLATFORM_REQUEST_FAILED: { message: 'The platform request failed', retryable: false },
  GH_CLI_VERSION_INVALID: { message: 'The platform CLI returned an invalid version', retryable: false },
  GH_CLI_VERSION_UNSUPPORTED: { message: 'The installed GitHub CLI version is unsupported', retryable: false },
  PR_HEAD_INVALID: { message: 'The pull request head is invalid', retryable: false },
  PR_REMOTE_BRANCH_MISSING: { message: 'The pull request remote branch is missing', retryable: false },
  PR_REMOTE_BRANCH_UNAVAILABLE: { message: 'The pull request remote branch could not be inspected', retryable: true },
  PR_LOCAL_HEAD_UNAVAILABLE: { message: 'The local pull request head could not be inspected', retryable: false },
  PR_REMOTE_HEAD_MISMATCH: { message: 'The pull request remote head does not match the local head', retryable: false },
  PR_MERGE_EVIDENCE_SOURCE_UNAVAILABLE: { message: 'Pull request merge evidence is unavailable', retryable: false },
  PR_CREATE_RESPONSE_INVALID: { message: 'Pull request creation returned an invalid response', retryable: false },
  PR_NUMBER_INVALID: { message: 'The pull request number is invalid', retryable: false },
  ISSUE_NUMBER_INVALID: { message: 'The issue number is invalid', retryable: false },
  ISSUE_CREATE_RESPONSE_INVALID: { message: 'Issue creation returned an invalid response', retryable: false },
  COMMENT_ID_INVALID: { message: 'The comment identity is invalid', retryable: false },
  MILESTONE_IDENTITY_INVALID: { message: 'The milestone identity is invalid', retryable: false },
  CHECK_RUN_NOT_FOUND: { message: 'The check run was not found', retryable: false },
  RELEASE_NOTES_AUTHORS_TRUNCATED: { message: 'Release note commit authors exceeded the supported limit', retryable: false },
  RELEASE_NOTES_COLLECTION_FAILED: { message: 'Release notes could not be collected', retryable: false },
  RELEASE_NOTES_PUBLISH_FAILED: { message: 'Release notes could not be published', retryable: false },
  PAGINATION_INVALID: { message: 'Platform pagination is invalid', retryable: false },
  PAGINATION_UNSTABLE: { message: 'Platform pagination is unstable', retryable: true },
  PLATFORM_PROVIDER_OPERATION_FAILED: { message: 'Platform provider operation failed', retryable: false }
};

function safeProviderError(providerType: string, operation: string, value: unknown): PlatformError {
  const item = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const definition = typeof item.code === 'string' ? PROVIDER_ERROR_CATALOG[item.code] : undefined;
  return {
    code: definition ? item.code as string : 'PLATFORM_PROVIDER_OPERATION_FAILED',
    message: definition?.message || PROVIDER_ERROR_CATALOG.PLATFORM_PROVIDER_OPERATION_FAILED!.message,
    retryable: definition?.retryable || false,
    providerType,
    phase: operation
  };
}

function validators(providerType: string): Record<string, ResultValidator<unknown>> {
  return {
    'context.resolve': (value) => validateContext(value, providerType),
    'issues.inspect': validateIssue,
    'issues.describeRepository': validateMetadata,
    'issues.create': validateReceipt,
    'issues.update': validateReceipt,
    'comments.list': (value) => arrayValue(value, 'comments').map(validateComment),
    'comments.write': validateReceipt,
    'comments.delete': validateReceipt,
    'changeRequests.verifyHead': (value) => {
      const item = record(value, 'change request head');
      exactKeys(item, ['sha'], 'change request head');
      return { sha: stringValue(item.sha, 'change request head.sha') };
    },
    'changeRequests.inspect': validateChangeRequest,
    'changeRequests.listClosing': (value) => arrayValue(value, 'changeRequests').map(validateChangeRequest),
    'changeRequests.create': validateReceipt,
    'changeRequests.update': validateReceipt,
    'changeRequests.resolveGitEvidence': (value) => {
      const item = record(value, 'git evidence');
      exactKeys(item, ['remoteUrl', 'reviewedHeadRef', 'targetHeadRef'], 'git evidence');
      return { remoteUrl: stringValue(item.remoteUrl, 'git evidence.remoteUrl'), reviewedHeadRef: stringValue(item.reviewedHeadRef, 'git evidence.reviewedHeadRef'), targetHeadRef: stringValue(item.targetHeadRef, 'git evidence.targetHeadRef') } satisfies GitEvidenceSnapshot;
    },
    'checks.inspectRequired': (value) => arrayValue(value, 'checks').map((entry) => {
      const item = record(entry, 'check');
      exactKeys(item, ['name', 'status', 'conclusion', 'detailsUrl', 'runId', 'jobId'], 'check');
      return { name: stringValue(item.name, 'check.name'), status: stringValue(item.status, 'check.status'), ...(item.conclusion === undefined ? {} : { conclusion: item.conclusion === null ? null : stringValue(item.conclusion, 'check.conclusion') }), ...(item.detailsUrl === undefined ? {} : { detailsUrl: item.detailsUrl === null ? null : stringValue(item.detailsUrl, 'check.detailsUrl') }), ...(item.runId === undefined ? {} : { runId: stringValue(item.runId, 'check.runId') }), ...(item.jobId === undefined ? {} : { jobId: stringValue(item.jobId, 'check.jobId') }) } satisfies RequiredCheckSnapshot;
    }),
    'checks.resolveRun': (value) => {
      const item = record(value, 'check run');
      exactKeys(item, ['name', 'status', 'runId', 'conclusion', 'detailsUrl', 'jobId'], 'check run');
      return { name: stringValue(item.name, 'check run.name', true), status: stringValue(item.status, 'check run.status'), runId: stringValue(item.runId, 'check run.runId'), ...(item.conclusion === undefined ? {} : { conclusion: item.conclusion === null ? null : stringValue(item.conclusion, 'check run.conclusion') }), ...(item.detailsUrl === undefined ? {} : { detailsUrl: item.detailsUrl === null ? null : stringValue(item.detailsUrl, 'check run.detailsUrl') }), ...(item.jobId === undefined ? {} : { jobId: stringValue(item.jobId, 'check run.jobId') }) } satisfies CheckRunSnapshot;
    },
    'checks.fetchLogs': (value) => {
      const item = record(value, 'check log');
      exactKeys(item, ['runId', 'jobId', 'text'], 'check log');
      return { runId: stringValue(item.runId, 'check log.runId'), ...(item.jobId === undefined ? {} : { jobId: stringValue(item.jobId, 'check log.jobId') }), text: stringValue(item.text, 'check log.text', true) } satisfies CheckLogSnapshot;
    },
    'reviews.list': (value) => arrayValue(value, 'reviews').map((entry) => {
      const item = record(entry, 'review');
      exactKeys(item, ['id', 'author', 'body', 'state', 'submittedAt', 'commitSha', 'displayUrl'], 'review');
      return { id: stringValue(item.id, 'review.id'), author: author(item.author, 'review.author'), body: stringValue(item.body, 'review.body', true), state: stringValue(item.state, 'review.state'), submittedAt: utcTimestamp(item.submittedAt, 'review.submittedAt'), ...(item.commitSha === undefined ? {} : { commitSha: stringValue(item.commitSha, 'review.commitSha') }), ...(item.displayUrl === undefined ? {} : { displayUrl: stringValue(item.displayUrl, 'review.displayUrl') }) } satisfies ReviewSnapshot;
    }),
    'reviews.publish': validateReceipt,
    'releases.inspect': (value) => {
      const item = record(value, 'release');
      exactKeys(item, ['id', 'tag', 'title', 'body', 'draft', 'prerelease', 'publishedAt', 'milestone', 'displayUrl', 'workflows'], 'release');
      return { id: stringValue(item.id, 'release.id'), tag: stringValue(item.tag, 'release.tag'), title: stringValue(item.title, 'release.title', true), body: stringValue(item.body, 'release.body', true), draft: booleanValue(item.draft, 'release.draft'), prerelease: booleanValue(item.prerelease, 'release.prerelease'), publishedAt: item.publishedAt === null ? null : utcTimestamp(item.publishedAt, 'release.publishedAt'), ...(item.milestone === undefined ? {} : { milestone: nullableString(item.milestone, 'release.milestone') }), ...(item.displayUrl === undefined ? {} : { displayUrl: stringValue(item.displayUrl, 'release.displayUrl') }), ...(item.workflows === undefined ? {} : { workflows: arrayValue(item.workflows, 'release.workflows').map((entry) => jsonObject(entry, 'release.workflow')) }) } satisfies ReleaseSnapshot;
    },
    'releases.create': validateReceipt,
    'releases.update': validateReceipt,
    'releases.reconcileMilestones': (value) => {
      const item = record(value, 'milestone reconciliation');
      exactKeys(item, ['changed', 'created', 'closed'], 'milestone reconciliation');
      return { changed: booleanValue(item.changed, 'milestone reconciliation.changed'), created: arrayValue(item.created, 'created').map((entry) => stringValue(entry, 'created[]')), closed: arrayValue(item.closed, 'closed').map((entry) => stringValue(entry, 'closed[]')) } satisfies MilestoneReconciliation;
    },
    'releases.publishNotes': validateReceipt,
    'releases.collectNotes': validateReleaseNotes,
    'verification.fetchRemoteFacts': (value) => {
      const item = record(value, 'verification facts');
      exactKeys(item, ['issue', 'comments', 'changeRequest', 'commit', 'fields'], 'verification facts');
      const commit = item.commit === undefined ? undefined : item.commit === null ? null : (() => {
        const value = record(item.commit, 'verification.commit');
        exactKeys(value, ['sha', 'message'], 'verification.commit');
        return { sha: stringValue(value.sha, 'verification.commit.sha'), ...(value.message === undefined ? {} : { message: stringValue(value.message, 'verification.commit.message', true) }) };
      })();
      return { issue: item.issue === undefined ? undefined : item.issue === null ? null : validateIssue(item.issue), comments: arrayValue(item.comments, 'verification.comments').map(validateComment), changeRequest: item.changeRequest === undefined ? undefined : item.changeRequest === null ? null : validateChangeRequest(item.changeRequest), commit, fields: scalarFields(item.fields, 'verification.fields') } satisfies VerificationRemoteFacts;
    }
  };
}

async function invokeProviderOperation<T>(
  providerType: string,
  operation: string,
  call: () => Promise<unknown>,
  validate: ResultValidator<T>
): Promise<ProviderResult<T>> {
  try {
    const raw = await call();
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: validationError(providerType, operation, 'Provider operation returned an invalid result envelope') };
    const envelope = raw as Record<string, unknown>;
    if (envelope.ok === true) {
      try {
        exactKeys(envelope, ['ok', 'value'], `${operation} result`);
        return { ok: true, value: validate(envelope.value) };
      } catch {
        return { ok: false, error: validationError(providerType, operation, 'Provider operation returned an invalid value') };
      }
    }
    if (envelope.ok === false && envelope.error && typeof envelope.error === 'object' && !Array.isArray(envelope.error)) {
      try {
        exactKeys(envelope, ['ok', 'error'], `${operation} result`);
        const error = envelope.error as Record<string, unknown>;
        exactKeys(error, ['code', 'message', 'retryable'], `${operation} error`);
        if (typeof error.code !== 'string' || !error.code || typeof error.message !== 'string' || !error.message || typeof error.retryable !== 'boolean') throw new Error('invalid provider error');
        return { ok: false, error: safeProviderError(providerType, operation, error) };
      } catch {
        return { ok: false, error: validationError(providerType, operation, 'Provider operation returned an invalid error') };
      }
    }
    return { ok: false, error: validationError(providerType, operation, 'Provider operation returned an invalid result envelope') };
  } catch {
    return { ok: false, error: validationError(providerType, operation, 'Platform provider operation failed', 'PLATFORM_PROVIDER_OPERATION_FAILED') };
  }
}

function wrapProviderOperations(provider: PlatformProvider): PlatformProvider {
  const map = validators(provider.type);
  const wrapped: PlatformProvider = { ...provider, context: { ...provider.context } };
  wrapped.context.resolve = (input) => invokeProviderOperation(provider.type, 'context.resolve', () => provider.context.resolve(input), map['context.resolve']! as ResultValidator<PlatformContextSnapshot>);
  for (const groupName of ['issues', 'comments', 'changeRequests', 'checks', 'reviews', 'releases', 'verification'] as const) {
    const group = provider[groupName];
    if (!group) continue;
    const target: Record<string, unknown> = { ...group };
    for (const method of Object.keys(group)) {
      const operation = `${groupName}.${method}`;
      const validator = map[operation];
      if (!validator) throw new Error(`Missing validator for ${operation}`);
      const original = group[method as keyof typeof group] as (...args: never[]) => Promise<unknown>;
      target[method] = (input: unknown) => invokeProviderOperation(provider.type, operation, () => original(input as never), validator);
    }
    (wrapped as unknown as Record<string, unknown>)[groupName] = target;
  }
  return wrapped;
}

export { invokeProviderOperation, validationError, wrapProviderOperations };
