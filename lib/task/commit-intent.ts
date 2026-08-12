import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { DelegationReceipt } from './delegation-receipts.ts';

type CommitIntentPhase = 'prepared' | 'committed' | 'pushed';
type PushEvidence = Readonly<{ remote: string; ref: string; head: string }>;
type CommitIntentOrchestration = Readonly<{
  runId: string;
  receiptId: string;
  authorizationIssuedAt: string;
  sourceRunDigest: string;
  plannedRunDigest: string;
  completionUpdatedAt: string;
  plannedReceipt: DelegationReceipt;
}>;
type CommitIntent = Readonly<{
  schemaVersion: 1;
  taskId: string;
  mode: 'standalone' | 'orchestrated';
  phase: CommitIntentPhase;
  tokenDigest: string;
  baselineHead: string;
  committedHead: string | null;
  pushEvidence: PushEvidence | null;
  orchestration: CommitIntentOrchestration | null;
  createdAt: string;
  updatedAt: string;
}>;
type CommitIntentInput = Omit<CommitIntent, 'schemaVersion' | 'tokenDigest'>;

class CommitIntentError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'CommitIntentError';
    this.code = code;
  }
}

function commitIntentPath(taskDir: string): string {
  return path.join(taskDir, 'commit-intent.json');
}

function digest(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function atomicWrite(file: string, value: CommitIntent): void {
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, serialize(value), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    const handle = fs.openSync(temp, 'r+');
    try {
      fs.fsyncSync(handle);
    } finally {
      fs.closeSync(handle);
    }
    fs.renameSync(temp, file);
    fs.chmodSync(file, 0o600);
    try {
      const directory = fs.openSync(path.dirname(file), 'r');
      try {
        fs.fsyncSync(directory);
      } finally {
        fs.closeSync(directory);
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!['EACCES', 'EISDIR', 'EINVAL', 'EPERM'].includes(code ?? '')) throw error;
    }
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function keysEqual(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).sort().join('\0') === [...expected].sort().join('\0');
}

function validPushEvidence(value: unknown): value is PushEvidence | null {
  return value === null || (
    isRecord(value)
    && keysEqual(value, ['remote', 'ref', 'head'])
    && ['remote', 'ref', 'head'].every((key) => typeof value[key] === 'string' && value[key] !== '')
  );
}

function validOrchestration(value: unknown): value is CommitIntentOrchestration | null {
  if (value === null) return true;
  if (!isRecord(value) || !keysEqual(value, [
    'runId', 'receiptId', 'authorizationIssuedAt', 'sourceRunDigest', 'plannedRunDigest',
    'completionUpdatedAt', 'plannedReceipt'
  ])) return false;
  return [
    'runId', 'receiptId', 'authorizationIssuedAt', 'sourceRunDigest', 'plannedRunDigest', 'completionUpdatedAt'
  ].every((key) => typeof value[key] === 'string' && value[key] !== '') && isRecord(value.plannedReceipt);
}

function parseIntent(raw: string, taskId: string): CommitIntent {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new CommitIntentError('ORCHESTRATION_COMMIT_INTENT_INVALID', 'commit intent is not valid JSON');
  }
  if (!isRecord(value) || !keysEqual(value, [
    'schemaVersion', 'taskId', 'mode', 'phase', 'tokenDigest', 'baselineHead', 'committedHead',
    'pushEvidence', 'orchestration', 'createdAt', 'updatedAt'
  ])) {
    throw new CommitIntentError('ORCHESTRATION_COMMIT_INTENT_INVALID', 'commit intent has an invalid schema');
  }
  if (
    value.schemaVersion !== 1
    || value.taskId !== taskId
    || !['standalone', 'orchestrated'].includes(String(value.mode))
    || !['prepared', 'committed', 'pushed'].includes(String(value.phase))
    || typeof value.tokenDigest !== 'string'
    || !/^[a-f0-9]{64}$/.test(value.tokenDigest)
    || typeof value.baselineHead !== 'string'
    || (value.committedHead !== null && typeof value.committedHead !== 'string')
    || !validPushEvidence(value.pushEvidence)
    || !validOrchestration(value.orchestration)
    || typeof value.createdAt !== 'string'
    || typeof value.updatedAt !== 'string'
    || (value.mode === 'standalone') !== (value.orchestration === null)
  ) {
    throw new CommitIntentError('ORCHESTRATION_COMMIT_INTENT_INVALID', 'commit intent has invalid field values');
  }
  return value as CommitIntent;
}

