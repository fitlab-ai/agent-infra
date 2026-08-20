import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type {
  JsonValue,
  NormalizedRecord,
  QualityFinding,
  RepairAction,
  RestCollectionEvidence,
  SnapshotManifest,
  SnapshotManifestV1,
  SnapshotManifestV2,
  SnapshotOperations,
  StoredObjectEvidence
} from './types.ts';

type ObjectWrite = { sha256: string; path: string; created: boolean };
type ObjectStore = { put(bytes: Buffer): ObjectWrite; pathFor(sha256: string): string };

type PublishInput = {
  scope: 'all' | 'local' | 'github';
  repository: string;
  observedFrom: string;
  observedTo: string;
  objects: StoredObjectEvidence[];
  endpoints: RestCollectionEvidence[];
  excerptsEnabled: boolean;
  records: NormalizedRecord[];
  quality: QualityFinding[];
  repairs: RepairAction[];
};

type PublishV2Input = PublishInput & {
  snapshotKind: 'base' | 'delta';
  parentSnapshotId: string | null;
  checkpointBefore: string | null;
  watermark: string;
  window: SnapshotManifestV2['window'];
  observation: SnapshotManifestV2['observation'];
  coverage: SnapshotManifestV2['coverage'];
  reconciliation: 'incremental' | 'full';
  operations: SnapshotOperations;
};

type VerificationResult = {
  ok: boolean;
  snapshotId: string;
  snapshotPath: string | null;
  errors: string[];
  manifest?: SnapshotManifest;
};

function sha256(bytes: Buffer | string): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function compareCodePoints(left: string, right: string): number {
  const a = Array.from(left, (char) => char.codePointAt(0)!);
  const b = Array.from(right, (char) => char.codePointAt(0)!);
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    if (a[index] !== b[index]) return a[index]! - b[index]!;
  }
  return a.length - b.length;
}

function canonicalString(value: unknown, seen: Set<object>): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('canonical JSON accepts only finite JSON values');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new Error('canonical JSON accepts only acyclic JSON values');
    seen.add(value);
    const output = `[${value.map((entry) => canonicalString(entry, seen)).join(',')}]`;
    seen.delete(value);
    return output;
  }
  if (typeof value === 'object') {
    if (seen.has(value)) throw new Error('canonical JSON accepts only acyclic JSON values');
    seen.add(value);
    const record = value as Record<string, unknown>;
    const fields = Object.keys(record)
      .sort(compareCodePoints)
      .map((key) => `${JSON.stringify(key)}:${canonicalString(record[key], seen)}`);
    seen.delete(value);
    return `{${fields.join(',')}}`;
  }
  throw new Error('canonical JSON accepts only JSON values');
}

function canonicalJsonBytes(value: JsonValue | unknown): Buffer {
  return Buffer.from(canonicalString(value, new Set()), 'utf8');
}

function ensurePrivateDirectory(directory: string): void {
  const missing: string[] = [];
  let current = path.resolve(directory);
  while (!fs.existsSync(current)) {
    missing.push(current);
    const parent = path.dirname(current);
    if (parent === current) throw new Error(`cannot create directory tree: ${directory}`);
    current = parent;
  }
  for (const target of missing.reverse()) {
    fs.mkdirSync(target, { mode: 0o700 });
    if (process.platform !== 'win32') fs.chmodSync(target, 0o700);
    fsyncDirectory(path.dirname(target));
  }
}

