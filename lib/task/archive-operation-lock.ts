import fs from 'node:fs';
import path from 'node:path';

const LOCK_DIR = '.archive-operation-lock';

export function assertArchiveOperationAvailable(workspaceRoot: string): void {
  const lockPath = path.join(workspaceRoot, LOCK_DIR);
  try {
    fs.lstatSync(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw new Error(`Archive unavailable: cannot verify archive operation lock at ${lockPath}`);
  }

  let pid: number;
  try {
    pid = Number(fs.readFileSync(path.join(lockPath, 'pid'), 'utf8').trim());
  } catch {
    throw new Error(`Archive unavailable: cannot verify archive operation lock at ${lockPath}`);
  }
  if (!Number.isSafeInteger(pid) || pid < 1) {
    throw new Error(`Archive unavailable: cannot verify archive operation lock at ${lockPath}`);
  }

  try { process.kill(pid, 0); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
      throw new Error(`Archive unavailable: cannot verify archive operation lock at ${lockPath}`);
    }
    fs.rmSync(lockPath, { recursive: true, force: true });
    return;
  }
  throw new Error(`Archive unavailable: archive operation is active at ${lockPath}`);
}

export function acquireArchiveOperationLock(workspaceRoot: string): () => void {
  const lockPath = path.join(workspaceRoot, LOCK_DIR);
  fs.mkdirSync(workspaceRoot, { recursive: true });
  assertArchiveOperationAvailable(workspaceRoot);
  try {
    fs.mkdirSync(lockPath);
    fs.writeFileSync(path.join(lockPath, 'pid'), `${process.pid}\n`, { flag: 'wx' });
  } catch {
    throw new Error(`Archive operation already in progress or stale lock present: ${lockPath}`);
  }
  return () => fs.rmSync(lockPath, { recursive: true, force: true });
}