function tokenMatches(actualDigest: string, token: string): boolean {
  const actual = Buffer.from(actualDigest, 'hex');
  const supplied = Buffer.from(digest(token), 'hex');
  return actual.length === supplied.length && timingSafeEqual(actual, supplied);
}

function readCommitIntent(taskDir: string, taskId: string, token?: string): CommitIntent {
  const file = commitIntentPath(taskDir);
  const intent = parseIntent(fs.readFileSync(file, 'utf8'), taskId);
  if (token !== undefined && !tokenMatches(intent.tokenDigest, token)) {
    throw new CommitIntentError('ORCHESTRATION_COMMIT_INTENT_TOKEN_MISMATCH', 'commit intent token does not match');
  }
  return intent;
}

function createCommitIntent(
  taskDir: string,
  input: CommitIntentInput,
  options: Readonly<{ token?: () => string }> = {}
): Readonly<{ intent: CommitIntent; token: string }> {
  const file = commitIntentPath(taskDir);
  if (fs.existsSync(file)) {
    throw new CommitIntentError('ORCHESTRATION_COMMIT_INTENT_BUSY', 'an active commit intent already exists');
  }
  const token = (options.token ?? (() => randomBytes(32).toString('base64url')))();
  const intent: CommitIntent = Object.freeze({ schemaVersion: 1, ...input, tokenDigest: digest(token) });
  atomicWrite(file, intent);
  return { intent, token };
}

function updateCommitIntent(
  taskDir: string,
  taskId: string,
  token: string,
  updates: Partial<Pick<CommitIntent, 'phase' | 'committedHead' | 'pushEvidence' | 'updatedAt'>>
): CommitIntent {
  const current = readCommitIntent(taskDir, taskId, token);
  const nextPhase = updates.phase ?? current.phase;
  const transitions: Record<CommitIntentPhase, readonly CommitIntentPhase[]> = {
    prepared: ['prepared', 'committed', 'pushed'],
    committed: ['committed', 'pushed'],
    pushed: ['pushed']
  };
  if (!transitions[current.phase].includes(nextPhase)) {
    throw new CommitIntentError('ORCHESTRATION_COMMIT_INTENT_STATE_INVALID', `cannot move commit intent from ${current.phase} to ${nextPhase}`);
  }
  const updated = Object.freeze({ ...current, ...updates, phase: nextPhase });
  atomicWrite(commitIntentPath(taskDir), updated);
  return updated;
}

function removeCommitIntent(taskDir: string, taskId: string, token: string): void {
  readCommitIntent(taskDir, taskId, token);
  fs.unlinkSync(commitIntentPath(taskDir));
}

function removeCommitIntentByDigest(taskDir: string, taskId: string, expectedDigest: string): void {
  const file = commitIntentPath(taskDir);
  const raw = fs.readFileSync(file);
  parseIntent(raw.toString('utf8'), taskId);
  const actual = digest(raw);
  const expected = Buffer.from(expectedDigest, 'hex');
  const observed = Buffer.from(actual, 'hex');
  if (
    !/^[a-f0-9]{64}$/.test(expectedDigest)
    || expected.length !== observed.length
    || !timingSafeEqual(expected, observed)
  ) {
    throw new CommitIntentError(
      'ORCHESTRATION_COMMIT_RECOVERY_REQUIRED',
      'commit intent changed after recovery inspection'
    );
  }
  fs.unlinkSync(file);
}

export {
  CommitIntentError,
  commitIntentPath,
  createCommitIntent,
  digest,
  readCommitIntent,
  removeCommitIntent,
  removeCommitIntentByDigest,
  serialize,
  updateCommitIntent
};
export type { CommitIntent, CommitIntentInput, CommitIntentOrchestration, CommitIntentPhase, PushEvidence };
