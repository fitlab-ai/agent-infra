import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  checkpointIntentDigest,
  intentPath,
  readCheckpointIntent,
  removeCheckpointIntent,
  writeCheckpointIntent,
  type CheckpointIntent
} from '../../../lib/task/commit-intent.ts';

function intent(root: string): CheckpointIntent {
  return {
    version: 1,
    taskId: 'TASK-20260101-000001',
    branch: 'feature/demo',
    mode: 'local',
    expectedHead: 'a'.repeat(40),
    expectedTree: 'b'.repeat(40),
    paths: ['lib/demo.ts'],
    message: 'fix: persist checkpoint',
    round: 1,
    digest: checkpointIntentDigest({
      taskId: 'TASK-20260101-000001', branch: 'feature/demo', mode: 'local',
      expectedHead: 'a'.repeat(40), expectedTree: 'b'.repeat(40),
      paths: ['lib/demo.ts'], message: 'fix: persist checkpoint', round: 1
    }),
    state: 'prepared',
    committedHead: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z'
  };
}

test('checkpoint intent is atomically persisted and removed after synchronization', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'commit-intent-'));
  try {
    const value = intent(root);
    writeCheckpointIntent(root, value);
    assert.equal(fs.existsSync(intentPath(root, value.taskId)), true);
    assert.deepEqual(readCheckpointIntent(root, value.taskId), value);
    removeCheckpointIntent(root, value.taskId);
    assert.equal(readCheckpointIntent(root, value.taskId), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
