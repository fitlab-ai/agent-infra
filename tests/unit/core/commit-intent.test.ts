import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createCommitIntent,
  digest,
  readCommitIntent,
  removeCommitIntentByDigest,
  removeCommitIntent,
  updateCommitIntent
} from '../../../lib/task/commit-intent.ts';
import { assertModeBits } from '../../helpers/platform.ts';

function fixture() {
  const taskDir = fs.mkdtempSync(path.join(os.tmpdir(), 'commit-intent-'));
  return { taskDir, file: path.join(taskDir, 'commit-intent.json') };
}

const base = {
  taskId: 'TASK-20260101-000001',
  mode: 'standalone' as const,
  phase: 'prepared' as const,
  baselineHead: 'a'.repeat(40),
  committedHead: null,
  pushEvidence: null,
  orchestration: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z'
};

test('commit intent stores only a token digest with private permissions', () => {
  const f = fixture();
  const created = createCommitIntent(f.taskDir, base, { token: () => 'one-use-token' });

  assert.equal(created.token, 'one-use-token');
  assert.equal(fs.readFileSync(f.file, 'utf8').includes('one-use-token'), false);
  assertModeBits(f.file, 0o600);
  assert.equal(readCommitIntent(f.taskDir, base.taskId, 'one-use-token').phase, 'prepared');
  assert.throws(
    () => readCommitIntent(f.taskDir, base.taskId, 'wrong-token'),
    (error: unknown) => (error as { code?: string }).code === 'ORCHESTRATION_COMMIT_INTENT_TOKEN_MISMATCH'
  );
});

test('commit intent enforces identity, schema and legal phase updates', () => {
  const f = fixture();
  createCommitIntent(f.taskDir, base, { token: () => 'token' });
  assert.throws(
    () => readCommitIntent(f.taskDir, 'TASK-20260101-000002'),
    (error: unknown) => (error as { code?: string }).code === 'ORCHESTRATION_COMMIT_INTENT_INVALID'
  );

  const committed = updateCommitIntent(f.taskDir, base.taskId, 'token', {
    phase: 'committed', committedHead: 'b'.repeat(40), updatedAt: '2026-01-01T00:00:01.000Z'
  });
  assert.equal(committed.phase, 'committed');
  assert.throws(
    () => updateCommitIntent(f.taskDir, base.taskId, 'token', { phase: 'prepared' }),
    (error: unknown) => (error as { code?: string }).code === 'ORCHESTRATION_COMMIT_INTENT_STATE_INVALID'
  );
});

test('commit intent removal is token guarded', () => {
  const f = fixture();
  createCommitIntent(f.taskDir, base, { token: () => 'token' });
  assert.throws(
    () => removeCommitIntent(f.taskDir, base.taskId, 'wrong'),
    (error: unknown) => (error as { code?: string }).code === 'ORCHESTRATION_COMMIT_INTENT_TOKEN_MISMATCH'
  );
  removeCommitIntent(f.taskDir, base.taskId, 'token');
  assert.equal(fs.existsSync(f.file), false);
});

test('commit intent recovery removal compares the complete captured bytes', () => {
  const f = fixture();
  createCommitIntent(f.taskDir, base, { token: () => 'token' });
  const captured = digest(fs.readFileSync(f.file));

  assert.throws(
    () => removeCommitIntentByDigest(f.taskDir, base.taskId, '0'.repeat(64)),
    (error: unknown) => (error as { code?: string }).code === 'ORCHESTRATION_COMMIT_RECOVERY_REQUIRED'
  );
  removeCommitIntentByDigest(f.taskDir, base.taskId, captured);
  assert.equal(fs.existsSync(f.file), false);
});
