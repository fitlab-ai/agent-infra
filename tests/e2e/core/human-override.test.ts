import test from 'node:test';
import assert from 'node:assert/strict';

import {
  HUMAN_OVERRIDE_FAILURE_REGISTRY,
  failureId,
  resolveOutcome,
  stableFailureCatalog,
  validateRegistry
} from '../../../lib/task/human-override.ts';
import { lifecycleProducerCatalog } from '../../../lib/task/lifecycle.ts';
import { guardProducerCatalog } from '../../../lib/task/guard-override.ts';

test('human override registry is producer-qualified, complete, and structurally valid', () => {
  assert.doesNotThrow(() => validateRegistry());
  assert.equal(HUMAN_OVERRIDE_FAILURE_REGISTRY.length, lifecycleProducerCatalog.length + guardProducerCatalog.length);
  assert.equal(stableFailureCatalog.length, HUMAN_OVERRIDE_FAILURE_REGISTRY.length);
  assert.equal(new Set(stableFailureCatalog.map((item) => item.id)).size, stableFailureCatalog.length);
  assert.ok(stableFailureCatalog.every((item) => item.id === failureId(item.producerId, item.code)));
  assert.deepEqual(stableFailureCatalog, [...lifecycleProducerCatalog, ...guardProducerCatalog].map((item) => ({ ...item, id: failureId(item.producerId, item.code) })));
});

test('human override validation rejects duplicate facts reachable by one target', () => {
  const original = HUMAN_OVERRIDE_FAILURE_REGISTRY.find((policy) => policy.code === 'SHORT_ID_CAPACITY_EXCEEDED')!;
  const duplicate = { id: 'duplicate-context', facts: ['identity-confirmed-and-safe-close-proven'] };
  const overlapping = {
    ...original,
    contexts: [...original.contexts, duplicate],
    targetContexts: { ...original.targetContexts, 'safe-close': ['identity-confirmed-and-safe-close-proven', duplicate.id] },
    outcomes: [...original.outcomes, {
      target: 'safe-close', contextId: duplicate.id, effect: 'apply-target' as const,
      result: 'safe-closed' as const, residual: 'duplicate context must be rejected'
    }]
  };
  assert.throws(() => validateRegistry([overlapping]), /overlapping context facts/);
});

test('human override outcomes preserve the distinction between local approval and fail-closed recovery', () => {
  const approved = resolveOutcome('lifecycle.apply:LIFECYCLE_SOURCE_INVALID', 'continue-local', ['identity-confirmed']);
  assert.equal(approved.result, 'human-approved');
  assert.equal(approved.effect, 'apply-target');

  const unknown = resolveOutcome('lifecycle.apply:LIFECYCLE_SOURCE_INVALID', 'continue-local', ['unregistered-fact']);
  assert.equal(unknown.result, 'recovery-required');
  assert.equal(unknown.effect, 'no-write');
  assert.equal(unknown.contextId, 'context-unmatched');

  const never = resolveOutcome('lifecycle.apply:LIFECYCLE_IDENTITY_INVALID', 'record-only', ['identity-confirmed']);
  assert.equal(never.result, 'preserve-failure');
  assert.equal(never.effect, 'record-only');

  const localGuard = resolveOutcome('task-event:EVENT_TRANSITION_INVALID', 'continue-local', ['guard-observed']);
  assert.equal(localGuard.result, 'human-approved');
  assert.equal(localGuard.effect, 'apply-target');

  const externalGuard = resolveOutcome('platform.issue:PLATFORM_BIND_FAILED', 'continue-local', ['guard-observed']);
  assert.equal(externalGuard.result, 'preserve-failure');
  assert.equal(externalGuard.effect, 'record-only');
});
