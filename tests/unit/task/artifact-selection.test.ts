import test from 'node:test';
import assert from 'node:assert/strict';

import { selectArtifactDisposition } from '../../../lib/task/artifact-selection.ts';

test('artifact selection reuses a completed result after one-time evidence disappears', () => {
  const selected = selectArtifactDisposition({
    next: { family: 'review-plan', round: 2, name: 'review-plan-r2.md' },
    latest: { family: 'review-plan', round: 1, name: 'review-plan.md' },
    open: false,
    hasChangeEvidence: false
  });
  assert.equal(selected.disposition, 'reuse');
  assert.equal(selected.writeRequired, false);
  assert.equal(selected.artifact.name, 'review-plan.md');
});

test('artifact selection creates exactly one next round for new evidence', () => {
  const selected = selectArtifactDisposition({
    next: { family: 'review-plan', round: 2, name: 'review-plan-r2.md' },
    latest: { family: 'review-plan', round: 1, name: 'review-plan.md' },
    open: false,
    hasChangeEvidence: true
  });
  assert.equal(selected.disposition, 'create');
  assert.equal(selected.artifact.name, 'review-plan-r2.md');
  assert.equal(selected.reasonCode, 'change-evidence');
});

test('artifact selection reuses existing history without extra state', () => {
  const selected = selectArtifactDisposition({
    next: { family: 'plan', round: 2, name: 'plan-r2.md' },
    latest: { family: 'plan', round: 1, name: 'plan.md' },
    open: false,
    hasChangeEvidence: false
  });
  assert.equal(selected.disposition, 'reuse');
  assert.equal(selected.reasonCode, 'history-matched');
});
