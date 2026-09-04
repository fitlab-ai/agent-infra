import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildBoundFact,
  buildSkippedFact,
  buildUnboundFact,
  decodePrDeliveryFact,
  encodePrDeliveryFact,
  factFrontmatterMutation,
  readPrDeliveryFact
} from '../../../lib/task/pr-delivery-fact.ts';
import { LEGACY_COMPATIBILITY_CUTOFF_VERSION, isLegacyCompatibilityEnabled } from '../../../lib/version.ts';

const identity = {
  resource: { kind: 'number' as const, value: 42 },
  repository: 'acme/widgets',
  url: 'https://github.com/acme/widgets/pull/42',
  head: { repository: 'acme/widgets', ref: 'feature/fact', sha: 'a'.repeat(40) },
  base: { repository: 'acme/widgets', ref: 'main', sha: 'b'.repeat(40) }
};

test('PR delivery fact round-trips each legal state', () => {
  const facts = [
    buildUnboundFact(),
    buildSkippedFact('2026-09-01T00:00:00.000Z'),
    buildBoundFact({
      identity,
      source: 'created',
      verifiedAt: '2026-09-01T00:00:00.000Z',
      issueIdentity: { kind: 'number', value: 7 } as const,
      remoteState: 'open'
    })
  ];
  for (const fact of facts) assert.deepEqual(decodePrDeliveryFact(encodePrDeliveryFact(fact)), fact);
});

test('legacy v1 delivery facts decode to the current v2 shape before the stable cutoff', () => {
  const legacyBound = {
    version: 1,
    state: 'bound',
    identity: {
      repository: 'acme/widgets', number: 42, nodeId: 'PR_42', url: 'https://github.com/acme/widgets/pull/42',
      head: { repository: 'acme/widgets', ref: 'feature/fact', sha: 'a'.repeat(40) },
      base: { repository: 'acme/widgets', ref: 'main', sha: 'b'.repeat(40) }
    },
    binding: {
      status: 'verified', source: 'created', verifiedAt: '2026-09-01T00:00:00.000Z', issueNumber: 7,
      remoteState: 'open', mergedAt: null, mergeCommitSha: null
    },
    provenance: { establishedBy: 'create-post' }
  };
  assert.equal(isLegacyCompatibilityEnabled('v0.9.13-alpha.0'), true);
  assert.deepEqual(decodePrDeliveryFact({ version: 1, state: 'unbound', reason: 'initial' }), {
    version: 2, state: 'unbound', reason: 'initial'
  });
  assert.deepEqual(decodePrDeliveryFact({ version: 1, state: 'skipped', reason: 'explicit', decidedAt: '2026-09-01T00:00:00.000Z' }), {
    version: 2, state: 'skipped', reason: 'explicit', decidedAt: '2026-09-01T00:00:00.000Z'
  });
  assert.deepEqual(decodePrDeliveryFact(legacyBound), {
    version: 2,
    state: 'bound',
    identity: {
      resource: { kind: 'number', value: 42 },
      repository: 'acme/widgets', url: 'https://github.com/acme/widgets/pull/42',
      head: { repository: 'acme/widgets', ref: 'feature/fact', sha: 'a'.repeat(40) },
      base: { repository: 'acme/widgets', ref: 'main', sha: 'b'.repeat(40) }
    },
    binding: {
      status: 'verified', source: 'created', verifiedAt: '2026-09-01T00:00:00.000Z',
      issueIdentity: { kind: 'number', value: 7 }, remoteState: 'open', mergedAt: null, mergeCommitSha: null
    },
    provenance: { establishedBy: 'create-post' }
  });
});

