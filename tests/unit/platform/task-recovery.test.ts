import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeRecoveryAction, encodeRecoveryManifest, canonicalJson } from '../../../lib/task/recovery-actions.ts';
import { recoverTaskDocument } from '../../../lib/platform/task-recovery.ts';

test('restore accepts only a complete snapshot-bound recovery transaction', () => {
  const action = encodeRecoveryAction({ taskId: 'TASK-20260101-000001', actionId: 'action-1', sequence: 1, type: 'task-document', payload: { taskContent: '# Task\n' }, previousActionSha256: null });
  const shared = { taskId: action.taskId, commitId: 'commit-1', actionCount: 1, actionHeadSha256: action.actionSha256, snapshotSha256: 'a'.repeat(64) };
  const prepare = encodeRecoveryManifest({ ...shared, phase: 'prepare' });
  const commit = encodeRecoveryManifest({ ...shared, phase: 'commit' });
  assert.equal(recoverTaskDocument({ taskId: action.taskId, snapshotSha256: shared.snapshotSha256, actions: [{ content: canonicalJson(action) }], prepares: [{ content: canonicalJson(prepare) }], commits: [{ content: canonicalJson(commit) }] }), '# Task\n');
  assert.throws(() => recoverTaskDocument({ taskId: action.taskId, snapshotSha256: shared.snapshotSha256, actions: [{ content: canonicalJson(action) }], prepares: [{ content: canonicalJson(prepare) }], commits: [] }), /RECOVERY_EVIDENCE_MISSING/);
  assert.throws(() => recoverTaskDocument({ taskId: action.taskId, snapshotSha256: shared.snapshotSha256, actions: [{ content: canonicalJson(action) }], prepares: [{ content: canonicalJson(prepare) }], commits: [{ content: canonicalJson(prepare) }] }), /RECOVERY_EVIDENCE_MISSING/);
  assert.throws(() => recoverTaskDocument({ taskId: action.taskId, snapshotSha256: shared.snapshotSha256, actions: [{ content: canonicalJson(action) }], prepares: [{ content: canonicalJson(commit) }], commits: [{ content: canonicalJson(commit) }] }), /RECOVERY_EVIDENCE_MISSING/);
});
