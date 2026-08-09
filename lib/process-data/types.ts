type JsonPrimitive = null | boolean | number | string;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

type Availability<T> =
  | { state: 'known'; value: T }
  | { state: 'unknown' | 'unavailable'; reason: string };

type SourceKind = 'local-file' | 'github-rest' | 'operational-report' | 'structured-telemetry';

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
};

type StoredObjectEvidence = Omit<CapturedObject, 'content'>;

type RestPageEvidence = {
  index: number;
  itemCount: number;
  canonicalSha256: string;
};

type RestCollectionEvidence = {
  endpoint: string;
  requestCount: number;
  dataPageCount: number;
  itemCount: number;
  termination: 'short-page';
  pages: RestPageEvidence[];
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

type SnapshotManifest = {
  schema: 'raw-manifest/v1';
  snapshotId: string;
  scope: 'all' | 'local' | 'github';
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
  RestCollectionEvidence,
  RestPageEvidence,
  SnapshotManifest,
  SourceKind,
  StoredObjectEvidence
};