test('legacy v1 delivery facts fail with an actionable error at the stable cutoff', () => {
  assert.equal(isLegacyCompatibilityEnabled(`v${LEGACY_COMPATIBILITY_CUTOFF_VERSION}`), false);
  assert.equal(isLegacyCompatibilityEnabled('v1.0.1'), false);
  const legacy = JSON.stringify({ version: 1, state: 'unbound', reason: 'initial' });
  assert.throws(
    () => decodePrDeliveryFact({ version: 1, state: 'unbound', reason: 'initial' }, `v${LEGACY_COMPATIBILITY_CUTOFF_VERSION}`),
    (error: unknown) => error instanceof Error
      && 'code' in error
      && error.code === 'PLATFORM_IDENTITY_LEGACY_UNSUPPORTED'
      && error.message.includes('current schema')
  );
  assert.throws(
    () => decodePrDeliveryFact(legacy, `v${LEGACY_COMPATIBILITY_CUTOFF_VERSION}`),
    (error: unknown) => error instanceof Error
      && 'code' in error
      && error.code === 'PLATFORM_IDENTITY_LEGACY_UNSUPPORTED'
  );
  const read = readPrDeliveryFact({ pr_delivery_fact: legacy }, `v${LEGACY_COMPATIBILITY_CUTOFF_VERSION}`);
  assert.equal(read.status, 'invalid');
  if (read.status === 'invalid') assert.equal(read.error.code, 'PLATFORM_IDENTITY_LEGACY_UNSUPPORTED');
});

test('PR delivery fact rejects state-specific omissions and call-level fields', () => {
  const valid = buildBoundFact({
    identity,
    source: 'reused',
    verifiedAt: '2026-09-01T00:00:00.000Z',
    remoteState: 'open'
  });
  assert.throws(() => decodePrDeliveryFact(JSON.stringify({ ...valid, createdByCurrentOperation: true })), /PR_DELIVERY_FACT_INVALID/);
  assert.throws(() => decodePrDeliveryFact(JSON.stringify({ version: 1, state: 'skipped', reason: 'initial' })), /PR_DELIVERY_FACT_INVALID/);
  assert.deepEqual(decodePrDeliveryFact(JSON.stringify({ version: 2, state: 'unbound', reason: 'initial' })), { version: 2, state: 'unbound', reason: 'initial' });
  assert.throws(() => decodePrDeliveryFact(JSON.stringify({
    ...valid,
    provenance: { establishedBy: 'create-post' }
  })), /PR_DELIVERY_FACT_INVALID/);
});

test('each binding source has its matching durable provenance', () => {
  for (const source of ['created', 'reused', 'explicit-bind', 'external-unique', 'external-explicit'] as const) {
    const fact = buildBoundFact({
      identity,
      source,
      verifiedAt: '2026-09-01T00:00:00.000Z',
      remoteState: 'open'
    });
    const decoded = decodePrDeliveryFact(encodePrDeliveryFact(fact));
    assert.equal(decoded.state, 'bound');
    if (decoded.state !== 'bound') continue;
    assert.equal(decoded.provenance.establishedBy, source === 'created' ? 'create-post' : source === 'reused' ? 'reuse' : source);
  }
});

test('fact accessor distinguishes missing, valid, and invalid frontmatter values', () => {
  assert.deepEqual(readPrDeliveryFact({}), { status: 'missing', fact: null });
  const fact = buildUnboundFact();
  assert.deepEqual(readPrDeliveryFact({ pr_delivery_fact: encodePrDeliveryFact(fact) }), { status: 'valid', fact });
  assert.equal(readPrDeliveryFact({ pr_delivery_fact: '{invalid' }).status, 'invalid');
});

test('bound provenance remains stable across a later no-op result', () => {
  const fact = buildBoundFact({
    identity,
    source: 'created',
    verifiedAt: '2026-09-01T00:00:00.000Z',
    remoteState: 'open'
  });
  const replay = { kind: 'no-op' as const, createdByCurrentOperation: false as const };
  assert.equal(replay.createdByCurrentOperation, false);
  assert.equal(fact.state, 'bound');
  assert.equal(fact.provenance.establishedBy, 'create-post');
});

test('fact mutation stores one JSON scalar', () => {
  const mutation = factFrontmatterMutation(buildUnboundFact());
  assert.equal(typeof mutation.set.pr_delivery_fact, 'string');
  assert.deepEqual(JSON.parse(mutation.set.pr_delivery_fact), { version: 2, state: 'unbound', reason: 'initial' });
});
