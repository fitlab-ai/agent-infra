import crypto from 'node:crypto';
import fs from 'node:fs';

import { getProcessStartTime, processIdentityMatches } from '../server/process-state.ts';

type LockOwner = Readonly<{
  version: 1;
  pid: number;
  startTime: number;
  token: string;
}>;

function parseOwner(raw: string): LockOwner {
  const value = JSON.parse(raw) as Partial<LockOwner> | null;
  if (!value || value.version !== 1 || !Number.isSafeInteger(value.pid) || (value.pid ?? 0) < 1
    || !Number.isSafeInteger(value.startTime) || (value.startTime ?? -1) < 0
    || typeof value.token !== 'string' || !value.token) {
    throw new Error('RECOVERABLE_FILE_LOCK_INVALID');
  }
  return value as LockOwner;
}

export function withRecoverableFileLock<T>(
  file: string,
  conflictCode: string,
  operation: () => T
): T {
  const startTime = getProcessStartTime(process.pid);
  if (startTime === null) throw new Error(conflictCode);
  const owner: LockOwner = { version: 1, pid: process.pid, startTime, token: crypto.randomUUID() };
  const serialized = `${JSON.stringify(owner)}\n`;
  let ownsLock = false;
  for (let attempt = 0; attempt < 3 && !ownsLock; attempt += 1) {
    try {
      fs.writeFileSync(file, serialized, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      ownsLock = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let snapshot: string;
      let current: LockOwner;
      try {
        snapshot = fs.readFileSync(file, 'utf8');
        current = parseOwner(snapshot);
      } catch {
        throw new Error(conflictCode);
      }
      if (processIdentityMatches(current)) throw new Error(conflictCode);
      try {
        if (fs.readFileSync(file, 'utf8') === snapshot) fs.unlinkSync(file);
      } catch (reclaimError) {
        if ((reclaimError as NodeJS.ErrnoException).code !== 'ENOENT') throw reclaimError;
      }
    }
  }
  if (!ownsLock) throw new Error(conflictCode);
  try {
    return operation();
  } finally {
    try {
      const current = parseOwner(fs.readFileSync(file, 'utf8'));
      if (current.token === owner.token) fs.unlinkSync(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        // The primary operation result takes precedence over lock cleanup.
      }
    }
  }
}
