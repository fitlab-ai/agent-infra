import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createSandboxControlIdentitySentinel,
  identityDigest,
  readSandboxControlIdentitySentinel,
  validateSandboxControlIdentity,
  writeSandboxControlIdentitySentinel
} from '../../../lib/sandbox/control/identity-sentinel.ts';

test('identity sentinel has only non-sensitive topology fields and a stable digest', () => {
  const sentinel = createSandboxControlIdentitySentinel({
    mode: 'task-bound',
    taskId: 'TASK-20260904-002407',
    generation: 'generation-1',
    controlRootId: 'a'.repeat(96)
  });
  assert.deepEqual(Object.keys(sentinel).sort(), ['controlRootId', 'generation', 'mode', 'taskId', 'version']);
  assert.equal(JSON.stringify(sentinel).includes('token'), false);
  assert.match(identityDigest(sentinel), /^[a-f0-9]{64}$/u);
  assert.equal(identityDigest(sentinel), identityDigest({ ...sentinel }));
});

test('identity sentinel is written atomically and host validation distinguishes missing and conflicts', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-identity-sentinel-'));
  const publicStatusDir = path.join(root, 'public');
  try {
    const sentinel = createSandboxControlIdentitySentinel({
      mode: 'branch-only', taskId: null, generation: 'generation-2', controlRootId: 'b'.repeat(96)
    });
    assert.equal(validateSandboxControlIdentity({
      publicStatusDir, root, mode: sentinel.mode, taskId: sentinel.taskId,
      generation: sentinel.generation, controlRootId: sentinel.controlRootId
    }).state, 'missing');
    writeSandboxControlIdentitySentinel(publicStatusDir, sentinel);
    assert.deepEqual(readSandboxControlIdentitySentinel(publicStatusDir), sentinel);
    assert.equal(fs.statSync(path.join(publicStatusDir, 'identity.json')).mode & 0o777, 0o400);
    assert.equal(validateSandboxControlIdentity({
      publicStatusDir, root, mode: sentinel.mode, taskId: sentinel.taskId,
      generation: sentinel.generation, controlRootId: 'c'.repeat(96)
    }).state, 'root-id-mismatch');
    fs.chmodSync(path.join(publicStatusDir, 'identity.json'), 0o600);
    fs.writeFileSync(path.join(publicStatusDir, 'identity.json'), '{bad\n');
    assert.equal(validateSandboxControlIdentity({
      publicStatusDir, root, mode: sentinel.mode, taskId: sentinel.taskId,
      generation: sentinel.generation, controlRootId: sentinel.controlRootId
    }).state, 'malformed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
