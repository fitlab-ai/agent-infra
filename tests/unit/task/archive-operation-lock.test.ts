import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { assertArchiveOperationAvailable } from '../../../lib/task/archive-operation-lock.ts';

test('stale archive lock check preserves a replacement live lock', () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-lock-'));
  const lockDir = path.join(workspaceRoot, '.archive-operation-lock');
  const pidPath = path.join(lockDir, 'pid');
  const stalePid = 999_999_999;
  fs.mkdirSync(lockDir);
  fs.writeFileSync(pidPath, `${stalePid}\n`);
  const kill = process.kill;

  try {
    process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
      if (pid === stalePid) {
        fs.writeFileSync(pidPath, `${process.pid}\n`);
        throw Object.assign(new Error('No such process'), { code: 'ESRCH' });
      }
      return kill(pid, signal);
    }) as typeof process.kill;

    assert.throws(() => assertArchiveOperationAvailable(workspaceRoot), /stale archive operation lock/);
    assert.equal(fs.readFileSync(pidPath, 'utf8'), `${process.pid}\n`);
  } finally {
    process.kill = kill;
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});
