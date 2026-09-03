import {
  isResourceIdentity,
  parseResourceIdentity
} from './resource-identity.ts';
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

function identity(value: unknown, label: string): ReturnType<typeof parseResourceIdentity> {
  return parseResourceIdentity(value, label);
}

function author(value: unknown, label: string): { id?: string; name?: string } | null {
  if (value === null) return null;
  const item = record(value, label);
  const result: { id?: string; name?: string } = {};
  if (item.id !== undefined) result.id = stringValue(item.id, `${label}.id`);
  if (item.name !== undefined) result.name = stringValue(item.name, `${label}.name`);
  if (!result.id && !result.name) throw new Error(`${label} must identify an author`);
  return result;
}

function validateContext(value: unknown): PlatformContextSnapshot {
  const item = record(value, 'context');
  const scope = record(item.scope, 'context.scope');
  const capabilities = record(item.capabilities, 'context.capabilities');
  const capabilityNames = ['authenticated', 'comment', 'triage', 'push', 'admin'];
  if (capabilityNames.some((name) => typeof capabilities[name] !== 'boolean')) throw new Error('context.capabilities must contain booleans');
  if (typeof item.authenticated !== 'boolean') throw new Error('context.authenticated must be boolean');
  return {
    type: stringValue(item.type, 'context.type'),
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
    ...(item.metadata === undefined ? {} : { metadata: item.metadata as PlatformContextSnapshot['metadata'] })
  };
}

