import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createInactiveControllerAuthorityState,
  readControllerAuthorityState,
  transitionControllerAuthorityState,
  writeControllerAuthorityState
} from '../../../lib/sandbox/control/controller-authority-state.ts';
import { reconcileCodexControllerAuthorityState } from '../../../lib/sandbox/control/controller-registration.ts';
import type { SandboxControlManifest } from '../../../lib/sandbox/control/protocol.ts';

const identity = {
  taskId: 'TASK-20260101-000001',
  generation: 'generation-1',
  controlRootId: 'a'.repeat(96)
} as const;

test('controller authority state starts inactive and transitions with compare-before-write', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'controller-authority-state-'));
  try {
    const inactive = createInactiveControllerAuthorityState(identity, 1_000);
    writeControllerAuthorityState(root, inactive, { expected: null });
    assert.deepEqual(readControllerAuthorityState(root), inactive);

    const opening = transitionControllerAuthorityState(root, inactive, {
      state: 'opening', transitionId: 'b'.repeat(64), now: 1_001
    });
    assert.equal(opening.state, 'opening');
    assert.equal(opening.revision, 2);
    assert.throws(
      () => transitionControllerAuthorityState(root, inactive, {
        state: 'opening', transitionId: 'c'.repeat(64), now: 1_002
      }),
      /CONTROLLER_AUTHORITY_STATE_CONFLICT/u
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('controller authority state rejects missing and malformed projections', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'controller-authority-invalid-'));
  try {
    assert.throws(() => readControllerAuthorityState(root), /CONTROLLER_AUTHORITY_STATE_MISSING/u);
    fs.writeFileSync(path.join(root, 'controller-authority.json'), '{}\n');
    assert.throws(() => readControllerAuthorityState(root), /CONTROLLER_AUTHORITY_STATE_INVALID/u);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('controller authority state reclaims a lock left by a dead writer', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'controller-authority-stale-lock-'));
  try {
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'controller-authority.json.lock'), `${JSON.stringify({
      version: 1, pid: 2_000_000_000, startTime: 0, token: 'dead-writer'
    })}\n`);
    const inactive = createInactiveControllerAuthorityState(identity, 1_000);
    assert.deepEqual(writeControllerAuthorityState(root, inactive, { expected: null }), inactive);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('controller authority reconciliation fails closed after an interrupted transition', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'controller-authority-reconcile-'));
  const publicStatusDir = path.join(root, 'public');
  const manifest = {
    mode: 'task-bound',
    taskId: identity.taskId,
    generation: identity.generation,
    controlRootId: identity.controlRootId
  } as unknown as SandboxControlManifest;
  const params = {
    manifest,
    manifestPath: path.join(root, 'manifest.json'),
    buildIdentity: {
      protocolVersion: 3 as const,
      packageVersion: '1.0.0',
      internalExecutableBuildHash: 'b'.repeat(64),
      lifecycleContractHash: 'c'.repeat(64)
    }
  };
  try {
    const inactive = reconcileCodexControllerAuthorityState(params, { now: () => 1_000 });
    assert.equal(inactive.state, 'inactive');
    const opening = transitionControllerAuthorityState(publicStatusDir, inactive, {
      state: 'opening', transitionId: 'd'.repeat(64), now: 1_001
    });
    assert.equal(opening.state, 'opening');
    const faulted = reconcileCodexControllerAuthorityState(params, { now: () => 1_002 });
    assert.equal(faulted.state, 'faulted');
    assert.equal(faulted.revision, 4);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
