import test from 'node:test';
import assert from 'node:assert/strict';

import {
  decodeRecoveryAction,
  decodeRecoveryManifest,
  encodeRecoveryAction,
  encodeRecoveryManifest
} from '../../../lib/task/recovery-actions.ts';

test('recovery action encoding is canonical and detects payload tampering', () => {
  const encoded = encodeRecoveryAction({
    taskId: 'TASK-20260101-000001',
    actionId: 'action-1',
    sequence: 1,
    type: 'activity-log',
    payload: { entry: 'completed' },
    previousActionSha256: null
  });

  const decoded = decodeRecoveryAction(encoded);
  assert.deepEqual(decoded, encoded);
  assert.throws(
    () => decodeRecoveryAction({ ...encoded, payload: { entry: 'changed' } }),
    /payloadSha256/
  );
});

test('recovery manifests bind the action head and task snapshot', () => {
  const encoded = encodeRecoveryManifest({
    taskId: 'TASK-20260101-000001',
    commitId: 'commit-1',
    phase: 'prepare',
    actionCount: 2,
    actionHeadSha256: 'a'.repeat(64),
    snapshotSha256: 'b'.repeat(64)
  });

  assert.deepEqual(decodeRecoveryManifest(encoded), encoded);
  assert.throws(
    () => decodeRecoveryManifest({ ...encoded, actionCount: 3 }),
    /manifestSha256/
  );
});

test('recovery identities only accept marker-safe canonical tokens', () => {
  const base = {
    taskId: 'TASK-20260101-000001', actionId: 'action-1', sequence: 1,
    type: 'activity-log', payload: {}, previousActionSha256: null
  };
  for (const actionId of ['action -->', 'action/1', 'action 1', '-action', 'action\n1', 'a'.repeat(129)]) {
    assert.throws(() => encodeRecoveryAction({ ...base, actionId }), /actionId is invalid/);
  }
  assert.throws(() => encodeRecoveryManifest({
    taskId: base.taskId, commitId: 'commit -->', phase: 'prepare', actionCount: 0,
    actionHeadSha256: 'a'.repeat(64), snapshotSha256: 'b'.repeat(64)
  }), /commitId is invalid/);
});
