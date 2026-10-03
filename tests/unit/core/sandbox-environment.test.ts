import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { isSandbox } from '../../../lib/sandbox/environment.ts';
import { writeSandboxControlIdentitySentinel } from '../../../lib/sandbox/control/identity-sentinel.ts';
import { onPlatforms } from '../../helpers.ts';

test('isSandbox distinguishes direct host from a verified mounted sandbox', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-environment-'));
  const statusDir = path.join(root, 'status');
  const generation = 'sandbox-environment-generation';
  const controlRootId = 'a'.repeat(96);
  const env = {
    AGENT_INFRA_SANDBOX: '1',
    AGENT_INFRA_CONTROL_TOKEN: 'token',
    AGENT_INFRA_CONTROL_GENERATION: generation,
    AGENT_INFRA_CONTROL_ROOT_ID: controlRootId,
    AGENT_INFRA_CONTROL_DIR: path.join(root, 'channel'),
    AGENT_INFRA_CONTROL_STATUS_DIR: statusDir
  };

  try {
    assert.equal(isSandbox({}, { statusMountPath: path.join(root, 'absent') }), false);
    fs.mkdirSync(statusDir);
    writeSandboxControlIdentitySentinel(statusDir, {
      version: 1, mode: 'branch-only', taskId: null, generation, controlRootId
    });
    assert.equal(isSandbox(env, { statusMountPath: statusDir }), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('isSandbox fails closed when sandbox configuration or its explicit marker is incomplete', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-environment-incomplete-'));
  const statusDir = path.join(root, 'status');
  fs.mkdirSync(statusDir);
  writeSandboxControlIdentitySentinel(statusDir, {
    version: 1, mode: 'branch-only', taskId: null,
    generation: 'generation', controlRootId: 'b'.repeat(96)
  });
  const completeConfig = {
    AGENT_INFRA_CONTROL_TOKEN: 'token',
    AGENT_INFRA_CONTROL_GENERATION: 'generation',
    AGENT_INFRA_CONTROL_ROOT_ID: 'b'.repeat(96),
    AGENT_INFRA_CONTROL_DIR: path.join(root, 'channel'),
    AGENT_INFRA_CONTROL_STATUS_DIR: statusDir
  };

  try {
    assert.equal(isSandbox({ ...completeConfig, AGENT_INFRA_SANDBOX: '1' }, { statusMountPath: statusDir }), true);
    assert.throws(
      () => isSandbox({ AGENT_INFRA_SANDBOX: '1' }, { statusMountPath: statusDir }),
      /SANDBOX_CONTROL_CONFIGURATION_INCOMPLETE/u
    );
    assert.throws(
      () => isSandbox(completeConfig, { statusMountPath: statusDir }),
      /SANDBOX_CONTROL_CONFIGURATION_INCOMPLETE/u
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('isSandbox does not treat a mounted status directory as absent when fs.lstatSync is replaced', onPlatforms('linux'), () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-environment-probe-'));
  const originalLstatSync = fs.lstatSync;
  const mutableFs = fs as unknown as { lstatSync: typeof fs.lstatSync };
  fs.mkdirSync(path.join(root, 'status'));
  try {
    mutableFs.lstatSync = (() => { throw Object.assign(new Error('hidden by preload'), { code: 'ENOENT' }); }) as typeof fs.lstatSync;
    assert.throws(
      () => isSandbox({}, { statusMountPath: path.join(root, 'status') }),
      /SANDBOX_CONTROL_CONFIGURATION_INCOMPLETE/u
    );
  } finally {
    mutableFs.lstatSync = originalLstatSync;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
