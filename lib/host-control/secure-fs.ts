import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const NO_FOLLOW = fs.constants.O_NOFOLLOW ?? 0;
const DIRECTORY = fs.constants.O_DIRECTORY ?? 0;

export class SecureFileError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = 'SecureFileError';
    this.code = code;
  }
}

export type StableFile = Readonly<{
  bytes: Buffer;
  sha256: string;
  stat: fs.BigIntStats;
}>;

function conflict(message: string): never {
  throw new SecureFileError('TASK_ARTIFACT_WRITE_CONFLICT', message);
}

function sameStat(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function assertNoSymlinkAncestors(candidate: string): void {
  let current = path.dirname(candidate);
  while (true) {
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) conflict('candidate parent is not a real directory');
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

export async function readStableFile(
  candidate: string,
  options: Readonly<{ maxBytes: number; expectedSha256?: string }>
): Promise<StableFile> {
  if (!path.isAbsolute(candidate)) {
    conflict('candidate path must be absolute and terminal');
  }
  assertNoSymlinkAncestors(candidate);
  let handle: fs.promises.FileHandle | undefined;
  try {
    handle = await fs.promises.open(candidate, fs.constants.O_RDONLY | NO_FOLLOW);
    const before = await handle.stat({ bigint: true }) as unknown as fs.BigIntStats;
    if (!before.isFile()) conflict('candidate is not a regular file');
    if (before.size > BigInt(options.maxBytes)) conflict('candidate exceeds the bounded read limit');
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (read.bytesRead === 0) conflict('candidate reached EOF before the bounded read completed');
      offset += read.bytesRead;
    }
    const after = await handle.stat({ bigint: true }) as unknown as fs.BigIntStats;
    if (!sameStat(before, after)) conflict('candidate identity or metadata changed during read');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (options.expectedSha256 !== undefined && sha256 !== options.expectedSha256) {
      conflict('candidate digest does not match the expected digest');
    }
    return { bytes, sha256, stat: after };
  } catch (error) {
    if (error instanceof SecureFileError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ELOOP' || code === 'ENOTSUP' || code === 'EINVAL') {
      conflict('candidate terminal is not a stable non-symlink file');
    }
    throw new SecureFileError('TASK_ARTIFACT_WRITE_CONFLICT', error instanceof Error ? error.message : String(error));
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function writeAtomicFile(target: string, bytes: Buffer, mode = 0o600): Promise<void> {
  const parent = path.dirname(target);
  let current = path.resolve(parent);
  while (true) {
    let stat: fs.Stats;
    try { stat = await fs.promises.lstat(current); }
    catch { throw new SecureFileError('TASK_ARTIFACT_WRITE_CONFLICT', 'authoritative parent directory is missing'); }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new SecureFileError('TASK_ARTIFACT_WRITE_CONFLICT', 'authoritative parent directory is not a real directory');
    }
    const next = path.dirname(current);
    if (next === current) break;
    current = next;
  }
  try {
    const existing = await fs.promises.lstat(target);
    if (existing.isSymbolicLink() || !existing.isFile()) {
      throw new SecureFileError('TASK_ARTIFACT_WRITE_CONFLICT', 'authoritative target is not a regular file');
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const temporary = path.join(parent, `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`);
  let handle: fs.promises.FileHandle | undefined;
  try {
    handle = await fs.promises.open(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, mode);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.chmod(mode);
    await handle.close();
    handle = undefined;
    await fs.promises.rename(temporary, target);
    const directory = await fs.promises.open(parent, fs.constants.O_RDONLY | DIRECTORY);
    try { await directory.sync(); } finally { await directory.close(); }
  } finally {
    await handle?.close().catch(() => undefined);
    await fs.promises.rm(temporary, { force: true }).catch(() => undefined);
  }
}
