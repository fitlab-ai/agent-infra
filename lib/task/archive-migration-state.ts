import fs from 'node:fs';
import path from 'node:path';

const STATE_FILE = '.archive-migration-state.json';
const LOCK_DIR = '.archive-operation-lock';

export function assertArchiveAvailable(workspaceRoot: string): void {
  const statePath = path.join(workspaceRoot, STATE_FILE);
  const lockPath = path.join(workspaceRoot, LOCK_DIR);
  try {
    fs.lstatSync(statePath);
    throw new Error(`Archive unavailable: migration state is present at ${statePath}; complete migration or restore before retrying`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Archive unavailable:')) throw error;
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`Archive unavailable: cannot inspect migration state at ${statePath}`);
  }
  try {
    fs.lstatSync(lockPath);
    const pid = Number(fs.readFileSync(path.join(lockPath, 'pid'), 'utf8').trim());
    if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('invalid pid');
    try { process.kill(pid, 0); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      fs.rmSync(lockPath, { recursive: true });
      return;
    }
    throw new Error(`Archive unavailable: archive operation is active at ${lockPath}`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Archive unavailable:')) throw error;
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || String(error).includes('invalid pid')) {
      throw new Error(`Archive unavailable: cannot verify archive operation lock at ${lockPath}`);
    }
  }
}

export function acquireArchiveOperationLock(workspaceRoot: string): () => void {
  const lockPath = path.join(workspaceRoot, LOCK_DIR);
  fs.mkdirSync(workspaceRoot, { recursive: true });
  assertArchiveAvailable(workspaceRoot);
  try {
    fs.mkdirSync(lockPath);
    fs.writeFileSync(path.join(lockPath, 'pid'), `${process.pid}\n`, { flag: 'wx' });
  } catch {
    throw new Error(`Archive operation already in progress or stale lock present: ${lockPath}`);
  }
  return () => fs.rmSync(lockPath, { recursive: true, force: true });
}

export const archiveMigrationStatePath = (workspaceRoot: string): string =>
  path.join(workspaceRoot, STATE_FILE);
