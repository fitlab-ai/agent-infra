import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export type CheckpointIntentState = 'prepared' | 'committed' | 'synced';

export type CheckpointIntent = Readonly<{
  version: 1;
  taskId: string;
  branch: string;
  mode: 'local';
  expectedHead: string;
  expectedTree: string;
  paths: readonly string[];
  message: string;
  round: number;
  digest: string;
  state: CheckpointIntentState;
  committedHead: string | null;
  createdAt: string;
  updatedAt: string;
}>;

type IntentIdentity = Readonly<{
  taskId: string;
  branch: string;
  mode: 'local';
  expectedHead: string;
  expectedTree: string;
  paths: readonly string[];
  message: string;
  round: number;
}>;

const MAX_INTENT_SIZE = 1024 * 1024;
const TASK_ID_PATTERN = /^TASK-\d{8}-\d{6}$/;

function intentPath(taskDir: string): string {
  return path.join(taskDir, '.checkpoint-intent.json');
}

function assertTaskDirectory(taskDir: string, taskId: string): void {
  if (!TASK_ID_PATTERN.test(taskId) || path.basename(path.resolve(taskDir)) !== taskId) {
    throw new Error('COMMIT_INTENT_INVALID: task directory does not match task ID');
  }
  const stat = fs.statSync(taskDir);
  if (!stat.isDirectory()) throw new Error('COMMIT_INTENT_INVALID: task directory is not a directory');
}

function checkpointIntentDigest(identity: IntentIdentity): string {
  return createHash('sha256').update(JSON.stringify({
    taskId: identity.taskId,
    branch: identity.branch,
    mode: identity.mode,
    expectedHead: identity.expectedHead,
    expectedTree: identity.expectedTree,
    paths: [...identity.paths],
    message: identity.message,
    round: identity.round
  })).digest('hex');
}

function isIntent(value: unknown): value is CheckpointIntent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const intent = value as Record<string, unknown>;
  const validState = ['prepared', 'committed', 'synced'].includes(String(intent.state));
  const validHead = intent.committedHead === null
    ? intent.state === 'prepared'
    : typeof intent.committedHead === 'string' && /^[a-f0-9]{40,64}$/.test(intent.committedHead)
      && intent.state !== 'prepared';
  return intent.version === 1
    && typeof intent.taskId === 'string' && TASK_ID_PATTERN.test(intent.taskId)
    && typeof intent.branch === 'string' && intent.branch.length > 0
    && intent.mode === 'local'
    && typeof intent.expectedHead === 'string' && /^[a-f0-9]{40,64}$/.test(intent.expectedHead)
    && typeof intent.expectedTree === 'string' && /^[a-f0-9]{40,64}$/.test(intent.expectedTree)
    && Array.isArray(intent.paths) && intent.paths.every((item) => typeof item === 'string' && item.length > 0)
    && typeof intent.message === 'string' && intent.message.length > 0
    && Number.isSafeInteger(intent.round) && Number(intent.round) > 0
    && typeof intent.digest === 'string' && /^[a-f0-9]{64}$/.test(intent.digest)
    && validState && validHead
    && typeof intent.createdAt === 'string' && intent.createdAt.length > 0
    && typeof intent.updatedAt === 'string' && intent.updatedAt.length > 0
    && intent.digest === checkpointIntentDigest(intent as unknown as IntentIdentity);
}

function invalidIntent(): never {
  throw new Error('COMMIT_INTENT_INVALID: checkpoint intent schema is invalid');
}

function readCheckpointIntent(taskDir: string, taskId: string): CheckpointIntent | null {
  assertTaskDirectory(taskDir, taskId);
  const target = intentPath(taskDir);
  let before: fs.Stats;
  try { before = fs.lstatSync(target); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_INTENT_SIZE) return invalidIntent();

  let descriptor: number | undefined;
  try {
    const noFollow = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
    descriptor = fs.openSync(target, fs.constants.O_RDONLY | noFollow);
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino
      || opened.size !== before.size || opened.size > MAX_INTENT_SIZE) return invalidIntent();
    const value = JSON.parse(fs.readFileSync(descriptor, 'utf8')) as unknown;
    if (!isIntent(value) || value.taskId !== taskId) return invalidIntent();
    return value;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('COMMIT_INTENT_INVALID:')) throw error;
    return invalidIntent();
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function writeCheckpointIntent(taskDir: string, value: CheckpointIntent): void {
  assertTaskDirectory(taskDir, value.taskId);
  if (!isIntent(value)) return invalidIntent();
  const target = intentPath(taskDir);
  const temporary = `${target}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  try { fs.renameSync(temporary, target); }
  catch (error) {
    try { fs.unlinkSync(temporary); } catch { /* preserve primary error */ }
    throw error;
  }
}

function updateCheckpointIntent(
  value: CheckpointIntent,
  patch: Partial<Pick<CheckpointIntent, 'state' | 'committedHead' | 'updatedAt'>>
): CheckpointIntent {
  const next = { ...value, ...patch };
  if (next.state === 'prepared' && next.committedHead !== null) throw new Error('COMMIT_INTENT_INVALID: prepared intent cannot have a committed head');
  if (next.state !== 'prepared' && !next.committedHead) throw new Error('COMMIT_INTENT_INVALID: committed intent requires a committed head');
  return next;
}

function removeCheckpointIntent(taskDir: string, taskId: string): void {
  assertTaskDirectory(taskDir, taskId);
  try { fs.unlinkSync(intentPath(taskDir)); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function sameCheckpointIntent(left: CheckpointIntent, right: IntentIdentity): boolean {
  return left.digest === checkpointIntentDigest(right)
    && left.taskId === right.taskId
    && left.branch === right.branch
    && left.mode === right.mode
    && left.expectedHead === right.expectedHead
    && left.expectedTree === right.expectedTree
    && left.message === right.message
    && left.round === right.round
    && JSON.stringify(left.paths) === JSON.stringify(right.paths);
}

export {
  checkpointIntentDigest,
  intentPath,
  isIntent,
  readCheckpointIntent,
  removeCheckpointIntent,
  sameCheckpointIntent,
  updateCheckpointIntent,
  writeCheckpointIntent
};
