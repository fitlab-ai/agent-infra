import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  consumeLifecycleFinalizationReceipt,
  readLifecycleFinalizationReceipt,
  recordLifecycleFinalizationReceipt
} from '../../../lib/task/lifecycle-finalization-receipt.ts';

const tuple = {
  taskId: 'TASK-20260101-000001', family: 'review-plan' as const,
  artifact: 'review-plan.md', round: 1,
  artifactSha256: 'a'.repeat(64), semanticDigest: 'b'.repeat(64),
  finalizer: 'review' as const, authorityMode: 'direct-host' as const, authorityDigest: null
};

test('finalization receipt reuses an identical operation and consumes once', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'finalization-receipt-'));
  try {
    const first = recordLifecycleFinalizationReceipt(root, tuple, { operationId: '1'.repeat(32), now: 1 });
    const replay = recordLifecycleFinalizationReceipt(root, tuple, { operationId: '2'.repeat(32), now: 2 });
    assert.equal(replay.operationId, first.operationId);
    const consumed = consumeLifecycleFinalizationReceipt(root, first, 3);
    assert.equal(consumed.state, 'consumed');
    assert.deepEqual(readLifecycleFinalizationReceipt(root, tuple.taskId, tuple.family, tuple.artifact), consumed);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('finalization receipt rejects changed bytes while an operation is pending', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'finalization-receipt-conflict-'));
  try {
    recordLifecycleFinalizationReceipt(root, tuple, { operationId: '1'.repeat(32), now: 1 });
    assert.throws(() => recordLifecycleFinalizationReceipt(root, {
      ...tuple, artifactSha256: 'c'.repeat(64)
    }, { operationId: '2'.repeat(32), now: 2 }), /LIFECYCLE_FINALIZATION_RECEIPT_CONFLICT/u);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('finalization receipt reclaims a lock left by a dead writer', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'finalization-receipt-stale-lock-'));
  try {
    const directory = path.join(root, '.agents', 'workspace', '.local-lifecycle-finalization-receipts');
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, `${tuple.taskId}-${tuple.family}-${tuple.artifact}.json.lock`), '');
    const receipt = recordLifecycleFinalizationReceipt(root, tuple, { operationId: '1'.repeat(32), now: 1 });
    assert.equal(receipt.state, 'pending');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
