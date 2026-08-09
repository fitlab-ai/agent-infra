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
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') fs.chmodSync(directory, 0o700);
}

function writeExclusive(filePath: string, bytes: Buffer): boolean {
  ensurePrivateDirectory(path.dirname(filePath));
  try {
    const fd = fs.openSync(filePath, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, bytes);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
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
  fs.writeFileSync(filePath, content, { mode: 0o600, flag: 'wx' });
  if (process.platform !== 'win32') fs.chmodSync(filePath, 0o600);
}

function manifestDigest(manifest: Omit<SnapshotManifest, 'manifestSha256'>): string {
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
  const partialManifest: Omit<SnapshotManifest, 'manifestSha256'> = {
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
      return { snapshotId, path: destination, created: false };
    }
    fs.renameSync(staging, destination);
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

function verifySnapshot(root: string, snapshotId: string): VerificationResult {
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
  let manifest: SnapshotManifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(snapshotPath, 'manifest.json'), 'utf8')) as SnapshotManifest;
  } catch {
    return { ok: false, snapshotId, snapshotPath, errors: ['manifest is invalid JSON'] };
  }
  if (manifest.schema !== 'raw-manifest/v1') errors.push(`unsupported manifest schema: ${manifest.schema}`);
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
  sha256,
  verifySnapshot
};
export type { ObjectStore, ObjectWrite, PublishInput, VerificationResult };
