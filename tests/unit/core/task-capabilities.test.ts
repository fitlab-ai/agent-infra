import test from 'node:test';
import assert from 'node:assert/strict';

import { canStart, recommendNext, type ExplicitTrigger, type LifecycleFacts } from '../../../lib/task/capabilities.ts';

const trigger: ExplicitTrigger = {
  initiator: 'model', requestId: 'request-1', requestedAction: 'analysis',
  reasonCode: 'upstream-fact-doubt'
};

function facts(currentStep: string): LifecycleFacts {
  return {
    taskState: 'active', currentStep, artifacts: {
      analysis: [], 'review-analysis': [], plan: [], 'review-plan': [], code: [], 'review-code': []
    }, artifactHashes: {}, reviews: {}, invalidation: { operations: [], targets: [] },
    reworkIntents: [],
    unresolvedLedger: { analysis: 0, plan: 0, code: 0 }, executionBusy: false
  };
}

test('explicit trigger authorization does not depend on current_step', () => {
  const first = canStart('analysis', facts('requirement-analysis'), trigger);
  const second = canStart('analysis', facts('completed'), trigger);
  assert.equal(first.allowed, true);
  assert.equal(second.allowed, true);
});

test('recommendation facts cannot bypass a missing prerequisite', () => {
  const result = canStart('review-analysis', facts('requirement-analysis'), {
    ...trigger, requestedAction: 'review-analysis', reasonCode: 'user-request'
  });
  assert.equal(result.allowed, false);
  assert.equal(result.reasonCode, 'ANALYSIS_ARTIFACT_REQUIRED');
});

test('pending invalidation blocks lifecycle authorization', () => {
  const result = canStart('analysis', {
    ...facts('code'), invalidation: {
      operations: [{ status: 'pending' } as never], targets: []
    }
  }, trigger);
  assert.equal(result.allowed, false);
  assert.equal(result.reasonCode, 'INVALIDATION_INCOMPLETE');
});

test('recommendation is derived from lifecycle facts rather than current_step', () => {
  const first = recommendNext(facts('completed'));
  assert.equal(first.action, 'analysis');
  const withAnalysis = {
    ...facts('code-review'),
    artifacts: { ...facts('code-review').artifacts, analysis: ['analysis.md'] }
  };
  assert.equal(recommendNext(withAnalysis).action, 'review-analysis');
});

test('explicit source provenance requires a matching artifact hash', () => {
  const result = canStart('analysis', {
    ...facts('completed'), artifactHashes: { 'review-code.md': 'a'.repeat(64) }
  }, {
    ...trigger, sourceArtifact: 'review-code.md', sourceSha256: 'b'.repeat(64)
  });
  assert.equal(result.allowed, false);
  assert.equal(result.reasonCode, 'SOURCE_ARTIFACT_HASH_MISMATCH');
});
