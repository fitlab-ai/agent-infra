import type {
  PlatformResourceKind,
  ProviderIdentityDeclaration,
  ResourceIdentity
} from './resource-identity.ts';

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

type PlatformError = {
  code: string;
  message: string;
  retryable: boolean;
  providerType?: string;
  phase?: string;
};

type ProviderResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: PlatformError };

type ProviderOperationContext = {
  repositoryRoot: string;
  workingDirectory: string;
  scopeId: string;
  scopeLabel?: string;
};

type MutationIdentity = {
  idempotencyKey: string;
  target?: ResourceIdentity;
};

type PlatformCapabilities = {
  authenticated: boolean;
  comment: boolean;
  triage: boolean;
  push: boolean;
  admin: boolean;
};

type PlatformContextSnapshot = {
  type: string;
  scope: { id: string; label?: string };
  currentUser: { id?: string; name?: string } | null;
  capabilities: PlatformCapabilities;
  authenticated: boolean;
  metadata?: Readonly<Record<string, JsonValue>>;
};

type IssueSnapshot = {
  id: string;
  identity?: ResourceIdentity;
  number?: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  assignees: string[];
  milestone: string | null;
  fields: Record<string, string | number | null>;
  issueType?: {
    identity: ResourceIdentity;
    name: string;
    fields: Array<{
      identity: ResourceIdentity;
      name: string;
      kind: 'single-select' | 'date' | 'text' | 'number';
      options: Array<{ identity: ResourceIdentity; name: string }>;
    }>;
  } | null;
  author?: { id?: string; name?: string } | null;
  displayUrl?: string;
};

type RemoteCommentSnapshot = {
  id: string;
  author: { id?: string; name?: string } | null;
  body: string;
  createdAt: string;
  updatedAt: string;
};

type ChangeRequestSnapshot = {
  id: string;
  identity?: ResourceIdentity;
  number?: number;
  state: string;
  title: string;
  body: string;
  baseSha?: string;
  headSha?: string;
  author?: { id?: string; name?: string } | null;
  mergedAt?: string | null;
  displayUrl?: string;
  draft?: boolean;
  labels?: string[];
  assignees?: string[];
  milestone?: string | null;
  mergeCommitSha?: string | null;
  mergeability?: { state: 'mergeable' | 'conflicting' | 'unknown'; detail: string | null };
  head?: { repository: string; ref: string; sha: string };
  base?: { repository: string; ref: string; sha: string };
};

type GitEvidenceSnapshot = {
  remoteUrl: string;
  reviewedHeadRef: string;
  targetHeadRef: string;
};

type RequiredCheckSnapshot = {
  name: string;
  status: string;
  conclusion?: string | null;
  detailsUrl?: string | null;
  runId?: string;
  jobId?: string;
};

type CheckRunSnapshot = RequiredCheckSnapshot & {
  runId: string;
};

type CheckLogSnapshot = {
  runId: string;
  jobId?: string;
  text: string;
};

type ReviewSnapshot = {
  id: string;
  author: { id?: string; name?: string } | null;
  body: string;
  state: string;
  submittedAt: string;
  commitSha?: string;
  displayUrl?: string;
};

type ReleaseSnapshot = {
  id: string;
  tag: string;
  title: string;
  body: string;
  draft: boolean;
  prerelease: boolean;
  publishedAt: string | null;
  milestone?: string | null;
  displayUrl?: string;
  workflows?: Array<Record<string, JsonValue>>;
};

type MutationReceipt = {
  remoteId: string;
  changed: boolean;
  operationId?: string;
};

type RepositoryMetadataSnapshot = {
  repository: { identity: ResourceIdentity; name: string; url: string | null };
  labels: Array<{ identity: ResourceIdentity; name: string }>;
  milestones: Array<{ identity: ResourceIdentity; title: string; state: 'open' | 'closed' }>;
  issueTypes: Array<{
    identity: ResourceIdentity;
    name: string;
    fields: Array<{
      identity: ResourceIdentity;
      name: string;
      kind: 'single-select' | 'date' | 'text' | 'number';
      options: Array<{ identity: ResourceIdentity; name: string }>;
    }>;
  }>;
  fields: Array<{
    identity: ResourceIdentity;
    name: string;
    kind: 'single-select' | 'date' | 'text' | 'number';
    options: Array<{ identity: ResourceIdentity; name: string }>;
  }>;
};

