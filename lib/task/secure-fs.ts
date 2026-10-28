import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const NO_FOLLOW = fs.constants.O_NOFOLLOW ?? 0;

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
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
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

export function readStableFileSync(candidate: string, options: Readonly<{ maxBytes: number; expectedSha256?: string }>): StableFile {
  if (!path.isAbsolute(candidate)) conflict('candidate path must be absolute and terminal');
  assertNoSymlinkAncestors(candidate);
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(candidate, fs.constants.O_RDONLY | NO_FOLLOW | (fs.constants.O_NONBLOCK ?? 0));
    const before = fs.fstatSync(descriptor, { bigint: true });
    if (!before.isFile()) conflict('candidate is not a regular file');
    if (before.size > BigInt(options.maxBytes)) conflict('candidate exceeds the bounded read limit');
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const bytesRead = fs.readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) conflict('candidate reached EOF before the bounded read completed');
      offset += bytesRead;
    }
    const after = fs.fstatSync(descriptor, { bigint: true });
    if (!sameStat(before, after)) conflict('candidate identity or metadata changed during read');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (options.expectedSha256 !== undefined && sha256 !== options.expectedSha256) conflict('candidate digest does not match the expected digest');
    return { bytes, sha256, stat: after };
  } catch (error) {
    if (error instanceof SecureFileError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ELOOP' || code === 'ENOTSUP' || code === 'EINVAL') conflict('candidate terminal is not a stable non-symlink file');
    throw new SecureFileError('TASK_ARTIFACT_WRITE_CONFLICT', error instanceof Error ? error.message : String(error));
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}
