import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type NativeFsExt = Readonly<{
  flockSync: (fd: number, flags: string) => void;
  lockFileExSync: (fd: number, flags: number, offsetLow: number, offsetHigh: number, lengthLow: number, lengthHigh: number) => void;
  unlockFileExSync: (fd: number, offsetLow: number, offsetHigh: number, lengthLow: number, lengthHigh: number) => void;
  constants: Readonly<{
    LOCKFILE_EXCLUSIVE_LOCK: number;
    LOCKFILE_FAIL_IMMEDIATELY: number;
  }>;
  getNativeModuleSource?: () => string;
}>;

export type SandboxLockCapability = Readonly<{
  supported: boolean;
  primitive: 'flock' | 'LockFileEx' | 'unavailable';
  binarySource: string | null;
  reason?: string;
}>;

export type SandboxLockNamespace = Readonly<{
  lockRoot: string;
  domainDirectory: string;
  lockDomain: string;
  carrierIdentityDigest: string;
  lockPath: string;
}>;

export type SandboxResourceLock = Readonly<{
  path: string;
  lockDomain: string;
  release(): void;
}>;

const require = createRequire(import.meta.url);
const LOCK_ROOT_NAME = path.join('.agent-infra', 'sandbox-locks');

function loadNative(): NativeFsExt {
  try {
    return require('fs-ext-extra-prebuilt') as NativeFsExt;
  } catch {
    throw new Error('SANDBOX_LOCK_UNSUPPORTED: native lock module is unavailable');
  }
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function assertPrivateDirectory(directory: string, home: string): void {
  const resolvedHome = path.resolve(home);
  let current = resolvedHome;
  const relative = path.relative(resolvedHome, path.resolve(directory));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('SANDBOX_LOCK_UNSUPPORTED: lock root must be below the user home');
  }
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (fs.existsSync(current)) {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error('SANDBOX_LOCK_UNSUPPORTED: lock namespace contains a link or non-directory');
      }
      if (process.platform !== 'win32' && typeof process.getuid === 'function'
        && stat.uid !== process.getuid()) {
        throw new Error('SANDBOX_LOCK_UNSUPPORTED: lock namespace owner mismatch');
      }
    } else {
      try {
        fs.mkdirSync(current, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const stat = fs.lstatSync(current);
        if (stat.isSymbolicLink() || !stat.isDirectory()) {
          throw new Error('SANDBOX_LOCK_UNSUPPORTED: lock namespace contains a link or non-directory');
        }
      }
    }
    if (process.platform !== 'win32') fs.chmodSync(current, 0o700);
  }
  const real = fs.realpathSync.native(path.resolve(directory));
  const realRelative = path.relative(fs.realpathSync.native(resolvedHome), real);
  if (!realRelative || realRelative.startsWith('..') || path.isAbsolute(realRelative)) {
    throw new Error('SANDBOX_LOCK_UNSUPPORTED: lock namespace realpath escapes the user home');
  }
}

export function resolveSandboxLockNamespace(
  carrierIdentity: string,
  options: Readonly<{ lockDomain?: string; home?: string }> = {}
): SandboxLockNamespace {
  if (!carrierIdentity.trim()) throw new Error('SANDBOX_LOCK_IDENTITY_INVALID');
  const home = path.resolve(options.home ?? os.homedir());
  const lockRoot = path.join(home, LOCK_ROOT_NAME);
  assertPrivateDirectory(lockRoot, home);
  const primitive = process.platform === 'win32' ? 'LockFileEx' : 'flock';
  const lockDomain = options.lockDomain ?? digest(`${process.platform}\0${process.arch}\0${primitive}`);
  if (!/^[a-f0-9]{64}$/u.test(lockDomain)) throw new Error('SANDBOX_LOCK_DOMAIN_INVALID');
  const domainDirectory = path.join(lockRoot, lockDomain);
  assertPrivateDirectory(domainDirectory, home);
  const carrierIdentityDigest = digest(carrierIdentity);
  return {
    lockRoot,
    domainDirectory,
    lockDomain,
    carrierIdentityDigest,
    lockPath: path.join(domainDirectory, `${carrierIdentityDigest}.lock`)
  };
}

