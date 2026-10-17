import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { spawn } from 'node:child_process';

import { createTempDir, onPlatforms } from '../../../helpers.ts';
import {
  TaskExecutionLockError,
  lockKey,
  mapLinkError,
  withRepositoryMutationLock
} from '../../../../lib/task/task-execution-lock.ts';

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

test('canonical and symlinked repository roots share one repository mutation key', () => {
  const root = createTempDir('task-lock-root-');
  const link = `${root}-link`;
  fs.symlinkSync(root, link, 'dir');
  assert.equal(lockKey(root, '__repository_mutation__').key, lockKey(link, '__repository_mutation__').key);
});

test('a live repository mutation owner blocks nested acquisition and is released', () => {
  const root = createTempDir('task-lock-repo-');
  const lockRoot = createTempDir('task-lock-state-');
  let nested: unknown;
  const value = withRepositoryMutationLock(root, () => {
    try {
      withRepositoryMutationLock(root, () => undefined, { lockRoot });
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
  const root = createTempDir('task-lock-repo-');
  const lockRoot = createTempDir('task-lock-state-');
  let called = false;

  assert.throws(
    () => withRepositoryMutationLock(root, () => {
      called = true;
    }, { lockRoot, linkSync: () => { throw errno('EPERM'); } }),
    (error: unknown) => error instanceof TaskExecutionLockError
      && error.code === 'ORCHESTRATION_LOCK_UNSUPPORTED'
  );
  assert.equal(called, false);
  assert.deepEqual(fs.readdirSync(lockRoot), []);
});

test('a stale fixed owner and stale candidates are reclaimed without leaving lock files', () => {
  const root = createTempDir('task-lock-repo-');
  const lockRoot = createTempDir('task-lock-state-');
  const taskId = '__repository_mutation__';
  const identity = lockKey(root, taskId);
  const staleOwner = {
    version: 2,
    pid: 999_999,
    startTime: 0,
    token: 'stale-token',
    owner: 'stale-owner',
    canonicalRepoRoot: identity.canonicalRepoRoot,
    taskId,
    acquiredAt: '2026-01-01T00:00:00.000Z'
  } as const;
  fs.writeFileSync(path.join(lockRoot, `${identity.key}.lock`), `${JSON.stringify(staleOwner)}\n`);
  fs.writeFileSync(path.join(lockRoot, `${identity.key}.candidate.999999.stale-token`), `${JSON.stringify(staleOwner)}\n`);

  assert.equal(
    withRepositoryMutationLock(root, () => 'reclaimed', {
      lockRoot,
      identityMatches: (record) => record.pid === process.pid
    }),
    'reclaimed'
  );
  assert.deepEqual(fs.readdirSync(lockRoot), []);
});

test('a stale quarantine left by a crashed reclaimer does not permanently block acquisition', () => {
  const root = createTempDir('task-lock-repo-');
  const lockRoot = createTempDir('task-lock-state-');
  const taskId = '__repository_mutation__';
  const identity = lockKey(root, taskId);
  const fixed = path.join(lockRoot, `${identity.key}.lock`);
  const quarantine = `${fixed}.quarantine.stale-token`;
  const staleOwner = {
    version: 2,
    pid: 999_999,
    startTime: 0,
    token: 'stale-token',
    owner: 'stale-owner',
    canonicalRepoRoot: identity.canonicalRepoRoot,
    taskId,
    acquiredAt: '2026-01-01T00:00:00.000Z'
  } as const;
  fs.writeFileSync(fixed, `${JSON.stringify(staleOwner)}\n`);
  fs.linkSync(fixed, quarantine);

  assert.equal(
    withRepositoryMutationLock(root, () => 'reclaimed', {
      lockRoot,
      identityMatches: () => false
    }),
    'reclaimed'
  );
  assert.deepEqual(fs.readdirSync(lockRoot), []);
});

test('two processes cannot overlap callbacks for the same repository mutation key', async () => {
  const root = createTempDir('task-lock-repo-');
  const lockRoot = createTempDir('task-lock-state-');
  const ready = path.join(lockRoot, 'ready');
  const release = path.join(lockRoot, 'release');
  const moduleUrl = new URL('../../../../lib/task/task-execution-lock.ts', import.meta.url).href;
  const childCode = `
    import fs from 'node:fs';
    import { withRepositoryMutationLock } from ${JSON.stringify(moduleUrl)};
    const [root, lockRoot, ready, release] = process.argv.slice(1);
    withRepositoryMutationLock(root, () => {
      fs.writeFileSync(ready, 'ready');
      const deadline = Date.now() + 5_000;
      while (!fs.existsSync(release) && Date.now() < deadline) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
      if (!fs.existsSync(release)) throw new Error('timed out waiting for release');
    }, { lockRoot });
  `;
  const child = spawn(process.execPath, [
    '--experimental-strip-types', '--input-type=module', '--eval', childCode,
    root, lockRoot, ready, release
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  const exit = new Promise<number | null>((resolve) => child.once('exit', resolve));
  try {
    const deadline = Date.now() + 2_000;
    while (!fs.existsSync(ready) && child.exitCode === null && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(fs.existsSync(ready), true);
    assert.throws(
      () => withRepositoryMutationLock(root, () => undefined, { lockRoot }),
      (error: unknown) => error instanceof TaskExecutionLockError
        && error.code === 'ORCHESTRATION_LOCK_BUSY'
    );
    fs.writeFileSync(release, 'release');
    assert.equal(await exit, 0);
    assert.deepEqual(fs.readdirSync(lockRoot).sort(), ['ready', 'release']);
  } finally {
    if (!fs.existsSync(release)) fs.writeFileSync(release, 'release');
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await exit;
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(lockRoot, { recursive: true, force: true });
  }
});

test(
  'the local temporary filesystem supports the lifecycle hard-link smoke path',
  onPlatforms('linux', 'darwin', 'win32'),
  () => {
    const root = createTempDir('task-lock-repo-');
    const lockRoot = createTempDir('task-lock-state-');
    assert.equal(
      withRepositoryMutationLock(root, () => 'ok', { lockRoot }),
      'ok'
    );
    assert.deepEqual(fs.readdirSync(lockRoot), []);
  }
);