type ReleaseNotesFacts = {
  history: Array<{
    sha: string;
    message: string;
    authoredAt: string;
    author: { id?: string; name?: string } | null;
  }>;
  mergedPullRequests: Array<ChangeRequestSnapshot>;
  closingIssues: Array<IssueSnapshot>;
  actors: Array<{ id?: string; name?: string }>;
};

type MilestoneReconciliation = {
  changed: boolean;
  created: string[];
  closed: string[];
};

type VerificationRemoteFacts = {
  issue?: IssueSnapshot | null;
  comments: RemoteCommentSnapshot[];
  changeRequest?: ChangeRequestSnapshot | null;
  commit?: { sha: string; message?: string } | null;
  fields: Record<string, string | number | null>;
};

type PlatformProviderFactoryInput = {
  providerType: string;
  contractVersion: 1;
  repositoryRoot: string;
  config: Readonly<Record<string, JsonValue>>;
};

type PlatformProvider = {
  type: string;
  contractVersion: 1;
  identity?: ProviderIdentityDeclaration;
  context: {
    resolve(input: {
      repositoryRoot: string;
      workingDirectory: string;
      scopeId: string;
      scopeLabel?: string;
      gitRemote: string | null;
    }): Promise<ProviderResult<PlatformContextSnapshot>>;
  };
  issues?: {
    describeRepository(input: { context: ProviderOperationContext }): Promise<ProviderResult<RepositoryMetadataSnapshot>>;
    inspect(input: { context: ProviderOperationContext; target: ResourceIdentity }): Promise<ProviderResult<IssueSnapshot>>;
    create(input: {
      context: ProviderOperationContext;
      desired: {
        title: string;
        body: string;
        labels: string[];
        assignees: string[];
        milestone: string | null;
        fields: Record<string, string | number | null>;
      };
      mutation: MutationIdentity;
    }): Promise<ProviderResult<MutationReceipt>>;
    update(input: {
      context: ProviderOperationContext;
      target: ResourceIdentity;
      patch: Partial<{
        title: string;
        body: string;
        labels: string[];
        assignees: string[];
        milestone: string | null;
        state: 'open' | 'closed';
        fields: Record<string, string | number | null>;
        issueType?: string | null;
      }>;
      mutation: MutationIdentity;
    }): Promise<ProviderResult<MutationReceipt>>;
  };
  comments?: {
    list(input: { context: ProviderOperationContext; parent: ResourceIdentity }): Promise<ProviderResult<RemoteCommentSnapshot[]>>;
    write(input: {
      context: ProviderOperationContext;
      parent: ResourceIdentity;
      body: string;
      existingComment?: ResourceIdentity;
      mutation: MutationIdentity;
    }): Promise<ProviderResult<MutationReceipt>>;
    delete(input: {
      context: ProviderOperationContext;
      parent: ResourceIdentity;
      comment: ResourceIdentity;
      mutation: MutationIdentity;
    }): Promise<ProviderResult<MutationReceipt>>;
  };
  changeRequests?: {
    verifyHead?(input: {
      context: ProviderOperationContext;
      head: string;
    }): Promise<ProviderResult<{ sha: string }>>;
    inspect(input: { context: ProviderOperationContext; target: ResourceIdentity }): Promise<ProviderResult<ChangeRequestSnapshot>>;
    listClosing(input: { context: ProviderOperationContext; issue: ResourceIdentity }): Promise<ProviderResult<ChangeRequestSnapshot[]>>;
    create(input: {
      context: ProviderOperationContext;
      base: string;
      head: string;
      title: string;
      body: string;
      draft: boolean;
      mutation: MutationIdentity;
    }): Promise<ProviderResult<MutationReceipt>>;
    update(input: {
      context: ProviderOperationContext;
      target: ResourceIdentity;
      patch: Partial<{
        title: string;
        body: string;
        base: string;
        state: string;
        labels: string[];
        assignees: string[];
        milestone: string | null;
      }>;
      mutation: MutationIdentity;
    }): Promise<ProviderResult<MutationReceipt>>;
    resolveGitEvidence(input: {
      context: ProviderOperationContext;
      target: ResourceIdentity;
      expected: { baseSha?: string; headSha?: string; targetBranch?: string };
    }): Promise<ProviderResult<GitEvidenceSnapshot>>;
  };
  checks?: {
    inspectRequired(input: {
      context: ProviderOperationContext;
      changeRequest: ResourceIdentity;
      headSha?: string;
    }): Promise<ProviderResult<RequiredCheckSnapshot[]>>;
    resolveRun(input: {
      context: ProviderOperationContext;
      changeRequest: ResourceIdentity;
      checkName: string;
      detailsUrl?: string;
    }): Promise<ProviderResult<CheckRunSnapshot>>;
    fetchLogs(input: {
      context: ProviderOperationContext;
      runId: string;
      jobId?: string;
    }): Promise<ProviderResult<CheckLogSnapshot>>;
  };
  reviews?: {
    list(input: { context: ProviderOperationContext; changeRequest: ResourceIdentity }): Promise<ProviderResult<ReviewSnapshot[]>>;
    publish(input: {
      context: ProviderOperationContext;
      changeRequest: ResourceIdentity;
      identity: { scope: string; round: number; commitSha: string; resource?: ResourceIdentity };
      event: 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES';
      body: string;
      mutation: MutationIdentity;
    }): Promise<ProviderResult<MutationReceipt>>;
  };
  releases?: {
    inspect(input: { context: ProviderOperationContext; tag: string }): Promise<ProviderResult<ReleaseSnapshot>>;
    create(input: {
      context: ProviderOperationContext;
      tag: string;
      title: string;
      notes?: { text: string; sha256: string; byteLength: number };
      mutation: MutationIdentity;
    }): Promise<ProviderResult<MutationReceipt>>;
    update(input: {
      context: ProviderOperationContext;
      release: ResourceIdentity;
      patch: Partial<{ tag: string; title: string; body: string; draft: boolean; prerelease: boolean }>;
      mutation: MutationIdentity;
    }): Promise<ProviderResult<MutationReceipt>>;
    reconcileMilestones(input: {
      context: ProviderOperationContext;
      version: string;
      desired: Array<{ key: string; title: string; description: string; state: 'open' | 'closed' }>;
      mutation: MutationIdentity;
    }): Promise<ProviderResult<MilestoneReconciliation>>;
    publishNotes(input: {
      context: ProviderOperationContext;
      release: ResourceIdentity;
      title: string;
      notes: { text: string; sha256: string; byteLength: number };
      mutation: MutationIdentity;
    }): Promise<ProviderResult<MutationReceipt>>;
    collectNotes(input: {
      context: ProviderOperationContext;
      fromTime: string;
      toTime: string;
      commitOids: string[];
      branch: string;
      historyLimit: number;
    }): Promise<ProviderResult<ReleaseNotesFacts>>;
  };
  verification?: {
    fetchRemoteFacts(input: {
      context: ProviderOperationContext;
      taskId: string;
      issue?: ResourceIdentity;
      changeRequest?: ResourceIdentity;
      includeComments: boolean;
      includeFields: boolean;
    }): Promise<ProviderResult<VerificationRemoteFacts>>;
  };
};

