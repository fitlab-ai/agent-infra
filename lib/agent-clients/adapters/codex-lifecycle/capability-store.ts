import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  isCanonicalLifecyclePackageVersion,
  isLifecycleProtocolVersion,
  LIFECYCLE_PROTOCOL_VERSION,
  verifyLifecycleBuildIdentity
} from './build-identity.ts';
import type { LifecycleBuildIdentity } from './build-identity.ts';
import { resolveAgentRuntimeStoreRoot } from '../../../runtime/agent-runtime.ts';

type CapabilityStatus = 'armed' | 'attested' | 'consumed' | 'expired';
type CodexControllerBinding = Readonly<{
  instanceDigest: string;
  controlGeneration: string;
}>;
type CodexCapabilityProjection = Readonly<
  | { kind: 'absent' }
  | { kind: 'protocol-version'; value: typeof LIFECYCLE_PROTOCOL_VERSION }
  | { kind: 'semver'; value: string }
  | { kind: 'digest-prefix'; value: string }
  | { kind: 'presence'; present: boolean }
>;
type CodexCapabilityProvenanceField = Readonly<{
  matches: boolean;
  expected: CodexCapabilityProjection;
  actual: CodexCapabilityProjection;
}>;
type CodexCapabilityProvenanceDetail = Readonly<{
  kind: 'codex-capability-provenance-mismatch';
  version: 1;
  fields: Readonly<{
    taskId: CodexCapabilityProvenanceField;
    hookDefinitionHash: CodexCapabilityProvenanceField;
    buildIdentity: Readonly<{
      protocolVersion: CodexCapabilityProvenanceField;
      packageVersion: CodexCapabilityProvenanceField;
      internalExecutableBuildHash: CodexCapabilityProvenanceField;
      lifecycleContractHash: CodexCapabilityProvenanceField;
    }>;
    controller: Readonly<{
      instanceDigest: CodexCapabilityProvenanceField;
      controlGeneration: CodexCapabilityProvenanceField;
    }>;
  }>;
}>;
type CodexCapabilityRecord = Readonly<{
  schemaVersion: 1;
  revision: number;
  tokenDigest: string;
  taskId: string;
  status: CapabilityStatus;
  buildIdentity: LifecycleBuildIdentity;
  controller: CodexControllerBinding | null;
  sessionId: string | null;
  turnId: string | null;
  toolUseId: string | null;
  hookDefinitionHash: string | null;
  armedAt: number;
  expiresAt: number;
  attestedAt: number | null;
  consumedAt: number | null;
}>;

type CodexCapabilityStoreOptions = Readonly<{
  root?: string;
  now?: () => number;
  token?: () => string;
  ttlMs?: number;
  tombstoneMs?: number;
  maxRecords?: number;
  beforeCompareAndSwap?: (input: Readonly<{ path: string; expectedRevision: number }>) => void;
}>;

const DEFAULT_TTL_MS = 30_000;
const DEFAULT_TOMBSTONE_MS = 86_400_000;
const DEFAULT_MAX_RECORDS = 128;
const LOCK_RETRY_MS = 10;
const LOCK_TIMEOUT_MS = 1_000;
const LOCK_STALE_MS = 30_000;
const DETAIL_DOMAIN = 'codex-capability-provenance/v1';
const TASK_ID_PATTERN = /^TASK-[0-9]{8}-[0-9]{6}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const DIGEST_PREFIX_PATTERN = /^sha256:[0-9a-f]{16}$/u;

