import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MANUAL_VALIDATION_EVIDENCE_SCHEMA,
  createManualValidationEvidence,
  manualValidationEvidenceDigest,
  validateManualValidationEvidence
} from '../../../lib/task/manual-validation-evidence.ts';

const baseInput = {
  mode: 'branch-only' as const,
  taskId: null,
  branch: 'agent-infra-feature-example',
  commit: 'a'.repeat(40),
  recoverable: false,
  scope: 'snapshot' as const,
  command: 'node',
  startedAt: '2026-09-10T00:00:00.000Z',
  completedAt: '2026-09-10T00:00:01.000Z',
  exitCode: 0,
  signal: null,
  cleanup: 'completed' as const
};

test('manual-validation evidence creates the current allowlisted envelope', () => {
  const evidence = createManualValidationEvidence(baseInput);
  assert.equal(evidence.schema, MANUAL_VALIDATION_EVIDENCE_SCHEMA);
  assert.equal(evidence.version, 1);
  assert.equal(evidence.mode, 'branch-only');
  assert.equal(evidence.taskId, null);
  assert.equal(evidence.recoverable, false);
  assert.deepEqual(validateManualValidationEvidence(evidence), { ok: true, value: evidence });
  assert.match(manualValidationEvidenceDigest(evidence), /^[a-f0-9]{64}$/);
});

test('manual-validation evidence rejects unknown fields and stale identity', () => {
  const evidence = createManualValidationEvidence({ ...baseInput, mode: 'task-bound', taskId: 'TASK-20260910-000001', recoverable: true });
  const withUnknown = { ...evidence, transcript: '/private/path' };
  const invalid = validateManualValidationEvidence(withUnknown);
  assert.equal(invalid.ok, false);
  if (!invalid.ok) assert.equal(invalid.error.code, 'MANUAL_VALIDATION_EVIDENCE_INVALID');

  const mismatch = validateManualValidationEvidence(evidence, {
    taskId: 'TASK-20260910-000002',
    branch: evidence.branch,
    commit: evidence.commit
  });
  assert.equal(mismatch.ok, false);
  if (!mismatch.ok) assert.equal(mismatch.error.code, 'MANUAL_VALIDATION_EVIDENCE_IDENTITY_MISMATCH');
});

test('manual-validation evidence rejects unsuccessful validation results', () => {
  const evidence = createManualValidationEvidence({ ...baseInput, exitCode: 1 });
  const result = validateManualValidationEvidence(evidence);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, 'MANUAL_VALIDATION_EVIDENCE_UNSUCCESSFUL');
});
