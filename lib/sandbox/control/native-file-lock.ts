import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type NativeFsExtensions = Readonly<{
  tryLock: (fd: number) => boolean;
  unlock: (fd: number) => void;
}>;

export type SandboxLockCapability = Readonly<{
  supported: boolean;
  primitive: 'flock' | 'F_OFD_SETLK' | 'LockFileEx' | 'unavailable';
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
const LOCK_PRIMITIVE = process.platform === 'win32' ? 'LockFileEx'
  : process.platform === 'linux' ? 'F_OFD_SETLK' : 'flock';

function loadNative(): NativeFsExtensions {
  try {
    return require('fs-native-extensions') as NativeFsExtensions;
  } catch (error) {
    throw new Error(
      `SANDBOX_LOCK_UNSUPPORTED: native lock module is unavailable for Node ${process.version} (${process.platform}-${process.arch}). `
      + 'Verify that fs-native-extensions includes a prebuilt binary for this platform and reinstall @fitlab-ai/agent-infra. '
      + `Cause: ${error instanceof Error ? error.message : String(error)}`
    );
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
  const lockDomain = options.lockDomain ?? digest(`${process.platform}\0${process.arch}\0${LOCK_PRIMITIVE}`);
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
    loadNative();
    return {
      supported: true,
      primitive: LOCK_PRIMITIVE
    };
  } catch (error) {
    return {
      supported: false,
      primitive: 'unavailable',
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
    const opened = fs.fstatSync(fd);
    if (!opened.isFile()) throw new Error('lock object must be a regular file');
    if (process.platform !== 'win32') {
      if (typeof process.getuid === 'function' && opened.uid !== process.getuid()) {
        throw new Error('lock object owner mismatch');
      }
      fs.fchmodSync(fd, 0o600);
    }
    if (!native.tryLock(fd)) {
      fs.closeSync(fd);
      fd = undefined;
    } else {
      const current = fs.lstatSync(namespace.lockPath);
      if (!current.isFile() || current.dev !== opened.dev || current.ino !== opened.ino) {
        throw new Error('lock object changed during acquisition');
      }
    }
  } catch (error) {
    try {
      if (fd !== undefined) fs.closeSync(fd);
    } catch {
      // Preserve the lock acquisition error.
    }
    throw new Error(`SANDBOX_LOCK_UNSUPPORTED: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (fd === undefined) throw new Error('SANDBOX_LOCK_BUSY');

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
        native.unlock(fd);
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
