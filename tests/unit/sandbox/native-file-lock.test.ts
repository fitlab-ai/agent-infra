import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  acquireSandboxResourceLock,
  probeNativeLockCapability,
  resolveSandboxLockNamespace,
  stableSandboxLockPath
} from '../../../lib/sandbox/control/native-file-lock.ts';

test('native lock namespace is stable and outside the carrier tree', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-lock-home-'));
  const domain = 'a'.repeat(64);
  const first = resolveSandboxLockNamespace('native:' + 'b'.repeat(64), { home, lockDomain: domain });
  const second = resolveSandboxLockNamespace('native:' + 'b'.repeat(64), { home, lockDomain: domain });

  assert.equal(first.lockPath, second.lockPath);
  assert.equal(stableSandboxLockPath('native:' + 'b'.repeat(64), domain, { home }), first.lockPath);
  assert.equal(first.lockPath.startsWith(path.join(home, '.agent-infra', 'sandbox-locks')), true);
  assert.equal(first.lockPath.includes('transition'), false);
});

test('native lock serializes same-carrier contenders and retains the lock object', () => {
  const capability = probeNativeLockCapability();
  assert.equal(capability.supported, true, capability.reason);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-lock-contend-'));
  const carrier = `native:${'c'.repeat(64)}`;
  const first = acquireSandboxResourceLock(carrier, { home, lockDomain: 'd'.repeat(64) });
  assert.throws(() => acquireSandboxResourceLock(carrier, { home, lockDomain: 'd'.repeat(64) }), /SANDBOX_LOCK_BUSY/);
  first.release();
  assert.equal(fs.existsSync(first.path), true);
  const second = acquireSandboxResourceLock(carrier, { home, lockDomain: 'd'.repeat(64) });
  second.release();
});
