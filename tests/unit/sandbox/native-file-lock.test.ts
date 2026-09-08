import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { onPlatforms } from '../../helpers/platform.ts';
import {
  acquireSandboxResourceLock,
  probeNativeLockCapability,
  resolveSandboxLockNamespace,
  stableSandboxLockPath
} from '../../../lib/sandbox/control/native-file-lock.ts';

test('native lock namespace is stable and outside the carrier tree', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-lock-home-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const domain = 'a'.repeat(64);
  const first = resolveSandboxLockNamespace('native:' + 'b'.repeat(64), { home, lockDomain: domain });
  const second = resolveSandboxLockNamespace('native:' + 'b'.repeat(64), { home, lockDomain: domain });

  assert.equal(first.lockPath, second.lockPath);
  assert.equal(stableSandboxLockPath('native:' + 'b'.repeat(64), domain, { home }), first.lockPath);
  assert.equal(first.lockPath.startsWith(path.join(home, '.agent-infra', 'sandbox-locks')), true);
});

test('native lock serializes same-carrier contenders and retains the lock object', (t) => {
  const capability = probeNativeLockCapability();
  assert.equal(capability.supported, true, capability.reason);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-lock-contend-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const carrier = `native:${'c'.repeat(64)}`;
  const first = acquireSandboxResourceLock(carrier, { home, lockDomain: 'd'.repeat(64) });
  try {
    assert.throws(() => acquireSandboxResourceLock(carrier, { home, lockDomain: 'd'.repeat(64) }), /SANDBOX_LOCK_BUSY/);
  } finally {
    first.release();
  }
  assert.equal(fs.existsSync(first.path), true);
  const second = acquireSandboxResourceLock(carrier, { home, lockDomain: 'd'.repeat(64) });
  second.release();
});

test('native lock capability reports the platform locking primitive', () => {
  const capability = probeNativeLockCapability();
  assert.equal(capability.supported, true, capability.reason);
  assert.equal(capability.primitive,
    process.platform === 'win32' ? 'LockFileEx' : process.platform === 'linux' ? 'F_OFD_SETLK' : 'flock');
  assert.deepEqual(capability, { supported: true, primitive: capability.primitive });
});

test('native lock preserves a replacement file during acquisition', onPlatforms('darwin', 'linux'), (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-lock-mode-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const lockPath = stableSandboxLockPath('descriptor-mode', undefined, { home });
  const movedPath = `${lockPath}.moved`;
  const open = fs.openSync;
  let replaced = false;
  t.mock.method(fs, 'openSync', (...args: Parameters<typeof fs.openSync>) => {
    const fd = open(...args);
    if (args[0] === lockPath && !replaced) {
      replaced = true;
      fs.renameSync(lockPath, movedPath);
      fs.writeFileSync(lockPath, 'replacement', { mode: 0o644 });
    }
    return fd;
  });
  assert.throws(() => acquireSandboxResourceLock('descriptor-mode', { home }), /SANDBOX_LOCK_UNSUPPORTED/);
  assert.equal(fs.readFileSync(lockPath, 'utf8'), 'replacement');
  assert.equal(fs.statSync(lockPath).mode & 0o777, 0o644);
  assert.equal(fs.statSync(movedPath).mode & 0o777, 0o600);
});
