import fs from 'node:fs';
import path from 'node:path';

import { acquireFileLock } from '../fs/file-lock.ts';

export function withRecoverableFileLock<T>(
  file: string,
  conflictCode: string,
  operation: () => T
): T {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  let lock: ReturnType<typeof acquireFileLock>;
  try { lock = acquireFileLock(file); }
  catch { throw new Error(conflictCode); }
  try {
    return operation();
  } finally {
    try { lock.release(); }
    catch {
      // The primary operation result takes precedence over lock cleanup.
    }
  }
}
