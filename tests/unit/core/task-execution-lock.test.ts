import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawn } from 'node:child_process';

import { onPlatforms } from '../../helpers.ts';
import {
  TaskExecutionLockError,
  lockKey,
  mapLinkError,
  withTaskExecutionLock
} from '../../../lib/task/task-execution-lock.ts';

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

test('link errors map to stable lifecycle lock results', () => {
  assert.equal(mapLinkError('acquire', errno('EEXIST'), 'key'), 'exists');
  assert.equal(mapLinkError('quarantine', errno('ENOENT'), 'key'), 'missing');
  for (const code of ['EPERM', 'EACCES', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV']) {
    const result = mapLinkError('acquire', errno(code), 'key');
    assert.ok(result instanceof TaskExecutionLockError);
    assert.equal(result.code, 'ORCHESTRATION_LOCK_UNSUPPORTED');
    assert.equal(result.detail.errno, code);
  }
  const failed = mapLinkError('quarantine', errno('EIO'), 'key');
  assert.ok(failed instanceof TaskExecutionLockError);
  assert.equal(failed.code, 'ORCHESTRATION_LOCK_FAILED');
});

test('canonical and symlinked repository roots share one lock key', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-lock-root-'));
  const link = `${root}-link`;
  fs.symlinkSync(root, link, 'dir');
  assert.equal(lockKey(root, 'TASK-20260101-000001').key, lockKey(link, 'TASK-20260101-000001').key);
});

test('a live owner blocks nested acquisition and the outer lock is released', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-lock-repo-'));
  const lockRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'task-lock-state-'));
  let nested: unknown;
  const value = withTaskExecutionLock(root, 'TASK-20260101-000001', 'outer', () => {
    try {
      withTaskExecutionLock(root, 'TASK-20260101-000001', 'inner', () => undefined, { lockRoot });
    } catch (error) {
      nested = error;
    }
    return 42;
  }, { lockRoot });

  assert.equal(value, 42);
  assert.ok(nested instanceof TaskExecutionLockError);
  assert.equal(nested.code, 'ORCHESTRATION_LOCK_BUSY');
  assert.deepEqual(fs.readdirSync(lockRoot), []);
});

test('unsupported hard links fail closed before the callback and clean the candidate', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-lock-repo-'));
  const lockRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'task-lock-state-'));
  let called = false;

  assert.throws(
    () => withTaskExecutionLock(root, 'TASK-20260101-000001', 'unsupported', () => {
      called = true;
    }, { lockRoot, linkSync: () => { throw errno('EPERM'); } }),
    (error: unknown) => error instanceof TaskExecutionLockError
      && error.code === 'ORCHESTRATION_LOCK_UNSUPPORTED'
  );
  assert.equal(called, false);
  assert.deepEqual(fs.readdirSync(lockRoot), []);
});

test('a stale fixed owner and stale candidates are reclaimed without leaving lock files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-lock-repo-'));
  const lockRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'task-lock-state-'));
  const taskId = 'TASK-20260101-000001';
  const identity = lockKey(root, taskId);
  const staleOwner = {
    version: 1,
    pid: 999_999,
    startTime: 'stale',
    token: 'stale-token',
    owner: 'stale-owner',
    canonicalRepoRoot: identity.canonicalRepoRoot,
    taskId,
    acquiredAt: '2026-01-01T00:00:00.000Z'
  } as const;
  fs.writeFileSync(path.join(lockRoot, `${identity.key}.lock`), `${JSON.stringify(staleOwner)}\n`);
  fs.writeFileSync(path.join(lockRoot, `${identity.key}.candidate.999999.stale-token`), `${JSON.stringify(staleOwner)}\n`);

  assert.equal(
    withTaskExecutionLock(root, taskId, 'reclaimer', () => 'reclaimed', {
      lockRoot,
      identityMatches: (record) => record.pid === process.pid
    }),
    'reclaimed'
  );
  assert.deepEqual(fs.readdirSync(lockRoot), []);
});

test('a stale quarantine left by a crashed reclaimer does not permanently block acquisition', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-lock-repo-'));
  const lockRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'task-lock-state-'));
  const taskId = 'TASK-20260101-000001';
  const identity = lockKey(root, taskId);
  const fixed = path.join(lockRoot, `${identity.key}.lock`);
  const quarantine = `${fixed}.quarantine.stale-token`;
  const staleOwner = {
    version: 1,
    pid: 999_999,
    startTime: 'stale',
    token: 'stale-token',
    owner: 'stale-owner',
    canonicalRepoRoot: identity.canonicalRepoRoot,
    taskId,
    acquiredAt: '2026-01-01T00:00:00.000Z'
  } as const;
  fs.writeFileSync(fixed, `${JSON.stringify(staleOwner)}\n`);
  fs.linkSync(fixed, quarantine);

  assert.equal(
    withTaskExecutionLock(root, taskId, 'reclaimer', () => 'reclaimed', {
      lockRoot,
      identityMatches: () => false
    }),
    'reclaimed'
  );
  assert.deepEqual(fs.readdirSync(lockRoot), []);
});

test('two processes cannot overlap callbacks for the same task key', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-lock-repo-'));
  const lockRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'task-lock-state-'));
  const ready = path.join(lockRoot, 'ready');
  const release = path.join(lockRoot, 'release');
  const moduleUrl = new URL('../../../lib/task/task-execution-lock.ts', import.meta.url).href;
  const childCode = `
    import fs from 'node:fs';
    import { withTaskExecutionLock } from ${JSON.stringify(moduleUrl)};
    const [root, lockRoot, ready, release] = process.argv.slice(1);
    withTaskExecutionLock(root, 'TASK-20260101-000001', 'child', () => {
      fs.writeFileSync(ready, 'ready');
      while (!fs.existsSync(release)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }, { lockRoot });
  `;
  const child = spawn(process.execPath, [
    '--experimental-strip-types', '--input-type=module', '--eval', childCode,
    root, lockRoot, ready, release
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  const deadline = Date.now() + 2_000;
  while (!fs.existsSync(ready) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(fs.existsSync(ready), true);
  assert.throws(
    () => withTaskExecutionLock(root, 'TASK-20260101-000001', 'parent', () => undefined, { lockRoot }),
    (error: unknown) => error instanceof TaskExecutionLockError
      && error.code === 'ORCHESTRATION_LOCK_BUSY'
  );
  fs.writeFileSync(release, 'release');
  const exitCode = await new Promise<number | null>((resolve) => child.once('exit', resolve));
  assert.equal(exitCode, 0);
  assert.deepEqual(fs.readdirSync(lockRoot).sort(), ['ready', 'release']);
});

test(
  'the local temporary filesystem supports the lifecycle hard-link smoke path',
  onPlatforms('linux', 'darwin', 'win32'),
  () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-lock-repo-'));
    const lockRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'task-lock-state-'));
    assert.equal(
      withTaskExecutionLock(root, 'TASK-20260101-000001', 'smoke', () => 'ok', { lockRoot }),
      'ok'
    );
    assert.deepEqual(fs.readdirSync(lockRoot), []);
  }
);
