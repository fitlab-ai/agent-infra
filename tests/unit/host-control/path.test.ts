import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  HOST_CONTROL_DIRECTORY_MODE,
  HOST_CONTROL_SOCKET_MODE,
  HOST_CONTROL_WORKER_TOKEN_MODE,
  ensureHostControlWorkerToken,
  hostControlWorkerTokenPath,
  inspectHostControlEndpoint,
  readHostControlWorkerToken,
  removeHostControlWorkerToken,
  resolveHostControlEndpoint
} from '../../../lib/host-control/path.ts';

test('host control paths are derived from the platform identity, never HOME or TMPDIR', () => {
  assert.equal(
    resolveHostControlEndpoint({ platform: 'linux', uid: 1000 }),
    '/run/user/1000/agent-infra/host-control.sock'
  );
  assert.equal(
    resolveHostControlEndpoint({ platform: 'darwin', username: 'alice' }),
    '/Users/alice/Library/Application Support/agent-infra/run/host-control.sock'
  );
  assert.throws(() => resolveHostControlEndpoint({ platform: 'darwin', username: '../alice' }), /invalid/);
});

test('endpoint inspection requires a real socket with private owner and mode', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'host-control-path-'));
  const endpoint = path.join(root, 'host-control.sock');
  fs.writeFileSync(endpoint, 'candidate\n', { mode: 0o600 });
  assert.deepEqual(inspectHostControlEndpoint(endpoint, { uid: process.getuid?.() ?? 0 }), {
    ok: false,
    code: 'HOST_CONTROL_ENDPOINT_NOT_SOCKET'
  });
  fs.rmSync(root, { recursive: true, force: true });
});

test('host control permissions are explicit constants', () => {
  assert.equal(HOST_CONTROL_DIRECTORY_MODE, 0o700);
  assert.equal(HOST_CONTROL_SOCKET_MODE, 0o600);
  assert.equal(HOST_CONTROL_WORKER_TOKEN_MODE, 0o600);
});

test('host control worker token is owner-only, stable while running, and removed on close', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'host-control-token-'));
  const endpoint = path.join(root, 'run', 'host-control.sock');
  fs.mkdirSync(path.dirname(endpoint), { recursive: true, mode: 0o700 });
  const first = ensureHostControlWorkerToken(endpoint, process.getuid?.() ?? 0);
  assert.equal(readHostControlWorkerToken(endpoint, process.getuid?.() ?? 0), first);
  assert.equal(fs.statSync(hostControlWorkerTokenPath(endpoint)).mode & 0o777, HOST_CONTROL_WORKER_TOKEN_MODE);
  assert.equal(ensureHostControlWorkerToken(endpoint, process.getuid?.() ?? 0), first);
  removeHostControlWorkerToken(endpoint);
  assert.throws(() => readHostControlWorkerToken(endpoint, process.getuid?.() ?? 0), /ENOENT/);
  fs.rmSync(root, { recursive: true, force: true });
});
