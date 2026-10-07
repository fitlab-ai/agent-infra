import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { acquireFileLock, NATIVE_LOCK_PRIMITIVE, probeNativeLockCapability } from '../../fs/file-lock.ts';
export { probeNativeLockCapability };

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

const LOCK_ROOT_NAME = path.join('.agent-infra', 'sandbox-locks');

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
  const lockDomain = options.lockDomain ?? digest(`${process.platform}\0${process.arch}\0${NATIVE_LOCK_PRIMITIVE}`);
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

export function acquireSandboxResourceLock(
  carrierIdentity: string,
  options: Readonly<{ lockDomain?: string; home?: string }> = {}
): SandboxResourceLock {
  const namespace = resolveSandboxLockNamespace(carrierIdentity, options);
  try {
    const lock = acquireFileLock(namespace.lockPath);
    return { path: namespace.lockPath, lockDomain: namespace.lockDomain, release: lock.release };
  } catch (error) {
    throw new Error(String(error instanceof Error ? error.message : error).replaceAll('FILE_LOCK_', 'SANDBOX_LOCK_'));
  }
}
