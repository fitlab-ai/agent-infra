import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseReworkIntentDocument,
  renderReworkIntents,
  consumeReworkIntents,
  supersedeReworkIntents,
  upsertReworkIntent,
  type ReworkIntent
} from '../../../lib/task/rework-intent.ts';

test('rework intent round-trips and duplicate identity is idempotent', () => {
  const intent: ReworkIntent = {
    intentId: 'RI-1', findingId: 'PL-1', sourceArtifact: 'review-plan.md',
    sourceSha256: 'a'.repeat(64), target: 'plan', status: 'pending',
    declaredAt: '2026-01-01 00:00:00+00:00', consumedAt: ''
  };
  const content = renderReworkIntents([intent]);
  const parsed = parseReworkIntentDocument(`## 返工意图\n\n${content}\n`);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.intents, [intent]);
  assert.deepEqual(upsertReworkIntent(parsed.intents, intent), { changed: false, intents: [intent] });
});

test('conflicting rework intent identity fails closed', () => {
  const existing: ReworkIntent = {
    intentId: 'RI-1', findingId: 'PL-1', sourceArtifact: 'review-plan.md',
    sourceSha256: 'a'.repeat(64), target: 'plan', status: 'pending',
    declaredAt: '2026-01-01 00:00:00+00:00', consumedAt: ''
  };
  assert.throws(
    () => upsertReworkIntent([existing], { ...existing, target: 'code' }),
    /identity conflicts/
  );
});

test('rework intents consume on matching target input and supersede on source replacement', () => {
  const intent: ReworkIntent = {
    intentId: 'RI-1', findingId: 'PL-1', sourceArtifact: 'review-plan.md',
    sourceSha256: 'a'.repeat(64), target: 'plan', status: 'pending',
    declaredAt: '2026-01-01 00:00:00+00:00', consumedAt: ''
  };
  const consumed = consumeReworkIntents([intent], 'plan', { 'review-plan.md': 'a'.repeat(64) }, '2026-01-01 00:01:00+00:00');
  assert.equal(consumed.changed, true);
  assert.equal(consumed.intents[0]?.status, 'consumed');
  const superseded = supersedeReworkIntents([intent], 'review-plan.md', 'b'.repeat(64), '2026-01-01 00:02:00+00:00');
  assert.equal(superseded.changed, true);
  assert.equal(superseded.intents[0]?.status, 'superseded');
});
