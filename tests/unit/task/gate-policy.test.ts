import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeVerificationRecord } from '../../../lib/task/gate-policy.ts';

test('optional platform audits retain their raw failure without blocking the gate', () => {
  const result = normalizeVerificationRecord({
    type: 'platform-sync', checkId: 'platform.milestone', status: 'blocked',
    message: 'Milestone audit skipped because triage capability is unavailable', fail_type: 'TRIAGE_REQUIRED'
  });
  assert.equal(result.classification, 'soft');
  assert.equal(result.status, 'blocked');
  assert.equal(result.effectiveStatus, 'pass');
  assert.equal(result.reason, 'TRIAGE_REQUIRED');
});

test('unknown checks remain hard and preserve failed gate semantics', () => {
  const result = normalizeVerificationRecord({ type: 'artifact', status: 'fail', message: 'Artifact is invalid' });
  assert.equal(result.classification, 'hard');
  assert.equal(result.effectiveStatus, 'fail');
});
