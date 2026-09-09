import { createRequire } from 'node:module';
import fs from 'node:fs';

type NativeFsExtensions = Readonly<{
  tryLock: (fd: number) => boolean;
  unlock: (fd: number) => void;
}>;

export type FileLockCapability = Readonly<{
  supported: boolean;
  primitive: 'flock' | 'F_OFD_SETLK' | 'LockFileEx' | 'unavailable';
  reason?: string;
}>;

const require = createRequire(import.meta.url);
export const NATIVE_LOCK_PRIMITIVE = process.platform === 'win32' ? 'LockFileEx'
  : process.platform === 'linux' ? 'F_OFD_SETLK' : 'flock';

function loadNative(): NativeFsExtensions {
  try {
    return require('fs-native-extensions') as NativeFsExtensions;
  } catch (error) {
    throw new Error(
      `FILE_LOCK_UNSUPPORTED: native lock module is unavailable for Node ${process.version} (${process.platform}-${process.arch}). `
      + 'Verify that fs-native-extensions includes a prebuilt binary for this platform and reinstall @fitlab-ai/agent-infra. '
      + `Cause: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

export function probeNativeLockCapability(): FileLockCapability {
  try {
    loadNative();
    return {
      supported: true,
      primitive: NATIVE_LOCK_PRIMITIVE
    };
  } catch (error) {
    return {
      supported: false,
      primitive: 'unavailable',
      reason: error instanceof Error ? error.message : String(error)
    };
  }
}

/** Hold a stable lock file; callers own its namespace and must never unlink it. */
export function acquireFileLock(filePath: string): Readonly<{ release(): void }> {
  const native = loadNative();
  if (fs.existsSync(filePath)) {
    const existing = fs.lstatSync(filePath);
    if (existing.isSymbolicLink() || !existing.isFile()) {
      throw new Error('FILE_LOCK_UNSUPPORTED: lock object is not a regular file');
    }
    if (process.platform !== 'win32' && typeof process.getuid === 'function'
      && existing.uid !== process.getuid()) {
      throw new Error('FILE_LOCK_UNSUPPORTED: lock object owner mismatch');
    }
  }
  let fd: number | undefined;
  try {
    const noFollow = process.platform !== 'win32' && typeof fs.constants.O_NOFOLLOW === 'number'
      ? fs.constants.O_NOFOLLOW : 0;
    fd = fs.openSync(filePath, fs.constants.O_CREAT | fs.constants.O_RDWR | noFollow, 0o600);
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
      const current = fs.lstatSync(filePath);
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
    throw new Error(`FILE_LOCK_UNSUPPORTED: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (fd === undefined) throw new Error('FILE_LOCK_BUSY');

  let released = false;
  return {
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
      if (failure) throw new Error(`FILE_LOCK_RELEASE_FAILED: ${failure instanceof Error ? failure.message : String(failure)}`);
    }
  };
}
