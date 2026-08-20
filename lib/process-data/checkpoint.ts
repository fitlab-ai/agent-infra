import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { verifySnapshot } from './store.ts';
import type { GitHubCheckpoint, CheckpointOwner, ProcessResult, RecoveryReport } from './types.ts';

type CheckpointPaths = { directory: string; checkpoint: string; lock: string };
type CheckpointCandidate = {
  schema: 'github-checkpoint/v1';
  candidateSchema: 'github-checkpoint-candidate/v1';
  ownerId: string;
  expectedOld: { snapshotId: string | null; manifestSha256: string | null };
  repository: string;
  snapshotId: string;
  watermark: string;
  manifestSha256: string;
  committedAt: string;
};
type CheckpointLease = {
  paths: CheckpointPaths;
  repository: string;
  owner: CheckpointOwner;
  recovery: RecoveryReport;
  expectedOld: GitHubCheckpoint | null;
};

function repositoryKey(repository: string): string {
  return crypto.createHash('sha256').update(repository).digest('hex').slice(0, 32);
}

function checkpointPaths(root: string, repository: string): CheckpointPaths {
  const directory = path.join(root, 'checkpoints', 'github');
  const base = path.join(directory, repositoryKey(repository));
  return { directory, checkpoint: `${base}.json`, lock: `${base}.lock` };
}

function processStartToken(pid: number): string | null {
  if (process.platform === 'linux') {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const closing = stat.lastIndexOf(')');
      const fields = stat.slice(closing + 2).split(' ');
      return fields[19] ?? null;
    } catch {
      return null;
    }
  }
  return pid === process.pid ? `self:${process.pid}` : null;
}

