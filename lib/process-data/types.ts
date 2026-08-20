type JsonPrimitive = null | boolean | number | string;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

type Availability<T> =
  | { state: 'known'; value: T }
  | { state: 'unknown' | 'unavailable'; reason: string };

type SourceKind = 'local-file' | 'github-rest' | 'operational-report' | 'structured-telemetry';

type CaptureObjectRole = 'page-evidence' | 'resource';
type EndpointQueryMode = 'strict-since' | 'full-enumeration';

type PrivacyDisposition =
  | { state: 'included' }
  | { state: 'excluded-sensitive'; ruleId: string }
  | { state: 'unavailable'; reason: string };

type CapturedObject = {
  sourceKind: SourceKind;
  sourceIdentity: string;
  sha256: string;
  bytes: number;
  content?: string;
  disposition?: PrivacyDisposition;
  role?: CaptureObjectRole;
  resourceIdentity?: string;
  routeNumber?: number;
  eventTime?: string;
  endpoint?: string;
  page?: number;
  queryMode?: EndpointQueryMode;
  requestedSince?: string;
  responseDate?: string;
  pageSha256?: string;
  parentIdentity?: string;
};

type StoredObjectEvidence = Omit<CapturedObject, 'content'>;

type ResourceEvidenceRef = {
  resourceIdentity: string;
  resourceSha256: string;
  pageSha256: string;
};

type RestPageEvidence = {
  index: number;
  itemCount: number;
  canonicalSha256: string;
  queryMode?: EndpointQueryMode;
  requestedSince?: string;
  responseDate?: string;
  overlapItemCount?: number;
  acceptedItemCount?: number;
  deferredItemCount?: number;
};

type RestCollectionEvidence = {
  endpoint: string;
  requestCount: number;
  dataPageCount: number;
  itemCount: number;
  termination: 'short-page';
  pages: RestPageEvidence[];
  queryMode?: EndpointQueryMode;
  requestedSince?: string;
};

type NormalizedKind =
  | 'task'
  | 'artifact'
  | 'platform-resource'
  | 'lifecycle-event'
  | 'review-finding'
  | 'human-ruling'
  | 'telemetry'
  | 'operational-report'
  | 'missing'
  | 'conflict';

type NormalizedRecord = {
  recordId: string;
  kind: NormalizedKind;
  sourceIdentity: string;
  sourceSha256: string;
  binding?: string;
  observedAt?: Availability<string>;
  data?: JsonValue;
  resourceIdentity?: string;
  parentIdentity?: string;
  evidence?: ResourceEvidenceRef[];
  operation?: 'upsert' | 'supersede' | 'tombstone' | 'unavailable' | 'unchanged';
};

type QualityCategory =
  | 'missing-local'
  | 'missing-remote'
  | 'duplicate-identity'
  | 'binding-conflict'
  | 'content-mismatch'
  | 'schema-difference'
  | 'mutable-remote'
  | 'unrecoverable'
  | 'privacy-excluded';

type QualityFinding = {
  findingId: string;
  category: QualityCategory;
  severity: 'info' | 'warning' | 'error';
  identities: string[];
  repairable: boolean;
  reason: string;
};

type RepairAction = {
  repairId: string;
  operation: 'add' | 'supersede' | 'link';
  sourceRecordId: string;
  targetRecordId: string;
  preconditionSha256: string;
};

type SnapshotScope = 'all' | 'local' | 'github';

type SnapshotManifestV1 = {
  schema: 'raw-manifest/v1';
  snapshotId: string;
  scope: SnapshotScope;
  repository: string;
  observedFrom: string;
  observedTo: string;
  objects: StoredObjectEvidence[];
  endpoints: RestCollectionEvidence[];
  recordCount: number;
  findingCount: number;
  repairCount: number;
  privacyPolicyVersion: 'process-data-privacy/v1';
  excerptsEnabled: boolean;
  dispositionCounts: Record<'included' | 'excluded-sensitive' | 'unavailable', number>;
  manifestSha256: string;
};

type SnapshotWindow = {
  fromInclusive: string | null;
  queryAfter: string | null;
  toExclusive: string;
  precision: 'second';
};

type ObservationEvidence = {
  cutoffSource: 'github-response-date';
  preflightDate: string;
  responseDates: string[];
};

type CoverageEvidence = {
  mode: 'boundary-reread-with-full-reconcile';
  absoluteCompleteness: false;
};

type SnapshotOperations = {
  upsert: number;
  supersede: number;
  tombstone: number;
  unavailable: number;
};

type SnapshotManifestV2 = Omit<SnapshotManifestV1, 'schema' | 'observedFrom' | 'observedTo'> & {
  schema: 'raw-manifest/v2';
  snapshotKind: 'base' | 'delta';
  parentSnapshotId: string | null;
  checkpointBefore: string | null;
  watermark: string;
  window: SnapshotWindow;
  observation: ObservationEvidence;
  coverage: CoverageEvidence;
  reconciliation: 'incremental' | 'full';
  operations: SnapshotOperations;
  observedFrom: string;
  observedTo: string;
};

type SnapshotManifest = SnapshotManifestV1 | SnapshotManifestV2;

type CheckpointOwner = {
  schema: 'checkpoint-owner/v1';
  ownerId: string;
  pid: number;
  host: string;
  processStartToken: string;
  createdAt: string;
};

type GitHubCheckpoint = {
  schema: 'github-checkpoint/v1';
  repository: string;
  snapshotId: string;
  watermark: string;
  manifestSha256: string;
  committedAt: string;
};

type DeltaOperation = {
  operation: 'upsert' | 'supersede' | 'tombstone' | 'unavailable';
  resourceIdentity: string;
  previousSha256?: string;
  resourceSha256?: string;
  reason?: string;
};

type RecoveryReport = {
  recovered: boolean;
  quarantined: string[];
  reason?: string;
};

type ProcessDataError = {
  code: string;
  message: string;
  retryable?: boolean;
};

type ProcessResult<T> = { ok: true; value: T } | { ok: false; error: ProcessDataError };

export type {
  Availability,
  CapturedObject,
  JsonPrimitive,
  JsonValue,
  NormalizedKind,
  NormalizedRecord,
  PrivacyDisposition,
  ProcessDataError,
  ProcessResult,
  QualityCategory,
  QualityFinding,
  RepairAction,
  CaptureObjectRole,
  CheckpointOwner,
  CoverageEvidence,
  DeltaOperation,
  EndpointQueryMode,
  GitHubCheckpoint,
  ObservationEvidence,
  RecoveryReport,
  ResourceEvidenceRef,
  RestCollectionEvidence,
  RestPageEvidence,
  SnapshotManifest,
  SnapshotManifestV1,
  SnapshotManifestV2,
  SnapshotOperations,
  SnapshotScope,
  SnapshotWindow,
  SourceKind,
  StoredObjectEvidence
};