function validateIssue(value: unknown): IssueSnapshot {
  const item = record(value, 'issue');
  const result: IssueSnapshot = {
    id: item.id === undefined ? '' : stringValue(item.id, 'issue.id'),
    ...(item.identity === undefined ? {} : { identity: identity(item.identity, 'issue.identity') }),
    ...(item.number === undefined ? {} : { number: item.number as number }),
    title: stringValue(item.title, 'issue.title', true),
    body: stringValue(item.body, 'issue.body', true),
    state: item.state === 'closed' ? 'closed' : item.state === 'open' ? 'open' : (() => { throw new Error('issue.state is invalid'); })(),
    labels: arrayValue(item.labels, 'issue.labels').map((entry) => stringValue(entry, 'issue.labels[]')),
    assignees: arrayValue(item.assignees, 'issue.assignees').map((entry) => stringValue(entry, 'issue.assignees[]')),
    milestone: nullableString(item.milestone, 'issue.milestone'),
    fields: record(item.fields, 'issue.fields') as IssueSnapshot['fields'],
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
  const fields = arrayValue(item.fields, `${label}.fields`).map((rawField) => {
    const field = record(rawField, `${label}.field`);
    return {
      identity: identity(field.identity, `${label}.field.identity`),
      name: stringValue(field.name, `${label}.field.name`),
      kind: stringValue(field.kind, `${label}.field.kind`) as NonNullable<IssueSnapshot['issueType']>['fields'][number]['kind'],
      options: arrayValue(field.options, `${label}.field.options`).map((rawOption) => {
        const option = record(rawOption, `${label}.field.option`);
        return { identity: identity(option.identity, `${label}.field.option.identity`), name: stringValue(option.name, `${label}.field.option.name`) };
      })
    };
  });
  return { identity: identity(item.identity, `${label}.identity`), name: stringValue(item.name, `${label}.name`), fields };
}

function validateComment(value: unknown): RemoteCommentSnapshot {
  const item = record(value, 'comment');
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
  const result = {
    id: item.id === undefined ? '' : stringValue(item.id, 'changeRequest.id'),
    ...(item.identity === undefined ? {} : { identity: identity(item.identity, 'changeRequest.identity') }),
    ...(item.number === undefined ? {} : { number: item.number as number }),
    state: stringValue(item.state, 'changeRequest.state'),
    title: stringValue(item.title, 'changeRequest.title', true),
    body: stringValue(item.body, 'changeRequest.body', true),
    ...(item.baseSha === undefined ? {} : { baseSha: stringValue(item.baseSha, 'changeRequest.baseSha') }),
    ...(item.headSha === undefined ? {} : { headSha: stringValue(item.headSha, 'changeRequest.headSha') }),
    ...(item.author === undefined ? {} : { author: author(item.author, 'changeRequest.author') }),
    ...(item.mergedAt === undefined ? {} : { mergedAt: item.mergedAt === null ? null : utcTimestamp(item.mergedAt, 'changeRequest.mergedAt') }),
    ...(item.displayUrl === undefined ? {} : { displayUrl: stringValue(item.displayUrl, 'changeRequest.displayUrl') }),
    ...(item.draft === undefined ? {} : { draft: Boolean(item.draft) }),
    ...(item.labels === undefined ? {} : { labels: arrayValue(item.labels, 'changeRequest.labels').map((entry) => stringValue(entry, 'changeRequest.labels[]')) }),
    ...(item.assignees === undefined ? {} : { assignees: arrayValue(item.assignees, 'changeRequest.assignees').map((entry) => stringValue(entry, 'changeRequest.assignees[]')) }),
    ...(item.milestone === undefined ? {} : { milestone: nullableString(item.milestone, 'changeRequest.milestone') }),
    ...(item.mergeCommitSha === undefined ? {} : { mergeCommitSha: item.mergeCommitSha === null ? null : stringValue(item.mergeCommitSha, 'changeRequest.mergeCommitSha') }),
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
  return {
    repository: stringValue(item.repository, `${label}.repository`),
    ref: stringValue(item.ref, `${label}.ref`),
    sha: stringValue(item.sha, `${label}.sha`)
  };
}

function validateReceipt(value: unknown): MutationReceipt {
  const item = record(value, 'receipt');
  return {
    remoteId: stringValue(item.remoteId, 'receipt.remoteId'),
    changed: typeof item.changed === 'boolean' ? item.changed : (() => { throw new Error('receipt.changed is invalid'); })(),
    ...(item.operationId === undefined ? {} : { operationId: stringValue(item.operationId, 'receipt.operationId') })
  };
}

function validateMetadata(value: unknown): RepositoryMetadataSnapshot {
  const item = record(value, 'repository metadata');
  const repository = record(item.repository, 'metadata.repository');
  const mapFields = (raw: unknown, label: string) => arrayValue(raw, label).map((entry) => {
    const field = record(entry, label);
    return {
      identity: identity(field.identity, `${label}.identity`),
      name: stringValue(field.name, `${label}.name`),
      kind: stringValue(field.kind, `${label}.kind`) as 'single-select' | 'date' | 'text' | 'number',
      options: arrayValue(field.options, `${label}.options`).map((rawOption) => {
        const option = record(rawOption, `${label}.option`);
        return { identity: identity(option.identity, `${label}.option.identity`), name: stringValue(option.name, `${label}.option.name`) };
      })
    };
  });
  const fields = mapFields(item.fields, 'metadata.fields');
  const issueTypes = arrayValue(item.issueTypes, 'metadata.issueTypes').map((raw, index) => {
    const issueType = record(raw, `metadata.issueTypes[${index}]`);
    return { identity: identity(issueType.identity, `metadata.issueTypes[${index}].identity`), name: stringValue(issueType.name, `metadata.issueTypes[${index}].name`), fields: mapFields(issueType.fields, `metadata.issueTypes[${index}].fields`) };
  });
  return {
    repository: { identity: identity(repository.identity, 'metadata.repository.identity'), name: stringValue(repository.name, 'metadata.repository.name'), url: repository.url === null ? null : stringValue(repository.url, 'metadata.repository.url') },
    labels: arrayValue(item.labels, 'metadata.labels').map((raw) => {
      const label = record(raw, 'metadata.label');
      return { identity: identity(label.identity, 'metadata.label.identity'), name: stringValue(label.name, 'metadata.label.name') };
    }),
    milestones: arrayValue(item.milestones, 'metadata.milestones').map((raw) => {
      const milestone = record(raw, 'metadata.milestone');
      if (milestone.state !== 'open' && milestone.state !== 'closed') throw new Error('metadata.milestone.state is invalid');
      return { identity: identity(milestone.identity, 'metadata.milestone.identity'), title: stringValue(milestone.title, 'metadata.milestone.title'), state: milestone.state };
    }),
    issueTypes,
    fields
  };
}

function validateReleaseNotes(value: unknown): ReleaseNotesFacts {
  const item = record(value, 'release notes');
  return {
    history: arrayValue(item.history, 'release notes.history').map((raw) => {
      const entry = record(raw, 'release notes.history[]');
      return { sha: stringValue(entry.sha, 'history.sha'), message: stringValue(entry.message, 'history.message', true), authoredAt: utcTimestamp(entry.authoredAt, 'history.authoredAt'), author: author(entry.author, 'history.author') };
    }),
    mergedPullRequests: arrayValue(item.mergedPullRequests, 'release notes.mergedPullRequests').map(validateChangeRequest),
    closingIssues: arrayValue(item.closingIssues, 'release notes.closingIssues').map(validateIssue),
    actors: arrayValue(item.actors, 'release notes.actors').map((entry) => author(entry, 'release notes.actor')).filter((entry): entry is { id?: string; name?: string } => entry !== null)
  };
}

function utcTimestamp(value: unknown, label: string): string {
  const result = timestamp(value, label);
  if (!result.endsWith('Z')) throw new Error(`${label} must be UTC`);
  return new Date(result).toISOString();
}

function passthrough<T>(value: unknown): T {
  return value as T;
}

function validators(): Record<string, ResultValidator<unknown>> {
  return {
    'context.resolve': validateContext,
    'issues.inspect': validateIssue,
    'issues.describeRepository': validateMetadata,
    'issues.create': validateReceipt,
    'issues.update': validateReceipt,
    'comments.list': (value) => arrayValue(value, 'comments').map(validateComment),
    'comments.write': validateReceipt,
    'comments.delete': validateReceipt,
    'changeRequests.verifyHead': (value) => {
      const item = record(value, 'change request head');
      return { sha: stringValue(item.sha, 'change request head.sha') };
    },
    'changeRequests.inspect': validateChangeRequest,
    'changeRequests.listClosing': (value) => arrayValue(value, 'changeRequests').map(validateChangeRequest),
    'changeRequests.create': validateReceipt,
    'changeRequests.update': validateReceipt,
    'changeRequests.resolveGitEvidence': (value) => {
      const item = record(value, 'git evidence');
      return { remoteUrl: stringValue(item.remoteUrl, 'git evidence.remoteUrl'), reviewedHeadRef: stringValue(item.reviewedHeadRef, 'git evidence.reviewedHeadRef'), targetHeadRef: stringValue(item.targetHeadRef, 'git evidence.targetHeadRef') } satisfies GitEvidenceSnapshot;
    },
    'checks.inspectRequired': (value) => arrayValue(value, 'checks').map((entry) => {
      const item = record(entry, 'check');
      return { name: stringValue(item.name, 'check.name'), status: stringValue(item.status, 'check.status'), ...(item.conclusion === undefined ? {} : { conclusion: item.conclusion === null ? null : stringValue(item.conclusion, 'check.conclusion') }), ...(item.detailsUrl === undefined ? {} : { detailsUrl: item.detailsUrl === null ? null : stringValue(item.detailsUrl, 'check.detailsUrl') }), ...(item.runId === undefined ? {} : { runId: stringValue(item.runId, 'check.runId') }), ...(item.jobId === undefined ? {} : { jobId: stringValue(item.jobId, 'check.jobId') }) } satisfies RequiredCheckSnapshot;
    }),
    'checks.resolveRun': (value) => {
      const item = record(value, 'check run');
      return { name: stringValue(item.name, 'check run.name', true), status: stringValue(item.status, 'check run.status'), runId: stringValue(item.runId, 'check run.runId'), ...(item.conclusion === undefined ? {} : { conclusion: item.conclusion === null ? null : stringValue(item.conclusion, 'check run.conclusion') }), ...(item.detailsUrl === undefined ? {} : { detailsUrl: item.detailsUrl === null ? null : stringValue(item.detailsUrl, 'check run.detailsUrl') }), ...(item.jobId === undefined ? {} : { jobId: stringValue(item.jobId, 'check run.jobId') }) } satisfies CheckRunSnapshot;
    },
    'checks.fetchLogs': (value) => {
      const item = record(value, 'check log');
      return { runId: stringValue(item.runId, 'check log.runId'), ...(item.jobId === undefined ? {} : { jobId: stringValue(item.jobId, 'check log.jobId') }), text: stringValue(item.text, 'check log.text', true) } satisfies CheckLogSnapshot;
    },
    'reviews.list': (value) => arrayValue(value, 'reviews').map((entry) => {
      const item = record(entry, 'review');
      return { id: stringValue(item.id, 'review.id'), author: author(item.author, 'review.author'), body: stringValue(item.body, 'review.body', true), state: stringValue(item.state, 'review.state'), submittedAt: utcTimestamp(item.submittedAt, 'review.submittedAt'), ...(item.commitSha === undefined ? {} : { commitSha: stringValue(item.commitSha, 'review.commitSha') }), ...(item.displayUrl === undefined ? {} : { displayUrl: stringValue(item.displayUrl, 'review.displayUrl') }) } satisfies ReviewSnapshot;
    }),
    'reviews.publish': validateReceipt,
    'releases.inspect': (value) => {
      const item = record(value, 'release');
      return { id: stringValue(item.id, 'release.id'), tag: stringValue(item.tag, 'release.tag'), title: stringValue(item.title, 'release.title', true), body: stringValue(item.body, 'release.body', true), draft: Boolean(item.draft), prerelease: Boolean(item.prerelease), publishedAt: item.publishedAt === null ? null : utcTimestamp(item.publishedAt, 'release.publishedAt'), ...(item.milestone === undefined ? {} : { milestone: nullableString(item.milestone, 'release.milestone') }), ...(item.displayUrl === undefined ? {} : { displayUrl: stringValue(item.displayUrl, 'release.displayUrl') }), ...(item.workflows === undefined ? {} : { workflows: arrayValue(item.workflows, 'release.workflows').map((entry) => record(entry, 'release.workflow') as unknown as Record<string, JsonValue>) }) } satisfies ReleaseSnapshot;
    },
    'releases.create': validateReceipt,
    'releases.update': validateReceipt,
    'releases.reconcileMilestones': (value) => {
      const item = record(value, 'milestone reconciliation');
      return { changed: Boolean(item.changed), created: arrayValue(item.created, 'created').map((entry) => stringValue(entry, 'created[]')), closed: arrayValue(item.closed, 'closed').map((entry) => stringValue(entry, 'closed[]')) } satisfies MilestoneReconciliation;
    },
    'releases.publishNotes': validateReceipt,
    'releases.collectNotes': validateReleaseNotes,
    'verification.fetchRemoteFacts': (value) => {
      const item = record(value, 'verification facts');
      return { issue: item.issue === undefined ? undefined : item.issue === null ? null : validateIssue(item.issue), comments: arrayValue(item.comments, 'verification.comments').map(validateComment), changeRequest: item.changeRequest === undefined ? undefined : item.changeRequest === null ? null : validateChangeRequest(item.changeRequest), commit: item.commit === undefined ? undefined : item.commit === null ? null : record(item.commit, 'verification.commit') as VerificationRemoteFacts['commit'], fields: record(item.fields, 'verification.fields') as VerificationRemoteFacts['fields'] } satisfies VerificationRemoteFacts;
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
        return { ok: true, value: validate(envelope.value) };
      } catch {
        return { ok: false, error: validationError(providerType, operation, 'Provider operation returned an invalid value') };
      }
    }
    if (envelope.ok === false && envelope.error && typeof envelope.error === 'object' && !Array.isArray(envelope.error)) {
      const error = envelope.error as Record<string, unknown>;
      return {
        ok: false,
        error: {
          code: typeof error.code === 'string' && error.code ? error.code : 'PLATFORM_PROVIDER_OPERATION_FAILED',
          message: typeof error.message === 'string' && error.message ? error.message : 'Platform provider operation failed',
          retryable: error.retryable === true,
          providerType,
          phase: operation
        }
      };
    }
    return { ok: false, error: validationError(providerType, operation, 'Provider operation returned an invalid result envelope') };
  } catch {
    return { ok: false, error: validationError(providerType, operation, 'Platform provider operation failed', 'PLATFORM_PROVIDER_OPERATION_FAILED') };
  }
}

function wrapProviderOperations(provider: PlatformProvider): PlatformProvider {
  const map = validators();
  const wrapped: PlatformProvider = { ...provider, context: { ...provider.context } };
  wrapped.context.resolve = (input) => invokeProviderOperation(provider.type, 'context.resolve', () => provider.context.resolve(input), map['context.resolve']! as ResultValidator<PlatformContextSnapshot>);
  for (const groupName of ['issues', 'comments', 'changeRequests', 'checks', 'reviews', 'releases', 'verification'] as const) {
    const group = provider[groupName];
    if (!group) continue;
    const target: Record<string, unknown> = { ...group };
    for (const method of Object.keys(group)) {
      const operation = `${groupName}.${method}`;
      const validator = map[operation] || passthrough;
      const original = group[method as keyof typeof group] as (...args: never[]) => Promise<unknown>;
      target[method] = (input: unknown) => invokeProviderOperation(provider.type, operation, () => original(input as never), validator);
    }
    (wrapped as unknown as Record<string, unknown>)[groupName] = target;
  }
  return wrapped;
}

export { invokeProviderOperation, validationError, wrapProviderOperations };
