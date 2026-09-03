import test from 'node:test';
import assert from 'node:assert/strict';

import { validatePlatformProvider } from '../../../lib/platform/provider-contract.ts';
import { invokeProviderOperation, wrapProviderOperations } from '../../../lib/platform/provider-validation.ts';

test('provider invocation maps throws and malformed envelopes to stable failures', async () => {
  const thrown = await invokeProviderOperation('trae', 'issues.inspect', async () => { throw new Error('secret token'); }, (value) => value as never);
  assert.equal(thrown.ok, false);
  if (!thrown.ok) {
    assert.equal(thrown.error.code, 'PLATFORM_PROVIDER_OPERATION_FAILED');
    assert.equal(thrown.error.providerType, 'trae');
    assert.equal(thrown.error.phase, 'issues.inspect');
    assert.doesNotMatch(thrown.error.message, /secret token/);
  }

  const envelope = await invokeProviderOperation('trae', 'issues.inspect', async () => ({ ok: true, value: null }), () => { throw new Error('invalid snapshot'); });
  assert.equal(envelope.ok, false);
  if (!envelope.ok) assert.equal(envelope.error.code, 'PLATFORM_PROVIDER_RESULT_INVALID');
});

test('provider invocation preserves structured provider errors and retryability', async () => {
  const result = await invokeProviderOperation('trae', 'issues.inspect', async () => ({ ok: false, error: { code: 'REMOTE_BUSY', message: 'try later', retryable: true } }), (value) => value as never);
  assert.deepEqual(result, { ok: false, error: { code: 'REMOTE_BUSY', message: 'Platform provider is temporarily busy', retryable: true, providerType: 'trae', phase: 'issues.inspect' } });
});

test('provider metadata is sorted by identity and rejects duplicate identities', async () => {
  const metadata = {
    repository: { identity: { kind: 'id', value: 'repo' }, name: 'project', url: null },
    labels: [
      { identity: { kind: 'key', value: 'b' }, name: 'B' },
      { identity: { kind: 'key', value: 'a' }, name: 'A' }
    ],
    milestones: [], issueTypes: [], fields: []
  };
  const provider = wrapProviderOperations({
    type: 'trae', contractVersion: 1, identity: { issue: 'id' },
    context: { async resolve() { return { ok: true, value: { type: 'trae', scope: { id: 'scope' }, currentUser: null, capabilities: { authenticated: true, comment: false, triage: false, push: false, admin: false }, authenticated: true } }; } },
    issues: {
      async describeRepository() { return { ok: true, value: metadata }; },
      async inspect() { return { ok: false, error: { code: 'UNUSED', message: 'unused', retryable: false } }; },
      async create() { return { ok: false, error: { code: 'UNUSED', message: 'unused', retryable: false } }; },
      async update() { return { ok: false, error: { code: 'UNUSED', message: 'unused', retryable: false } }; }
    }
  } as never);
  const sorted = await provider.issues!.describeRepository({} as never);
  assert.equal(sorted.ok, true);
  if (sorted.ok) assert.deepEqual(sorted.value.labels.map((entry) => entry.name), ['A', 'B']);

  metadata.labels.push({ identity: { kind: 'key', value: 'a' }, name: 'duplicate' });
  const duplicate = await provider.issues!.describeRepository({} as never);
  assert.equal(duplicate.ok, false);
  if (!duplicate.ok) assert.equal(duplicate.error.code, 'PLATFORM_PROVIDER_RESULT_INVALID');
});

test('provider groups require a primary identity declaration for their resources', () => {
  const noop = async () => ({ ok: true, value: {} });
  const result = validatePlatformProvider({
    type: 'trae',
    contractVersion: 1,
    context: { resolve: noop },
    issues: { inspect: noop, create: noop, update: noop, describeRepository: noop }
  }, 'trae');
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, 'PLATFORM_PROVIDER_CONTRACT_INVALID');
});

test('provider operation validation rejects coercion, context mismatch, and raw error details', async () => {
  const provider = wrapProviderOperations({
    type: 'trae',
    contractVersion: 1,
    context: {
      async resolve() {
        return {
          ok: true,
          value: {
            type: 'wrong-provider',
            scope: { id: 'scope' },
            currentUser: null,
            capabilities: { authenticated: true, comment: true, triage: true, push: true, admin: true },
            authenticated: true
          }
        };
      }
    },
    releases: {
      async inspect() {
        return { ok: true, value: { id: 'r1', tag: 'v1', title: '', body: '', draft: 'false', prerelease: 0, publishedAt: null } };
      },
      async create() { return { ok: true, value: { remoteId: 'r1', changed: false } }; },
      async update() { return { ok: true, value: { remoteId: 'r1', changed: false } }; },
      async reconcileMilestones() { return { ok: true, value: { changed: 'false', created: [], closed: [] } }; },
      async publishNotes() { return { ok: true, value: { remoteId: 'r1', changed: false } }; },
      async collectNotes() { return { ok: true, value: { history: [], mergedPullRequests: [], closingIssues: [], actors: [] } }; }
    }
  } as never);

  const context = await provider.context.resolve({} as never);
  assert.equal(context.ok, false);
  const release = await provider.releases!.inspect({} as never);
  assert.equal(release.ok, false);
  const milestones = await provider.releases!.reconcileMilestones({} as never);
  assert.equal(milestones.ok, false);

  const failureProvider = wrapProviderOperations({
    type: 'trae',
    contractVersion: 1,
    context: { async resolve() { return { ok: true, value: {} }; } },
    releases: {
      async inspect() {
        return { ok: false, error: { code: 'RAW_SECRET', message: 'token=fake-supersecret', retryable: true } };
      },
      async create() { return { ok: true, value: { remoteId: 'r1', changed: false } }; },
      async update() { return { ok: true, value: { remoteId: 'r1', changed: false } }; },
      async reconcileMilestones() { return { ok: true, value: { changed: false, created: [], closed: [] } }; },
      async publishNotes() { return { ok: true, value: { remoteId: 'r1', changed: false } }; },
      async collectNotes() { return { ok: true, value: { history: [], mergedPullRequests: [], closingIssues: [], actors: [] } }; }
    }
  } as never);
  const failure = await failureProvider.releases!.inspect({} as never);
  assert.equal(failure.ok, false);
  if (!failure.ok) {
    assert.equal(failure.error.code, 'PLATFORM_PROVIDER_OPERATION_FAILED');
    assert.equal(failure.error.retryable, false);
    assert.doesNotMatch(failure.error.message, /fake-supersecret/);
  }
});
