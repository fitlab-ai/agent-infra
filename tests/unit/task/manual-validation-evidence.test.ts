import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MANUAL_VALIDATION_EVIDENCE_SCHEMA,
  createManualValidationEvidence,
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
});