export function stableSandboxLockPath(
  carrierIdentity: string,
  lockDomain?: string,
  options: Readonly<{ home?: string }> = {}
): string {
  return resolveSandboxLockNamespace(carrierIdentity, { lockDomain, home: options.home }).lockPath;
}

export function probeNativeLockCapability(): SandboxLockCapability {
  try {
    const native = loadNative();
    return {
      supported: true,
      primitive: process.platform === 'win32' ? 'LockFileEx' : 'flock',
      binarySource: native.getNativeModuleSource?.() ?? null
    };
  } catch (error) {
    return {
      supported: false,
      primitive: 'unavailable',
      binarySource: null,
      reason: error instanceof Error ? error.message : String(error)
    };
  }
}

export function acquireSandboxResourceLock(
  carrierIdentity: string,
  options: Readonly<{ lockDomain?: string; home?: string }> = {}
): SandboxResourceLock {
  const native = loadNative();
  const namespace = resolveSandboxLockNamespace(carrierIdentity, options);
  if (fs.existsSync(namespace.lockPath)) {
    const existing = fs.lstatSync(namespace.lockPath);
    if (existing.isSymbolicLink() || !existing.isFile()) {
      throw new Error('SANDBOX_LOCK_UNSUPPORTED: lock object is not a regular file');
    }
    if (process.platform !== 'win32' && typeof process.getuid === 'function'
      && existing.uid !== process.getuid()) {
      throw new Error('SANDBOX_LOCK_UNSUPPORTED: lock object owner mismatch');
    }
  }
  let fd: number | undefined;
  try {
    const noFollow = process.platform !== 'win32' && typeof fs.constants.O_NOFOLLOW === 'number'
      ? fs.constants.O_NOFOLLOW : 0;
    fd = fs.openSync(namespace.lockPath, fs.constants.O_CREAT | fs.constants.O_RDWR | noFollow, 0o600);
    if (process.platform !== 'win32') fs.chmodSync(namespace.lockPath, 0o600);
    if (process.platform === 'win32') {
      native.lockFileExSync(
        fd,
        native.constants.LOCKFILE_EXCLUSIVE_LOCK | native.constants.LOCKFILE_FAIL_IMMEDIATELY,
        0, 0, 1, 0
      );
    } else {
      native.flockSync(fd, 'exnb');
    }
  } catch (error) {
    try {
      if (fd !== undefined) fs.closeSync(fd);
    } catch {
      // Preserve the lock acquisition error.
    }
    const code = error && typeof error === 'object' && 'code' in error ? String((error as { code?: unknown }).code) : '';
    if (['EAGAIN', 'EACCES', 'EWOULDBLOCK'].includes(code)) {
      throw new Error('SANDBOX_LOCK_BUSY');
    }
    throw new Error(`SANDBOX_LOCK_UNSUPPORTED: ${error instanceof Error ? error.message : String(error)}`);
  }

  let released = false;
  return {
    path: namespace.lockPath,
    lockDomain: namespace.lockDomain,
    release() {
      if (released) return;
      released = true;
      let failure: unknown = null;
      try {
        if (fd === undefined) throw new Error('descriptor is missing');
        if (process.platform === 'win32') native.unlockFileExSync(fd, 0, 0, 1, 0);
        else native.flockSync(fd, 'un');
      } catch (error) {
        failure = error;
      } finally {
        try {
          if (fd !== undefined) fs.closeSync(fd);
        } catch (error) {
          failure ??= error;
        }
      }
      if (failure) throw new Error(`SANDBOX_LOCK_RELEASE_FAILED: ${failure instanceof Error ? failure.message : String(failure)}`);
    }
  };
}
