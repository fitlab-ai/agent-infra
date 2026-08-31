import { createHash } from 'node:crypto';
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

function intentRoot(repoRoot: string): string {
  return path.join(repoRoot, '.agents', 'workspace', '.task-commit-intents');
}

function intentPath(repoRoot: string, taskId: string): string {
  return path.join(intentRoot(repoRoot), `${taskId}.json`);
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
  return intent.version === 1
    && typeof intent.taskId === 'string' && intent.taskId.length > 0
    && typeof intent.branch === 'string' && intent.branch.length > 0
    && intent.mode === 'local'
    && typeof intent.expectedHead === 'string' && /^[a-f0-9]{40,64}$/.test(intent.expectedHead)
    && typeof intent.expectedTree === 'string' && /^[a-f0-9]{40,64}$/.test(intent.expectedTree)
    && Array.isArray(intent.paths) && intent.paths.every((item) => typeof item === 'string' && item.length > 0)
    && typeof intent.message === 'string' && intent.message.length > 0
    && Number.isSafeInteger(intent.round) && Number(intent.round) > 0
    && typeof intent.digest === 'string' && /^[a-f0-9]{64}$/.test(intent.digest)
    && ['prepared', 'committed', 'synced'].includes(String(intent.state))
    && (intent.committedHead === null || (typeof intent.committedHead === 'string' && /^[a-f0-9]{40,64}$/.test(intent.committedHead)))
    && typeof intent.createdAt === 'string' && intent.createdAt.length > 0
    && typeof intent.updatedAt === 'string' && intent.updatedAt.length > 0
    && intent.digest === checkpointIntentDigest(intent as unknown as IntentIdentity);
}

function readCheckpointIntent(repoRoot: string, taskId: string): CheckpointIntent | null {
  const target = intentPath(repoRoot, taskId);
  if (!fs.existsSync(target)) return null;
  const value = JSON.parse(fs.readFileSync(target, 'utf8')) as unknown;
  if (!isIntent(value)) throw new Error('COMMIT_INTENT_INVALID: checkpoint intent schema is invalid');
  return value;
}

function writeCheckpointIntent(repoRoot: string, value: CheckpointIntent): void {
  if (!isIntent(value)) throw new Error('COMMIT_INTENT_INVALID: checkpoint intent schema is invalid');
  const directory = intentRoot(repoRoot);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const target = intentPath(repoRoot, value.taskId);
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
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

function removeCheckpointIntent(repoRoot: string, taskId: string): void {
  const target = intentPath(repoRoot, taskId);
  try { fs.unlinkSync(target); } catch (error) {
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
  intentRoot,
  isIntent,
  readCheckpointIntent,
  removeCheckpointIntent,
  sameCheckpointIntent,
  updateCheckpointIntent,
  writeCheckpointIntent
};