type PlatformProviderFactory = (
  input: PlatformProviderFactoryInput
) => Promise<PlatformProvider>;

const PLATFORM_PROVIDER_CONTRACT_VERSION = 1 as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isPlatformProviderFactory(value: unknown): value is PlatformProviderFactory {
  return typeof value === 'function';
}

function validatePlatformProvider(
  value: unknown,
  providerType: string
): ProviderResult<PlatformProvider> {
  const operationGroups: Record<string, { required: string[]; optional: string[] }> = {
    issues: { required: ['inspect', 'create', 'update', 'describeRepository'], optional: [] },
    comments: { required: ['list', 'write', 'delete'], optional: [] },
    changeRequests: { required: ['inspect', 'listClosing', 'create', 'update', 'resolveGitEvidence'], optional: ['verifyHead'] },
    checks: { required: ['inspectRequired', 'resolveRun', 'fetchLogs'], optional: [] },
    reviews: { required: ['list', 'publish'], optional: [] },
    releases: { required: ['inspect', 'create', 'update', 'reconcileMilestones', 'publishNotes', 'collectNotes'], optional: [] },
    verification: { required: ['fetchRemoteFacts'], optional: [] }
  };
  const resourceKindsByGroup: Record<string, PlatformResourceKind[]> = {
    issues: ['issue'],
    comments: ['issue', 'pull-request', 'comment'],
    changeRequests: ['issue', 'pull-request'],
    checks: ['pull-request'],
    reviews: ['pull-request'],
    releases: ['release', 'issue', 'pull-request'],
    verification: ['issue', 'pull-request']
  };
  if (!isRecord(value)
    || value.type !== providerType
    || value.contractVersion !== PLATFORM_PROVIDER_CONTRACT_VERSION
    || !isRecord(value.context)
    || typeof value.context.resolve !== 'function') {
    return {
      ok: false,
      error: {
        code: 'PLATFORM_PROVIDER_CONTRACT_INVALID',
        message: 'Provider must expose matching type, contractVersion, and context.resolve',
        retryable: false,
        providerType,
        phase: 'provider-validation'
      }
    };
  }
  if (value.identity !== undefined) {
    if (!isRecord(value.identity) || Object.entries(value.identity).some(([resourceKind, kind]) =>
      !(['issue', 'pull-request', 'comment', 'release'] as PlatformResourceKind[]).includes(resourceKind as PlatformResourceKind)
      || !(['id', 'number', 'key'] as const).includes(kind as 'id' | 'number' | 'key')
    )) {
      return {
        ok: false,
        error: {
          code: 'PLATFORM_PROVIDER_CONTRACT_INVALID',
          message: 'Provider identity declaration is invalid',
          retryable: false,
          providerType,
          phase: 'provider-validation'
        }
      };
    }
  }
  for (const [groupName, groupDefinition] of Object.entries(operationGroups)) {
    const group = value[groupName];
    if (group !== undefined && (!isRecord(group)
      || groupDefinition.required.some((method) => typeof group[method] !== 'function')
      || Object.keys(group).some((method) => ![...groupDefinition.required, ...groupDefinition.optional].includes(method)))) {
      return {
        ok: false,
        error: {
          code: 'PLATFORM_PROVIDER_CONTRACT_INVALID',
          message: `Provider operation group ${groupName} is incomplete`,
          retryable: false,
          providerType,
          phase: 'provider-validation'
        }
      };
    }
    if (group !== undefined) {
      for (const resourceKind of resourceKindsByGroup[groupName] || []) {
        const declaration = isRecord(value.identity) ? value.identity[resourceKind] : undefined;
        if (declaration !== 'id' && declaration !== 'number' && declaration !== 'key') {
          return {
            ok: false,
            error: {
              code: 'PLATFORM_PROVIDER_CONTRACT_INVALID',
              message: `Provider operation group ${groupName} requires an identity declaration for ${resourceKind}`,
              retryable: false,
              providerType,
              phase: 'provider-validation'
            }
          };
        }
      }
    }
  }
  return { ok: true, value: value as unknown as PlatformProvider };
}

export {
  PLATFORM_PROVIDER_CONTRACT_VERSION,
  isPlatformProviderFactory,
  validatePlatformProvider
};

export type {
  ChangeRequestSnapshot,
  CheckLogSnapshot,
  CheckRunSnapshot,
  GitEvidenceSnapshot,
  IssueSnapshot,
  JsonValue,
  MilestoneReconciliation,
  MutationIdentity,
  MutationReceipt,
  PlatformCapabilities,
  PlatformContextSnapshot,
  PlatformError,
  PlatformProvider,
  PlatformProviderFactory,
  PlatformProviderFactoryInput,
  ProviderOperationContext,
  ProviderResult,
  ReleaseSnapshot,
  RemoteCommentSnapshot,
  RequiredCheckSnapshot,
  RepositoryMetadataSnapshot,
  ReleaseNotesFacts,
  ResourceIdentity,
  ReviewSnapshot,
  VerificationRemoteFacts
};