function digest(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function capabilityError(code: string, message: string, detail?: CodexCapabilityProvenanceDetail): Error {
  const error = new Error(`${code}: ${message}`);
  error.name = code;
  if (detail) (error as Error & { detail: CodexCapabilityProvenanceDetail }).detail = detail;
  return error;
}

function objectValue(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object') return undefined;
  return (value as Record<string, unknown>)[key];
}

function digestPrefix(fieldName: string, value: string): CodexCapabilityProjection {
  return {
    kind: 'digest-prefix',
    value: `sha256:${crypto.createHash('sha256')
      .update(`${DETAIL_DOMAIN}\0${fieldName}\0${value}`)
      .digest('hex')
      .slice(0, 16)}`
  };
}

function projectDigest(fieldName: string, value: unknown, pattern: RegExp): CodexCapabilityProjection {
  return typeof value === 'string' && pattern.test(value) ? digestPrefix(fieldName, value) : { kind: 'absent' };
}

function projectTaskId(value: unknown): CodexCapabilityProjection {
  return projectDigest('taskId', value, TASK_ID_PATTERN);
}

function projectHash(fieldName: string, value: unknown): CodexCapabilityProjection {
  return projectDigest(fieldName, value, SHA256_PATTERN);
}

function projectProtocol(value: unknown): CodexCapabilityProjection {
  return isLifecycleProtocolVersion(value)
    ? { kind: 'protocol-version', value: LIFECYCLE_PROTOCOL_VERSION }
    : { kind: 'absent' };
}

function projectPackageVersion(value: unknown): CodexCapabilityProjection {
  return isCanonicalLifecyclePackageVersion(value)
    ? { kind: 'semver', value }
    : { kind: 'absent' };
}

function projectPresence(value: unknown): CodexCapabilityProjection {
  return { kind: 'presence', present: Boolean(value && typeof value === 'object') };
}

function field(matches: boolean, expected: CodexCapabilityProjection, actual: CodexCapabilityProjection): CodexCapabilityProvenanceField {
  return { matches, expected, actual };
}

function provenanceDetail(
  record: CodexCapabilityRecord,
  expected: Readonly<{
    taskId: string;
    hookDefinitionHash: string;
    buildIdentity: LifecycleBuildIdentity;
    controller?: CodexControllerBinding;
  }>
): CodexCapabilityProvenanceDetail {
  const actualBuild = record.buildIdentity;
  const expectedBuild = expected.buildIdentity;
  const actualController = record.controller;
  const expectedController = expected.controller ?? null;
  return {
    kind: 'codex-capability-provenance-mismatch',
    version: 1,
    fields: {
      taskId: field(
        record.taskId === expected.taskId,
        projectTaskId(expected.taskId),
        projectTaskId(record.taskId)
      ),
      hookDefinitionHash: field(
        record.hookDefinitionHash === expected.hookDefinitionHash,
        projectHash('hookDefinitionHash', expected.hookDefinitionHash),
        projectHash('hookDefinitionHash', record.hookDefinitionHash)
      ),
      buildIdentity: {
        protocolVersion: field(
          objectValue(actualBuild, 'protocolVersion') === objectValue(expectedBuild, 'protocolVersion'),
          projectProtocol(objectValue(expectedBuild, 'protocolVersion')),
          projectProtocol(objectValue(actualBuild, 'protocolVersion'))
        ),
        packageVersion: field(
          objectValue(actualBuild, 'packageVersion') === objectValue(expectedBuild, 'packageVersion'),
          projectPackageVersion(objectValue(expectedBuild, 'packageVersion')),
          projectPackageVersion(objectValue(actualBuild, 'packageVersion'))
        ),
        internalExecutableBuildHash: field(
          objectValue(actualBuild, 'internalExecutableBuildHash') === objectValue(expectedBuild, 'internalExecutableBuildHash'),
          projectHash('buildIdentity.internalExecutableBuildHash', objectValue(expectedBuild, 'internalExecutableBuildHash')),
          projectHash('buildIdentity.internalExecutableBuildHash', objectValue(actualBuild, 'internalExecutableBuildHash'))
        ),
        lifecycleContractHash: field(
          objectValue(actualBuild, 'lifecycleContractHash') === objectValue(expectedBuild, 'lifecycleContractHash'),
          projectHash('buildIdentity.lifecycleContractHash', objectValue(expectedBuild, 'lifecycleContractHash')),
          projectHash('buildIdentity.lifecycleContractHash', objectValue(actualBuild, 'lifecycleContractHash'))
        )
      },
      controller: {
        instanceDigest: field(
          sameControllerField(actualController, expectedController, 'instanceDigest'),
          projectPresence(objectValue(expectedController, 'instanceDigest') === undefined ? null : expectedController),
          projectPresence(objectValue(actualController, 'instanceDigest') === undefined ? null : actualController)
        ),
        controlGeneration: field(
          sameControllerField(actualController, expectedController, 'controlGeneration'),
          projectPresence(objectValue(expectedController, 'controlGeneration') === undefined ? null : expectedController),
          projectPresence(objectValue(actualController, 'controlGeneration') === undefined ? null : actualController)
        )
      }
    }
  };
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isCodexControllerBinding(value: unknown): value is CodexControllerBinding {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return exactKeys(record, ['instanceDigest', 'controlGeneration'])
    && typeof record.instanceDigest === 'string'
    && typeof record.controlGeneration === 'string';
}

function isProjection(value: unknown): value is CodexCapabilityProjection {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (record.kind === 'absent') return exactKeys(record, ['kind']);
  if (record.kind === 'protocol-version') {
    return exactKeys(record, ['kind', 'value']) && isLifecycleProtocolVersion(record.value);
  }
  if (record.kind === 'semver') {
    return exactKeys(record, ['kind', 'value']) && isCanonicalLifecyclePackageVersion(record.value);
  }
  if (record.kind === 'digest-prefix') {
    return exactKeys(record, ['kind', 'value'])
      && typeof record.value === 'string'
      && DIGEST_PREFIX_PATTERN.test(record.value);
  }
  if (record.kind === 'presence') {
    return exactKeys(record, ['kind', 'present']) && typeof record.present === 'boolean';
  }
  return false;
}

function isProvenanceField(value: unknown): value is CodexCapabilityProvenanceField {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return exactKeys(record, ['matches', 'expected', 'actual'])
    && typeof record.matches === 'boolean'
    && isProjection(record.expected)
    && isProjection(record.actual);
}

function isCodexCapabilityProvenanceDetail(value: unknown): value is CodexCapabilityProvenanceDetail {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (!exactKeys(record, ['kind', 'version', 'fields'])
    || record.kind !== 'codex-capability-provenance-mismatch'
    || record.version !== 1
    || !record.fields || typeof record.fields !== 'object') return false;
  const fields = record.fields as Record<string, unknown>;
  if (!exactKeys(fields, ['taskId', 'hookDefinitionHash', 'buildIdentity', 'controller'])
    || !isProvenanceField(fields.taskId)
    || !isProvenanceField(fields.hookDefinitionHash)) return false;
  const buildIdentity = fields.buildIdentity;
  const controller = fields.controller;
  if (!buildIdentity || typeof buildIdentity !== 'object' || !controller || typeof controller !== 'object') return false;
  const build = buildIdentity as Record<string, unknown>;
  const binding = controller as Record<string, unknown>;
  return exactKeys(build, ['protocolVersion', 'packageVersion', 'internalExecutableBuildHash', 'lifecycleContractHash'])
    && exactKeys(binding, ['instanceDigest', 'controlGeneration'])
    && isProvenanceField(build.protocolVersion)
    && isProvenanceField(build.packageVersion)
    && isProvenanceField(build.internalExecutableBuildHash)
    && isProvenanceField(build.lifecycleContractHash)
    && isProvenanceField(binding.instanceDigest)
    && isProvenanceField(binding.controlGeneration);
}

function sameControllerField(
  left: unknown,
  right: unknown,
  key: keyof CodexControllerBinding
): boolean {
  if (left === null || right === null) return left === null && right === null;
  return isCodexControllerBinding(left)
    && isCodexControllerBinding(right)
    && left[key] === right[key];
}

function sameController(
  left: unknown,
  right: unknown
): boolean {
  if (left === null || right === null) return left === null && right === null;
  return isCodexControllerBinding(left)
    && isCodexControllerBinding(right)
    && left.instanceDigest === right.instanceDigest
    && left.controlGeneration === right.controlGeneration;
}

function createCodexCapabilityStore(options: CodexCapabilityStoreOptions = {}) {
  const root = options.root
    ?? resolveAgentRuntimeStoreRoot({ store: 'capabilities' });
  const now = options.now ?? Date.now;
  const createToken = options.token ?? (() => crypto.randomBytes(32).toString('base64url'));
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const tombstoneMs = options.tombstoneMs ?? DEFAULT_TOMBSTONE_MS;
  const maxRecords = options.maxRecords ?? DEFAULT_MAX_RECORDS;
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  fs.chmodSync(root, 0o700);

  function fileFor(token: string): string {
    return path.join(root, `${digest(token)}.json`);
  }

  function read(file: string): CodexCapabilityRecord {
    const value = JSON.parse(fs.readFileSync(file, 'utf8')) as CodexCapabilityRecord;
    if (value.schemaVersion !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 1) {
      throw capabilityError('CODEX_CAPABILITY_STATE_INVALID', 'capability record schema is invalid');
    }
    return value;
  }

  function withWriteLock<T>(operation: () => T): T {
    const lock = path.join(root, '.write.lock');
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    let descriptor: number | null = null;
    while (descriptor === null) {
      try {
        descriptor = fs.openSync(lock, 'wx', 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        try {
          if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) {
            fs.unlinkSync(lock);
            continue;
          }
        } catch (lockError) {
          if ((lockError as NodeJS.ErrnoException).code === 'ENOENT') continue;
          throw lockError;
        }
        if (Date.now() >= deadline) {
          throw capabilityError('CODEX_CAPABILITY_STORE_BUSY', 'capability store is busy');
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_RETRY_MS);
      }
    }
    try {
      return operation();
    } finally {
      fs.closeSync(descriptor);
      fs.unlinkSync(lock);
    }
  }

  function write(file: string, value: CodexCapabilityRecord, expectedRevision: number): void {
    const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600
    });
    try {
      withWriteLock(() => {
        options.beforeCompareAndSwap?.({ path: file, expectedRevision });
        const actualRevision = fs.existsSync(file) ? read(file).revision : 0;
        if (actualRevision !== expectedRevision) {
          throw capabilityError(
            'CODEX_CAPABILITY_REVISION_CONFLICT',
            `capability revision changed from ${expectedRevision} to ${actualRevision}`
          );
        }
        fs.renameSync(temporary, file);
        fs.chmodSync(file, 0o600);
      });
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
  }

  function files(): string[] {
    return fs.readdirSync(root)
      .filter((name) => /^[a-f0-9]{64}\.json$/u.test(name))
      .map((name) => path.join(root, name));
  }

  function expire(record: CodexCapabilityRecord, file: string, timestamp: number): CodexCapabilityRecord {
    if ((record.status === 'armed' || record.status === 'attested') && timestamp > record.expiresAt) {
      const expired = Object.freeze({
        ...record,
        revision: record.revision + 1,
        status: 'expired' as const
      });
      write(file, expired, record.revision);
      return expired;
    }
    return record;
  }

  function sweep(): void {
    const timestamp = now();
    const records = files().map((file) => ({ file, record: expire(read(file), file, timestamp) }));
    for (const entry of records) {
      const terminalAt = entry.record.consumedAt ?? entry.record.expiresAt;
      if (['consumed', 'expired'].includes(entry.record.status)
        && timestamp - terminalAt > tombstoneMs) {
        fs.unlinkSync(entry.file);
      }
    }
    const remaining = files().map((file) => ({ file, record: read(file) }));
    if (remaining.length <= maxRecords) return;
    const removable = remaining
      .filter(({ record }) => ['consumed', 'expired'].includes(record.status))
      .sort((left, right) =>
        (left.record.consumedAt ?? left.record.expiresAt)
        - (right.record.consumedAt ?? right.record.expiresAt));
    while (files().length > maxRecords && removable.length > 0) {
      fs.unlinkSync(removable.shift()!.file);
    }
    if (files().length > maxRecords) {
      throw capabilityError('CODEX_CAPABILITY_CAPACITY_EXCEEDED', 'capability store has too many active records');
    }
  }

  function arm(input: Readonly<{
    taskId: string;
    buildIdentity: LifecycleBuildIdentity;
    controller?: CodexControllerBinding;
  }>): CodexCapabilityRecord & Readonly<{ token: string; path: string; marker: string }> {
    sweep();
    const token = createToken();
    const file = fileFor(token);
    if (fs.existsSync(file)) throw capabilityError('CODEX_CAPABILITY_TOKEN_COLLISION', 'capability token already exists');
    const timestamp = now();
    const record: CodexCapabilityRecord = Object.freeze({
      schemaVersion: 1,
      revision: 1,
      tokenDigest: digest(token),
      taskId: input.taskId,
      status: 'armed',
      buildIdentity: input.buildIdentity,
      controller: input.controller ?? null,
      sessionId: null,
      turnId: null,
      toolUseId: null,
      hookDefinitionHash: null,
      armedAt: timestamp,
      expiresAt: timestamp + ttlMs,
      attestedAt: null,
      consumedAt: null
    });
    write(file, record, 0);
    return Object.freeze({
      ...record,
      token,
      path: file,
      marker: `agent-infra-codex-capability:${token}`
    });
  }

  function loadActive(token: string): Readonly<{ file: string; record: CodexCapabilityRecord }> {
    const file = fileFor(token);
    if (!fs.existsSync(file)) {
      throw capabilityError('CODEX_CAPABILITY_MISSING', 'capability token was not found');
    }
    const record = expire(read(file), file, now());
    if (record.status === 'expired') {
      throw capabilityError('CODEX_CAPABILITY_EXPIRED', 'capability token expired');
    }
    return { file, record };
  }

  function attest(input: Readonly<{
    token: string;
    sessionId: string;
    turnId: string;
    toolUseId: string;
    hookDefinitionHash: string;
    buildIdentity: LifecycleBuildIdentity;
    controller?: CodexControllerBinding;
  }>): CodexCapabilityRecord {
    const { file, record } = loadActive(input.token);
    if (record.status !== 'armed') {
      throw capabilityError(
        record.status === 'consumed' ? 'CODEX_CAPABILITY_REPLAY' : 'CODEX_CAPABILITY_STATE_INVALID',
        `capability is ${record.status}, expected armed`
      );
    }
    const identity = verifyLifecycleBuildIdentity(record.buildIdentity, input.buildIdentity);
    if (!identity.ok || !sameController(record.controller, input.controller ?? null)) {
      throw capabilityError('CODEX_CAPABILITY_PROVENANCE_MISMATCH', 'capability build or controller identity does not match');
    }
    if (![input.sessionId, input.turnId, input.toolUseId, input.hookDefinitionHash]
      .every((value) => value.trim().length > 0)) {
      throw capabilityError('CODEX_CAPABILITY_IDENTITY_INVALID', 'hook identity is incomplete');
    }
    const timestamp = now();
    const next: CodexCapabilityRecord = Object.freeze({
      ...record,
      revision: record.revision + 1,
      status: 'attested',
      sessionId: input.sessionId,
      turnId: input.turnId,
      toolUseId: input.toolUseId,
      hookDefinitionHash: input.hookDefinitionHash,
      attestedAt: timestamp
    });
    write(file, next, record.revision);
    return next;
  }

  function consume(token: string, expected: Readonly<{
    taskId: string;
    hookDefinitionHash: string;
    buildIdentity: LifecycleBuildIdentity;
    controller?: CodexControllerBinding;
  }>): CodexCapabilityRecord {
    sweep();
    const { file, record } = loadActive(token);
    if (record.status === 'consumed') {
      throw capabilityError('CODEX_CAPABILITY_REPLAY', 'capability token was already consumed');
    }
    if (record.status !== 'attested') {
      throw capabilityError('CODEX_CAPABILITY_NOT_ATTESTED', 'capability token has no current-session hook attestation');
    }
    const identity = record.buildIdentity && typeof record.buildIdentity === 'object'
      ? verifyLifecycleBuildIdentity(record.buildIdentity, expected.buildIdentity)
      : { ok: false };
    if (!identity.ok
      || record.taskId !== expected.taskId
      || record.hookDefinitionHash !== expected.hookDefinitionHash
      || !sameController(record.controller, expected.controller ?? null)) {
      throw capabilityError(
        'CODEX_CAPABILITY_PROVENANCE_MISMATCH',
        'capability consumption identity does not match',
        provenanceDetail(record, expected)
      );
    }
    const next: CodexCapabilityRecord = Object.freeze({
      ...record,
      revision: record.revision + 1,
      status: 'consumed',
      consumedAt: now()
    });
    write(file, next, record.revision);
    return next;
  }

  function inspect(token: string): CodexCapabilityRecord {
    return loadActive(token).record;
  }

  return Object.freeze({ arm, attest, consume, inspect, sweep });
}

export { createCodexCapabilityStore };
export type {
  CapabilityStatus,
  CodexCapabilityProjection,
  CodexCapabilityProvenanceDetail,
  CodexCapabilityRecord,
  CodexCapabilityStoreOptions,
  CodexControllerBinding
};
export { isCodexCapabilityProvenanceDetail };
