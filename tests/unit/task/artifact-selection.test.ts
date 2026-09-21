import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildArtifactInputDigest,
  parseCompletionFacts,
  selectArtifactDisposition
} from '../../../lib/task/artifact-selection.ts';

const SHA = 'a'.repeat(64);

test('artifact input digest excludes one-time change evidence', () => {
  const base = {
    family: 'review-plan' as const,
    taskInput: 'stable task input',
    lifecyclePath: 'full',
    upstream: [{ family: 'plan' as const, artifact: 'plan.md', round: 1, sha256: SHA, relation: 'reviewed-input' }]
  };
  assert.equal(
    buildArtifactInputDigest({ ...base, changeEvidenceDigest: null }),
    buildArtifactInputDigest({ ...base, changeEvidenceDigest: 'b'.repeat(64) })
  );
});

test('artifact selection reuses a completed result after one-time evidence disappears', () => {
  const inputDigest = 'b'.repeat(64);
  const resultDigest = 'c'.repeat(64);
  const selected = selectArtifactDisposition({
    family: 'review-plan',
    next: { family: 'review-plan', round: 2, name: 'review-plan-r2.md' },
    latest: { family: 'review-plan', round: 1, name: 'review-plan.md' },
    open: false,
    inputDigest,
    resultDigest,
    changeEvidenceDigest: null,
    completionFact: {
      version: 2,
      event: 'review-plan.completed',
      output: 'review-plan.md',
      outputSha256: SHA,
      semanticDigest: SHA,
      requestId: 'request-1',
      result: '{}',
      inputDigest,
      resultDigest,
      changeEvidenceDigest: 'd'.repeat(64),
      selectionReason: 'change-evidence'
    }
  });
  assert.equal(selected.disposition, 'reuse-completed');
  assert.equal(selected.writeRequired, false);
  assert.equal(selected.artifact.name, 'review-plan.md');
});

test('artifact selection creates exactly one next round for new evidence', () => {
  const inputDigest = 'b'.repeat(64);
  const resultDigest = 'c'.repeat(64);
  const selected = selectArtifactDisposition({
    family: 'review-plan',
    next: { family: 'review-plan', round: 2, name: 'review-plan-r2.md' },
    latest: { family: 'review-plan', round: 1, name: 'review-plan.md' },
    open: false,
    inputDigest,
    resultDigest,
    changeEvidenceDigest: 'e'.repeat(64),
    completionFact: {
      version: 2,
      event: 'review-plan.completed', output: 'review-plan.md', outputSha256: SHA,
      semanticDigest: SHA, requestId: 'request-1', result: '{}', inputDigest,
      resultDigest, changeEvidenceDigest: null, selectionReason: 'initial'
    }
  });
  assert.equal(selected.disposition, 'create-next');
  assert.equal(selected.artifact.name, 'review-plan-r2.md');
  assert.equal(selected.reasonCode, 'change-evidence');
});

test('completion fact parser fails closed for old facts', () => {
  const parsed = parseCompletionFacts(JSON.stringify([{
    event: 'plan.completed', output: 'plan.md', outputSha256: SHA,
    semanticDigest: SHA, requestId: 'request-1', result: '{}'
  }]));
  assert.equal(parsed.ok, false);
  if (!parsed.ok) assert.equal(parsed.code, 'ARTIFACT_SELECTION_FACT_VERSION_UNSUPPORTED');
});