function fsyncDirectory(directory: string): void {
  if (process.platform === 'win32') return;
  const fd = fs.openSync(directory, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function writeExclusive(filePath: string, bytes: Buffer): boolean {
  const directory = path.dirname(filePath);
  const directoryExisted = fs.existsSync(directory);
  ensurePrivateDirectory(directory);
  if (!directoryExisted) fsyncDirectory(path.dirname(directory));
  try {
    const fd = fs.openSync(filePath, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, bytes);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fsyncDirectory(directory);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    return false;
  }
}

function createObjectStore(root: string): ObjectStore {
  const objectRoot = path.join(root, 'objects', 'sha256');
  ensurePrivateDirectory(objectRoot);
  return {
    pathFor(digest: string) {
      if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error(`invalid SHA-256: ${digest}`);
      return path.join(objectRoot, digest.slice(0, 2), digest);
    },
    put(bytes: Buffer) {
      const digest = sha256(bytes);
      const objectPath = path.join(objectRoot, digest.slice(0, 2), digest);
      const created = writeExclusive(objectPath, bytes);
      const stored = fs.readFileSync(objectPath);
      if (sha256(stored) !== digest) throw new Error(`CAS hash mismatch for ${digest}`);
      return { sha256: digest, path: objectPath, created };
    }
  };
}

function dispositionCounts(objects: StoredObjectEvidence[]): SnapshotManifest['dispositionCounts'] {
  const counts: SnapshotManifest['dispositionCounts'] = { included: 0, 'excluded-sensitive': 0, unavailable: 0 };
  for (const object of objects) counts[object.disposition?.state ?? 'included'] += 1;
  return counts;
}

function jsonLine(value: JsonValue | unknown): string {
  return `${canonicalJsonBytes(value).toString('utf8')}\n`;
}

function writePrivateFile(filePath: string, content: string | Buffer): void {
  const fd = fs.openSync(filePath, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, content);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  if (process.platform !== 'win32') fs.chmodSync(filePath, 0o600);
}

function manifestDigest(manifest: Record<string, unknown>): string {
  return sha256(canonicalJsonBytes(manifest));
}

function publishSnapshot(root: string, input: PublishInput): { snapshotId: string; path: string; created: boolean } {
  ensurePrivateDirectory(root);
  ensurePrivateDirectory(path.join(root, 'repairs'));
  const date = new Date(input.observedTo);
  if (!Number.isFinite(date.getTime())) throw new Error('observedTo must be an ISO timestamp');

  const identity = {
    scope: input.scope,
    repository: input.repository,
    observedFrom: input.observedFrom,
    observedTo: input.observedTo,
    objects: input.objects,
    endpoints: input.endpoints,
    excerptsEnabled: input.excerptsEnabled,
    dispositionCounts: dispositionCounts(input.objects),
    recordCount: input.records.length,
    findingCount: input.quality.length,
    repairCount: input.repairs.length
  };
  const identityDigest = sha256(canonicalJsonBytes(identity));
  const stamp = input.observedTo.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const snapshotId = `${stamp}-${identityDigest.slice(0, 12)}`;
  const partialManifest: Omit<SnapshotManifestV1, 'manifestSha256'> = {
    schema: 'raw-manifest/v1',
    snapshotId,
    ...identity,
    privacyPolicyVersion: 'process-data-privacy/v1'
  };
  const manifest: SnapshotManifest = { ...partialManifest, manifestSha256: manifestDigest(partialManifest) };

  const stagingRoot = path.join(root, '.staging');
  ensurePrivateDirectory(stagingRoot);
  const staging = fs.mkdtempSync(path.join(stagingRoot, `${snapshotId}-`));
  if (process.platform !== 'win32') fs.chmodSync(staging, 0o700);
  try {
    writePrivateFile(path.join(staging, 'manifest.json'), jsonLine(manifest));
    writePrivateFile(
      path.join(staging, 'normalized.jsonl'),
      input.records.map((record) => jsonLine({ schema: 'normalized/v1', ...record })).join('')
    );
    writePrivateFile(path.join(staging, 'quality.json'), jsonLine({ schema: 'quality/v1', findings: input.quality }));
    writePrivateFile(
      path.join(staging, 'repair-manifest.jsonl'),
      input.repairs.map((repair) => jsonLine({ schema: 'repair/v1', ...repair })).join('')
    );

    const destination = path.join(
      root,
      'snapshots',
      String(date.getUTCFullYear()),
      String(date.getUTCMonth() + 1).padStart(2, '0'),
      String(date.getUTCDate()).padStart(2, '0'),
      snapshotId
    );
    ensurePrivateDirectory(path.dirname(destination));
    if (fs.existsSync(destination)) {
      const existing = fs.readFileSync(path.join(destination, 'manifest.json'), 'utf8');
      if (existing !== jsonLine(manifest)) throw new Error(`snapshot collision: ${snapshotId}`);
      fs.rmSync(staging, { recursive: true, force: true });
      fsyncDirectory(stagingRoot);
      return { snapshotId, path: destination, created: false };
    }
    fsyncDirectory(staging);
    fs.renameSync(staging, destination);
    fsyncDirectory(stagingRoot);
    fsyncDirectory(path.dirname(destination));
    return { snapshotId, path: destination, created: true };
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

function publishSnapshotV2(root: string, input: PublishV2Input): { snapshotId: string; path: string; created: boolean } {
  ensurePrivateDirectory(root);
  ensurePrivateDirectory(path.join(root, 'repairs'));
  const date = new Date(input.observedTo);
  if (!Number.isFinite(date.getTime())) throw new Error('observedTo must be an ISO timestamp');
  const identity = {
    scope: 'github' as const,
    repository: input.repository,
    observedFrom: input.observedFrom,
    observedTo: input.observedTo,
    objects: input.objects,
    endpoints: input.endpoints,
    excerptsEnabled: false,
    dispositionCounts: dispositionCounts(input.objects),
    recordCount: input.records.length,
    findingCount: input.quality.length,
    repairCount: input.repairs.length,
    snapshotKind: input.snapshotKind,
    parentSnapshotId: input.parentSnapshotId,
    checkpointBefore: input.checkpointBefore,
    watermark: input.watermark,
    window: input.window,
    observation: input.observation,
    coverage: input.coverage,
    reconciliation: input.reconciliation,
    operations: input.operations
  };
  const snapshotId = `${input.watermark.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')}-${sha256(canonicalJsonBytes(identity)).slice(0, 12)}`;
  const partialManifest = {
    schema: 'raw-manifest/v2' as const,
    snapshotId,
    ...identity,
    observedFrom: input.observedFrom,
    observedTo: input.observedTo,
    privacyPolicyVersion: 'process-data-privacy/v1' as const
  };
  const manifest: SnapshotManifestV2 = { ...partialManifest, manifestSha256: manifestDigest(partialManifest) };
  const stagingRoot = path.join(root, '.staging');
  ensurePrivateDirectory(stagingRoot);
  const staging = fs.mkdtempSync(path.join(stagingRoot, `${snapshotId}-`));
  if (process.platform !== 'win32') fs.chmodSync(staging, 0o700);
  try {
    writePrivateFile(path.join(staging, 'manifest.json'), jsonLine(manifest));
    writePrivateFile(path.join(staging, 'normalized.jsonl'), input.records.map((record) => jsonLine({ schema: 'normalized/v2', ...record })).join(''));
    writePrivateFile(path.join(staging, 'quality.json'), jsonLine({ schema: 'quality/v1', findings: input.quality }));
    writePrivateFile(path.join(staging, 'repair-manifest.jsonl'), input.repairs.map((repair) => jsonLine({ schema: 'repair/v1', ...repair })).join(''));
    const destination = path.join(root, 'snapshots', String(date.getUTCFullYear()), String(date.getUTCMonth() + 1).padStart(2, '0'), String(date.getUTCDate()).padStart(2, '0'), snapshotId);
    ensurePrivateDirectory(path.dirname(destination));
    if (fs.existsSync(destination)) {
      const existing = fs.readFileSync(path.join(destination, 'manifest.json'), 'utf8');
      if (existing !== jsonLine(manifest)) throw new Error(`snapshot collision: ${snapshotId}`);
      fs.rmSync(staging, { recursive: true, force: true });
      fsyncDirectory(stagingRoot);
      return { snapshotId, path: destination, created: false };
    }
    fsyncDirectory(staging);
    fs.renameSync(staging, destination);
    fsyncDirectory(stagingRoot);
    fsyncDirectory(path.dirname(destination));
    return { snapshotId, path: destination, created: true };
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

function findSnapshot(root: string, snapshotId: string): string | null {
  const snapshotRoot = path.join(root, 'snapshots');
  if (!fs.existsSync(snapshotRoot)) return null;
  const stack = [snapshotRoot];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(current, entry.name);
      if (entry.name === snapshotId && fs.existsSync(path.join(candidate, 'manifest.json'))) return candidate;
      stack.push(candidate);
    }
  }
  return null;
}

function verifyV2Snapshot(root: string, snapshotId: string, snapshotPath: string, manifest: SnapshotManifestV2, seen: Set<string>): VerificationResult {
  const errors: string[] = [];
  if (seen.has(snapshotId)) return { ok: false, snapshotId, snapshotPath, errors: ['snapshot lineage cycle detected'], manifest };
  seen.add(snapshotId);
  if (manifest.snapshotId !== snapshotId) errors.push('snapshot identity mismatch');
  if (manifest.scope !== 'github') errors.push('v2 snapshot scope must be github');
  if (manifest.snapshotKind === 'base' && manifest.parentSnapshotId !== null) errors.push('base snapshot must not have a parent');
  if (manifest.snapshotKind === 'delta' && !manifest.parentSnapshotId) errors.push('delta snapshot must have a parent');
  if (manifest.checkpointBefore !== manifest.parentSnapshotId) errors.push('checkpoint and parent lineage mismatch');
  if (manifest.parentSnapshotId) {
    const parentPath = findSnapshot(root, manifest.parentSnapshotId);
    if (!parentPath) errors.push('parent snapshot is missing');
    else {
      const parentVerification = verifySnapshot(root, manifest.parentSnapshotId, seen);
      if (!parentVerification.ok || !parentVerification.manifest) {
        errors.push(`parent snapshot is invalid: ${parentVerification.errors.join('; ')}`);
      } else if (parentVerification.manifest.schema !== 'raw-manifest/v2') {
        errors.push('v2 snapshot parent is not v2');
      } else {
        const parent = parentVerification.manifest;
        if (parent.repository !== manifest.repository) errors.push('parent repository mismatch');
        if (new Date(parent.watermark).getTime() >= new Date(manifest.watermark).getTime()) errors.push('snapshot watermark is not monotonic');
      }
    }
  }
  if (manifest.watermark !== manifest.window.toExclusive) errors.push('watermark and window cutoff mismatch');
  const watermark = new Date(manifest.watermark);
  const from = manifest.window.fromInclusive ? new Date(manifest.window.fromInclusive) : null;
  const queryAfter = manifest.window.queryAfter ? new Date(manifest.window.queryAfter) : null;
  if (!Number.isFinite(watermark.getTime()) || (from && !Number.isFinite(from.getTime())) || (queryAfter && !Number.isFinite(queryAfter.getTime()))) {
    errors.push('v2 observation window contains an invalid timestamp');
  }
  if (from && queryAfter && queryAfter.getTime() !== from.getTime() - 1000) errors.push('queryAfter does not equal watermark minus one second');
  if (!from && queryAfter) errors.push('base/full window cannot have queryAfter without fromInclusive');
  const strictSinceEndpoints = manifest.endpoints.filter((endpoint) => endpoint.queryMode === 'strict-since');
  const expectedQueryAfter = from && Number.isFinite(from.getTime()) ? new Date(from.getTime() - 1000).toISOString() : null;
  if (manifest.snapshotKind === 'base' && from) errors.push('base snapshot must not have fromInclusive');
  if (queryAfter && strictSinceEndpoints.length === 0) errors.push('queryAfter requires a strict-since endpoint');
  if (strictSinceEndpoints.length > 0 && (manifest.snapshotKind !== 'delta' || manifest.reconciliation !== 'incremental')) {
    errors.push('strict-since is only valid for incremental delta snapshots');
  }
  if (strictSinceEndpoints.length > 0 && manifest.window.queryAfter !== expectedQueryAfter) {
    errors.push('incremental strict-since queryAfter proof is invalid');
  }
  if (manifest.coverage.mode !== 'boundary-reread-with-full-reconcile' || manifest.coverage.absoluteCompleteness !== false) errors.push('coverage declaration is invalid');
  const preflight = new Date(manifest.observation.preflightDate);
  if (!Number.isFinite(preflight.getTime())) errors.push('preflight Date is invalid');
  for (const responseDate of manifest.observation.responseDates) {
    const parsed = new Date(responseDate);
    if (!Number.isFinite(parsed.getTime()) || parsed.getTime() < preflight.getTime()) errors.push('response Date evidence is invalid');
  }
  for (const endpoint of manifest.endpoints) {
    if (!endpoint.queryMode) errors.push(`endpoint query mode missing: ${endpoint.endpoint}`);
    if (endpoint.queryMode !== 'strict-since' && endpoint.queryMode !== 'full-enumeration') {
      errors.push(`endpoint query mode is invalid: ${endpoint.endpoint}`);
    } else if (endpoint.queryMode === 'strict-since') {
      if (endpoint.requestedSince !== expectedQueryAfter) errors.push(`endpoint since proof mismatch: ${endpoint.endpoint}`);
    } else if (endpoint.requestedSince !== undefined) {
      errors.push(`full-enumeration endpoint has requestedSince: ${endpoint.endpoint}`);
    }
    for (const page of endpoint.pages) {
      if (page.queryMode !== 'strict-since' && page.queryMode !== 'full-enumeration') {
        errors.push(`page query mode is invalid: ${endpoint.endpoint}#${page.index}`);
      }
      if (page.queryMode !== endpoint.queryMode) errors.push(`page query mode mismatch: ${endpoint.endpoint}#${page.index}`);
      if (endpoint.queryMode === 'strict-since') {
        if (page.requestedSince !== expectedQueryAfter) errors.push(`page since proof mismatch: ${endpoint.endpoint}#${page.index}`);
      } else if (page.requestedSince !== undefined) {
        errors.push(`full-enumeration page has requestedSince: ${endpoint.endpoint}#${page.index}`);
      }
      if (page.responseDate && new Date(page.responseDate).getTime() < preflight.getTime()) errors.push(`page Date precedes preflight: ${endpoint.endpoint}#${page.index}`);
    }
  }
  for (const endpoint of manifest.endpoints) {
    for (const page of endpoint.pages) {
      const matches = manifest.objects.filter((object) => object.role === 'page-evidence'
        && object.endpoint === endpoint.endpoint
        && object.page === page.index
        && object.sha256 === page.canonicalSha256);
      if (matches.length !== 1) {
        errors.push(`page evidence CAS reference is missing or ambiguous: ${endpoint.endpoint}#${page.index}`);
        continue;
      }
      const object = matches[0]!;
      if (object.queryMode !== 'strict-since' && object.queryMode !== 'full-enumeration') {
        errors.push(`page evidence query mode is invalid: ${endpoint.endpoint}#${page.index}`);
      }
      if (object.queryMode !== page.queryMode
        || object.requestedSince !== page.requestedSince
        || object.responseDate !== page.responseDate) {
        errors.push(`page evidence metadata mismatch: ${endpoint.endpoint}#${page.index}`);
      }
      if (endpoint.queryMode === 'strict-since' && object.requestedSince !== expectedQueryAfter) {
        errors.push(`page evidence since proof mismatch: ${endpoint.endpoint}#${page.index}`);
      }
    }
  }
  const { manifestSha256, ...partial } = manifest;
  if (manifestDigest(partial) !== manifestSha256) errors.push('manifest hash mismatch');
  const checkMode = (target: string, expected: number, label: string) => {
    if (process.platform === 'win32' || !fs.existsSync(target)) return;
    const actual = fs.statSync(target).mode & 0o777;
    if (actual !== expected) errors.push(`${label} permission mismatch: expected ${expected.toString(8)}, got ${actual.toString(8)}`);
  };
  checkMode(snapshotPath, 0o700, 'snapshot directory');
  for (const file of ['manifest.json', 'normalized.jsonl', 'quality.json', 'repair-manifest.jsonl']) checkMode(path.join(snapshotPath, file), 0o600, file);
  const store = createObjectStore(root);
  const normalizedEvidence: Array<{ resourceIdentity: string; resourceSha256: string; pageSha256: string }> = [];
  try {
    const lines = fs.readFileSync(path.join(snapshotPath, 'normalized.jsonl'), 'utf8').split('\n').filter(Boolean);
    const ids = new Set<string>();
    const operationCounts: SnapshotOperations = { upsert: 0, supersede: 0, tombstone: 0, unavailable: 0 };
    for (const line of lines) {
      const record = JSON.parse(line) as {
        schema?: string;
        recordId?: string;
        resourceIdentity?: string;
        sourceSha256?: string;
        operation?: keyof SnapshotOperations;
        evidence?: Array<{ resourceIdentity?: string; resourceSha256?: string; pageSha256?: string }>;
      };
      if (record.schema !== 'normalized/v2' || typeof record.recordId !== 'string') errors.push('normalized v2 record schema is invalid');
      if (typeof record.recordId === 'string' && ids.has(record.recordId)) errors.push(`duplicate normalized record: ${record.recordId}`);
      if (typeof record.recordId === 'string') ids.add(record.recordId);
      if (!record.operation || !(record.operation in operationCounts)) errors.push('normalized v2 operation is invalid');
      else operationCounts[record.operation] += 1;
      if ((record.operation === 'upsert' || record.operation === 'supersede')
        && (!Array.isArray(record.evidence) || record.evidence.length !== 1)) {
        errors.push(`resource evidence is required for ${record.operation}: ${record.recordId ?? 'unknown'}`);
      }
      for (const evidence of record.evidence ?? []) {
        if (typeof evidence.resourceIdentity === 'string' && typeof evidence.resourceSha256 === 'string' && typeof evidence.pageSha256 === 'string') {
          if (record.resourceIdentity !== evidence.resourceIdentity || record.sourceSha256 !== evidence.resourceSha256) {
            errors.push(`normalized v2 evidence does not match record source: ${record.recordId ?? 'unknown'}`);
          }
          normalizedEvidence.push({ resourceIdentity: evidence.resourceIdentity, resourceSha256: evidence.resourceSha256, pageSha256: evidence.pageSha256 });
        } else {
          errors.push('normalized v2 evidence reference is invalid');
        }
      }
    }
    if (lines.length !== manifest.recordCount) errors.push('normalized record count mismatch');
    if (canonicalJsonBytes(operationCounts).toString('utf8') !== canonicalJsonBytes(manifest.operations).toString('utf8')) errors.push('operation count mismatch');
    const quality = JSON.parse(fs.readFileSync(path.join(snapshotPath, 'quality.json'), 'utf8')) as { schema?: string; findings?: unknown[] };
    if (quality.schema !== 'quality/v1' || !Array.isArray(quality.findings)) errors.push('quality schema is invalid');
    else if (quality.findings.length !== manifest.findingCount) errors.push('quality finding count mismatch');
    const repairLines = fs.readFileSync(path.join(snapshotPath, 'repair-manifest.jsonl'), 'utf8').split('\n').filter(Boolean);
    if (repairLines.length !== manifest.repairCount) errors.push('repair manifest count mismatch');
    for (const line of repairLines) if ((JSON.parse(line) as { schema?: string }).schema !== 'repair/v1') errors.push('repair manifest schema is invalid');
  } catch {
    errors.push('snapshot derived files are missing or invalid');
  }
  for (const object of manifest.objects) {
    if (object.role !== 'page-evidence' && object.role !== 'resource') errors.push(`object role is invalid: ${object.sourceIdentity}`);
    if (object.disposition?.state && object.disposition.state !== 'included') continue;
    try {
      const objectPath = store.pathFor(object.sha256);
      const bytes = fs.readFileSync(objectPath);
      if (sha256(bytes) !== object.sha256 || bytes.length !== object.bytes) errors.push(`object integrity mismatch: ${object.sourceIdentity}`);
    } catch {
      errors.push(`object missing: ${object.sourceIdentity}`);
    }
  }
  for (const evidence of normalizedEvidence) {
    const resources = manifest.objects.filter((object) => object.role === 'resource'
      && object.resourceIdentity === evidence.resourceIdentity
      && object.sha256 === evidence.resourceSha256);
    const pages = manifest.objects.filter((object) => object.role === 'page-evidence' && object.sha256 === evidence.pageSha256);
    if (resources.length !== 1) errors.push(`resource evidence reference is missing or ambiguous: ${evidence.resourceIdentity}`);
    if (pages.length === 0) errors.push(`resource page evidence reference is missing: ${evidence.resourceIdentity}`);
  }
  return { ok: errors.length === 0, snapshotId, snapshotPath, errors, manifest };
}

function verifySnapshot(root: string, snapshotId: string, seen: Set<string> = new Set()): VerificationResult {
  const snapshotPath = findSnapshot(root, snapshotId);
  if (!snapshotPath) return { ok: false, snapshotId, snapshotPath: null, errors: ['snapshot not found'] };
  const errors: string[] = [];
  const checkMode = (target: string, expected: number, label: string) => {
    if (process.platform === 'win32' || !fs.existsSync(target)) return;
    const actual = fs.statSync(target).mode & 0o777;
    if (actual !== expected) errors.push(`${label} permission mismatch: expected ${expected.toString(8)}, got ${actual.toString(8)}`);
  };
  checkMode(snapshotPath, 0o700, 'snapshot directory');
  for (const file of ['manifest.json', 'normalized.jsonl', 'quality.json', 'repair-manifest.jsonl']) {
    checkMode(path.join(snapshotPath, file), 0o600, file);
  }
  let rawManifest: { schema?: unknown };
  try {
    rawManifest = JSON.parse(fs.readFileSync(path.join(snapshotPath, 'manifest.json'), 'utf8')) as { schema?: unknown };
  } catch {
    return { ok: false, snapshotId, snapshotPath, errors: ['manifest is invalid JSON'] };
  }
  if (rawManifest.schema === 'raw-manifest/v2') {
    return verifyV2Snapshot(root, snapshotId, snapshotPath, rawManifest as SnapshotManifestV2, seen);
  }
  if (rawManifest.schema !== 'raw-manifest/v1') {
    return { ok: false, snapshotId, snapshotPath, errors: [`unsupported manifest schema: ${String(rawManifest.schema)}`] };
  }
  const manifest = rawManifest as SnapshotManifestV1;
  if (manifest.snapshotId !== snapshotId) errors.push('snapshot identity mismatch');
  if (typeof manifest.excerptsEnabled !== 'boolean') errors.push('manifest excerpts opt-in is invalid');
  if (!manifest.dispositionCounts || canonicalJsonBytes(manifest.dispositionCounts).toString('utf8') !== canonicalJsonBytes(dispositionCounts(manifest.objects)).toString('utf8')) {
    errors.push('manifest disposition counts mismatch');
  }
  const { manifestSha256, ...partial } = manifest;
  if (manifestDigest(partial) !== manifestSha256) errors.push('manifest hash mismatch');
  const store = createObjectStore(root);
  try {
    const lines = fs.readFileSync(path.join(snapshotPath, 'normalized.jsonl'), 'utf8').split('\n').filter(Boolean);
    const ids = new Set<string>();
    for (const line of lines) {
      const record = JSON.parse(line) as { schema?: string; recordId?: string };
      if (record.schema !== 'normalized/v1' || typeof record.recordId !== 'string') {
        errors.push('normalized record schema is invalid');
        continue;
      }
      if (ids.has(record.recordId)) errors.push(`duplicate normalized record: ${record.recordId}`);
      ids.add(record.recordId);
    }
    if (lines.length !== manifest.recordCount) errors.push('normalized record count mismatch');
    const quality = JSON.parse(fs.readFileSync(path.join(snapshotPath, 'quality.json'), 'utf8')) as { schema?: string; findings?: unknown[] };
    if (quality.schema !== 'quality/v1' || !Array.isArray(quality.findings)) errors.push('quality schema is invalid');
    else if (quality.findings.length !== manifest.findingCount) errors.push('quality finding count mismatch');
    const repairLines = fs.readFileSync(path.join(snapshotPath, 'repair-manifest.jsonl'), 'utf8').split('\n').filter(Boolean);
    for (const line of repairLines) {
      const repair = JSON.parse(line) as { schema?: string; repairId?: string };
      if (repair.schema !== 'repair/v1' || typeof repair.repairId !== 'string') errors.push('repair manifest schema is invalid');
    }
    if (repairLines.length !== manifest.repairCount) errors.push('repair manifest count mismatch');
  } catch {
    errors.push('snapshot derived files are missing or invalid');
  }
  for (const object of manifest.objects) {
    if (object.disposition?.state && object.disposition.state !== 'included') continue;
    try {
      const objectPath = store.pathFor(object.sha256);
      checkMode(path.dirname(objectPath), 0o700, `object directory ${object.sha256.slice(0, 2)}`);
      checkMode(objectPath, 0o600, `object ${object.sourceIdentity}`);
      const bytes = fs.readFileSync(objectPath);
      if (sha256(bytes) !== object.sha256) errors.push(`object hash mismatch: ${object.sourceIdentity}`);
      if (bytes.length !== object.bytes) errors.push(`object byte count mismatch: ${object.sourceIdentity}`);
    } catch {
      errors.push(`object missing: ${object.sourceIdentity}`);
    }
  }
  for (const page of manifest.endpoints.flatMap((endpoint) => endpoint.pages)) {
    try {
      if (sha256(fs.readFileSync(store.pathFor(page.canonicalSha256))) !== page.canonicalSha256) {
        errors.push(`page hash mismatch: ${page.index}`);
      }
    } catch {
      errors.push(`page object missing: ${page.canonicalSha256}`);
    }
  }
  return { ok: errors.length === 0, snapshotId, snapshotPath, errors, manifest };
}

export {
  canonicalJsonBytes,
  createObjectStore,
  findSnapshot,
  publishSnapshot,
  publishSnapshotV2,
  sha256,
  verifySnapshot
};
export type { ObjectStore, ObjectWrite, PublishInput, PublishV2Input, VerificationResult };