function fsyncDirectory(directory: string): void {
  if (process.platform === 'win32') return;
  const fd = fs.openSync(directory, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
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

function writeTemporary(filePath: string, value: unknown): string {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(value)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  return temporary;
}

function validCheckpoint(value: unknown, repository: string): value is GitHubCheckpoint {
  if (!value || typeof value !== 'object') return false;
  const checkpoint = value as GitHubCheckpoint;
  return checkpoint.schema === 'github-checkpoint/v1'
    && checkpoint.repository === repository
    && Boolean(checkpoint.snapshotId)
    && Boolean(checkpoint.watermark)
    && Boolean(checkpoint.committedAt)
    && /^[a-f0-9]{64}$/.test(checkpoint.manifestSha256);
}

function checkpointMatchesSnapshot(root: string, value: GitHubCheckpoint): boolean {
  const verified = verifySnapshot(root, value.snapshotId);
  return verified.ok
    && verified.manifest?.schema === 'raw-manifest/v2'
    && verified.manifest.snapshotId === value.snapshotId
    && verified.manifest.repository === value.repository
    && verified.manifest.manifestSha256 === value.manifestSha256
    && verified.manifest.watermark === value.watermark;
}

function checkpointState(value: GitHubCheckpoint | null): { snapshotId: string | null; manifestSha256: string | null } {
  return { snapshotId: value?.snapshotId ?? null, manifestSha256: value?.manifestSha256 ?? null };
}

function readGitHubCheckpoint(root: string, repository: string): ProcessResult<GitHubCheckpoint | null> {
  const target = checkpointPaths(root, repository).checkpoint;
  if (!fs.existsSync(target)) return { ok: true, value: null };
  try {
    const parsed = JSON.parse(fs.readFileSync(target, 'utf8')) as GitHubCheckpoint;
    const value: GitHubCheckpoint = {
      schema: parsed.schema,
      repository: parsed.repository,
      snapshotId: parsed.snapshotId,
      watermark: parsed.watermark,
      manifestSha256: parsed.manifestSha256,
      committedAt: parsed.committedAt
    };
    if (!validCheckpoint(value, repository)) {
      return { ok: false, error: { code: 'CHECKPOINT_INVALID', message: 'GitHub checkpoint schema or identity is invalid' } };
    }
    return { ok: true, value };
  } catch {
    return { ok: false, error: { code: 'CHECKPOINT_INVALID', message: 'GitHub checkpoint is not valid JSON' } };
  }
}

function quarantine(lockPath: string): string {
  const target = `${lockPath}.orphaned-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  fs.renameSync(lockPath, target);
  return target;
}

function acquireGitHubCheckpoint(root: string, repository: string): ProcessResult<CheckpointLease> {
  const paths = checkpointPaths(root, repository);
  ensurePrivateDirectory(paths.directory);
  const recovery: RecoveryReport = { recovered: false, quarantined: [] };
  const owner: CheckpointOwner = {
    schema: 'checkpoint-owner/v1',
    ownerId: crypto.randomUUID(),
    pid: process.pid,
    host: os.hostname(),
    processStartToken: processStartToken(process.pid) ?? '',
    createdAt: new Date().toISOString()
  };
  if (!owner.processStartToken) {
    return { ok: false, error: { code: 'CHECKPOINT_TOPOLOGY_UNSUPPORTED', message: 'Process liveness cannot be verified on this host' } };
  }
  let recoveredOwnerId: string | null = null;
  if (fs.existsSync(paths.lock)) {
    let previous: CheckpointOwner;
    try {
      previous = JSON.parse(fs.readFileSync(paths.lock, 'utf8')) as CheckpointOwner;
    } catch {
      return { ok: false, error: { code: 'CHECKPOINT_RECOVERY_REQUIRED', message: 'Checkpoint lock is unreadable' } };
    }
    if (previous.host !== owner.host || !previous.ownerId || !previous.processStartToken) {
      return { ok: false, error: { code: 'CHECKPOINT_RECOVERY_REQUIRED', message: 'Checkpoint lock owner topology is unknown' } };
    }
    const currentToken = processStartToken(previous.pid);
    if (currentToken && currentToken === previous.processStartToken) {
      return { ok: false, error: { code: 'CHECKPOINT_BUSY', message: 'Checkpoint is held by a live process' } };
    }
    if (process.platform !== 'linux') {
      return { ok: false, error: { code: 'CHECKPOINT_RECOVERY_REQUIRED', message: 'Checkpoint owner liveness cannot be proven on this host' } };
    }
    try {
      recoveredOwnerId = previous.ownerId;
      recovery.quarantined.push(quarantine(paths.lock));
      recovery.recovered = true;
    } catch {
      return { ok: false, error: { code: 'CHECKPOINT_RECOVERY_REQUIRED', message: 'Unable to quarantine an orphaned checkpoint lock' } };
    }
  }
  try {
    const fd = fs.openSync(paths.lock, 'wx', 0o600);
    try { fs.writeFileSync(fd, `${JSON.stringify(owner)}\n`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fsyncDirectory(paths.directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      return { ok: false, error: { code: 'CHECKPOINT_BUSY', message: 'Checkpoint lock was acquired by another process' } };
    }
    return { ok: false, error: { code: 'CHECKPOINT_LOCK_FAILED', message: String(error) } };
  }

  const releaseOwnedLock = () => {
    try {
      fs.unlinkSync(paths.lock);
      fsyncDirectory(paths.directory);
    } catch {
      // Preserve the original recovery error; a remaining lock will fail closed next time.
    }
  };
  const beforeResult = readGitHubCheckpoint(root, repository);
  if (!beforeResult.ok) {
    releaseOwnedLock();
    return beforeResult;
  }
  let checkpointBefore = beforeResult.value;
  const temporaryCandidates = fs.readdirSync(paths.directory)
    .filter((entry) => entry.startsWith(path.basename(paths.checkpoint) + '.') && entry.endsWith('.tmp'))
    .map((entry) => path.join(paths.directory, entry));
  if (temporaryCandidates.length > 1) {
    releaseOwnedLock();
    return { ok: false, error: { code: 'CHECKPOINT_RECOVERY_REQUIRED', message: 'Multiple checkpoint recovery candidates exist' } };
  }
  if (temporaryCandidates.length === 1) {
    const candidate = temporaryCandidates[0]!;
    try {
      const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8')) as CheckpointCandidate | GitHubCheckpoint;
      const isCandidate = parsed && typeof parsed === 'object' && 'candidateSchema' in parsed
        && parsed.candidateSchema === 'github-checkpoint-candidate/v1';
      if (isCandidate) {
        const candidateValue = parsed as CheckpointCandidate;
        const value: GitHubCheckpoint = candidateValue;
        const expected = checkpointState(checkpointBefore);
        const candidateExpected = candidateValue.expectedOld;
        if (!recoveredOwnerId || candidateValue.ownerId !== recoveredOwnerId) {
          recovery.quarantined.push(quarantine(candidate));
          releaseOwnedLock();
          return { ok: false, error: { code: 'CHECKPOINT_RECOVERY_REQUIRED', message: 'Checkpoint candidate owner proof does not match the recovered lock owner' } };
        }
        if (!validCheckpoint(value, repository)
          || candidateExpected?.snapshotId !== expected.snapshotId
          || candidateExpected?.manifestSha256 !== expected.manifestSha256) {
          releaseOwnedLock();
          return { ok: false, error: { code: 'CHECKPOINT_RECOVERY_REQUIRED', message: 'Checkpoint candidate does not match the current head' } };
        }
        if (!checkpointMatchesSnapshot(root, value)) {
          recovery.quarantined.push(quarantine(candidate));
          releaseOwnedLock();
          return { ok: false, error: { code: 'CHECKPOINT_RECOVERY_REQUIRED', message: 'Checkpoint candidate snapshot failed full verification' } };
        }
        if (process.platform === 'win32' && checkpointBefore) {
          releaseOwnedLock();
          return { ok: false, error: { code: 'CHECKPOINT_TOPOLOGY_UNSUPPORTED', message: 'Checkpoint replacement durability cannot be proven on this host' } };
        }
        fs.renameSync(candidate, paths.checkpoint);
        recovery.recovered = true;
        fsyncDirectory(paths.directory);
        const recovered = readGitHubCheckpoint(root, repository);
        if (!recovered.ok) {
          releaseOwnedLock();
          return recovered;
        }
        checkpointBefore = recovered.value;
      } else {
        recovery.quarantined.push(quarantine(candidate));
        releaseOwnedLock();
        return { ok: false, error: { code: 'CHECKPOINT_RECOVERY_REQUIRED', message: 'Checkpoint candidate lacks owner proof' } };
      }
    } catch {
      recovery.quarantined.push(quarantine(candidate));
    }
  }
  return { ok: true, value: { paths, repository, owner, recovery, expectedOld: checkpointBefore } };
}

function commitGitHubCheckpoint(lease: CheckpointLease, value: GitHubCheckpoint): ProcessResult<void> {
  try {
    const current = JSON.parse(fs.readFileSync(lease.paths.lock, 'utf8')) as CheckpointOwner;
    if (current.ownerId !== lease.owner.ownerId) {
      return { ok: false, error: { code: 'CHECKPOINT_OWNER_MISMATCH', message: 'Checkpoint lock ownership changed' } };
    }
    if (value.repository !== lease.repository || !validCheckpoint(value, lease.repository)) {
      return { ok: false, error: { code: 'CHECKPOINT_INVALID', message: 'Checkpoint value is invalid' } };
    }
    const root = path.dirname(path.dirname(lease.paths.directory));
    if (!checkpointMatchesSnapshot(root, value)) {
      return { ok: false, error: { code: 'CHECKPOINT_INVALID', message: 'Checkpoint snapshot does not match a verified v2 manifest' } };
    }
    const currentCheckpoint = readGitHubCheckpoint(root, lease.repository);
    if (!currentCheckpoint.ok) return currentCheckpoint;
    if (checkpointState(currentCheckpoint.value).snapshotId !== checkpointState(lease.expectedOld).snapshotId
      || checkpointState(currentCheckpoint.value).manifestSha256 !== checkpointState(lease.expectedOld).manifestSha256) {
      return { ok: false, error: { code: 'CHECKPOINT_CONFLICT', message: 'Checkpoint head changed before commit' } };
    }
    const candidate: CheckpointCandidate = {
      ...value,
      candidateSchema: 'github-checkpoint-candidate/v1',
      ownerId: lease.owner.ownerId,
      expectedOld: checkpointState(lease.expectedOld)
    };
    const temporary = writeTemporary(lease.paths.checkpoint, candidate);
    const rechecked = readGitHubCheckpoint(root, lease.repository);
    if (!rechecked.ok) {
      fs.unlinkSync(temporary);
      return rechecked;
    }
    if (checkpointState(rechecked.value).snapshotId !== checkpointState(lease.expectedOld).snapshotId
      || checkpointState(rechecked.value).manifestSha256 !== checkpointState(lease.expectedOld).manifestSha256) {
      fs.unlinkSync(temporary);
      return { ok: false, error: { code: 'CHECKPOINT_CONFLICT', message: 'Checkpoint head changed during commit' } };
    }
    if (process.platform === 'win32' && fs.existsSync(lease.paths.checkpoint)) {
      fs.unlinkSync(temporary);
      return { ok: false, error: { code: 'CHECKPOINT_TOPOLOGY_UNSUPPORTED', message: 'Checkpoint replacement durability cannot be proven on this host' } };
    }
    fs.renameSync(temporary, lease.paths.checkpoint);
    if (process.platform !== 'win32') fs.chmodSync(lease.paths.checkpoint, 0o600);
    fsyncDirectory(lease.paths.directory);
    return { ok: true, value: undefined };
  } catch (error) {
    return { ok: false, error: { code: 'CHECKPOINT_COMMIT_FAILED', message: String(error) } };
  }
}

function releaseGitHubCheckpoint(lease: CheckpointLease): void {
  try {
    const current = JSON.parse(fs.readFileSync(lease.paths.lock, 'utf8')) as CheckpointOwner;
    if (current.ownerId === lease.owner.ownerId) {
      fs.unlinkSync(lease.paths.lock);
      fsyncDirectory(lease.paths.directory);
    }
  } catch {
    // The next invocation will fail closed and report recovery if the lock remains.
  }
}

export {
  acquireGitHubCheckpoint,
  checkpointPaths,
  commitGitHubCheckpoint,
  processStartToken,
  readGitHubCheckpoint,
  releaseGitHubCheckpoint
};
export type { CheckpointLease, CheckpointPaths };
