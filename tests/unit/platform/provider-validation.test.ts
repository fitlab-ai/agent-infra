import test from 'node:test';
import assert from 'node:assert/strict';

import { validatePlatformProvider } from '../../../lib/platform/provider-contract.ts';
import { invokeProviderOperation, wrapProviderOperations } from '../../../lib/platform/provider-validation.ts';
import { serializeResourceIdentity } from '../../../lib/platform/resource-identity.ts';

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

test('provider identity serialization is canonical and declarations cover operation resource closure', () => {
  const left = { value: 'issue-42', kind: 'id' } as const;
  const right = { kind: 'id', value: 'issue-42' } as const;
  assert.equal(serializeResourceIdentity(left), '{"kind":"id","value":"issue-42"}');
  assert.equal(serializeResourceIdentity(left), serializeResourceIdentity(right));

  const noop = async () => ({ ok: true, value: {} });
  const result = validatePlatformProvider({
    type: 'trae',
    contractVersion: 1,
    identity: { comment: 'id' },
    context: { resolve: noop },
    comments: { list: noop, write: noop, delete: noop }
  }, 'trae');
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, 'PLATFORM_PROVIDER_CONTRACT_INVALID');
});

test('verification providers only declare identities consumed by verification', () => {
  const noop = async () => ({ ok: true, value: {} });
  const result = validatePlatformProvider({
    type: 'trae',
    contractVersion: 1,
    identity: { issue: 'id', 'pull-request': 'id' },
    context: { resolve: noop },
    verification: { fetchRemoteFacts: noop }
  }, 'trae');
  assert.equal(result.ok, true);
});

test('provider result validation rejects duplicate nested options, mismatched identities, and missing release identities', async () => {
  const metadata = {
    repository: { identity: { kind: 'id', value: 'repo' }, name: 'project', url: null },
    labels: [], milestones: [], issueTypes: [],
    fields: [{
      identity: { kind: 'id', value: 'field' }, name: 'Status', kind: 'single-select',
      options: [
        { identity: { kind: 'id', value: 'open' }, name: 'Open' },
        { identity: { kind: 'id', value: 'open' }, name: 'Duplicate' }
      ]
    }]
  };
  const issue = {
    id: 'issue-1', identity: { kind: 'id', value: 'issue-1' }, number: 1, title: '', body: '', state: 'open',
    labels: [], assignees: [], milestone: null, fields: {}
  };
  const provider = wrapProviderOperations({
    type: 'trae', contractVersion: 1,
    identity: { issue: 'number', 'pull-request': 'id', release: 'key' },
    context: { async resolve() { return { ok: true, value: {} }; } },
    issues: {
      async describeRepository() { return { ok: true, value: metadata }; },
      async inspect() { return { ok: true, value: issue }; },
      async create() { return { ok: true, value: { remoteId: 'issue-1', changed: false } }; },
      async update() { return { ok: true, value: { remoteId: 'issue-1', changed: false } }; }
    },
    releases: {
      async inspect() { return { ok: false, error: { code: 'RESOURCE_NOT_FOUND', message: 'not found', retryable: false } }; },
      async create() { return { ok: true, value: { remoteId: 'release-1', changed: false } }; },
      async update() { return { ok: true, value: { remoteId: 'release-1', changed: false } }; },
      async reconcileMilestones() { return { ok: true, value: { changed: false, created: [], closed: [] } }; },
      async publishNotes() { return { ok: true, value: { remoteId: 'notes-1', changed: false } }; },
      async collectNotes() {
        return {
          ok: true,
          value: {
            history: [],
            mergedPullRequests: [{ id: 'pr-1', state: 'merged', title: '', body: '' }],
            closingIssues: [],
            actors: []
          }
        };
      }
    }
  } as never);

  const duplicateOptions = await provider.issues!.describeRepository({} as never);
  assert.equal(duplicateOptions.ok, false);
  if (!duplicateOptions.ok) assert.equal(duplicateOptions.error.code, 'PLATFORM_PROVIDER_RESULT_INVALID');

  const mismatchedIdentity = await provider.issues!.inspect({} as never);
  assert.equal(mismatchedIdentity.ok, false);
  if (!mismatchedIdentity.ok) assert.equal(mismatchedIdentity.error.code, 'PLATFORM_PROVIDER_RESULT_INVALID');

  const missingReleaseIdentity = await provider.releases!.collectNotes({} as never);
  assert.equal(missingReleaseIdentity.ok, false);
  if (!missingReleaseIdentity.ok) assert.equal(missingReleaseIdentity.error.code, 'PLATFORM_PROVIDER_RESULT_INVALID');
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

test('optional security and repository metadata groups are validated without becoming required', async () => {
  const provider = wrapProviderOperations({
    type: 'trae',
    contractVersion: 1,
    context: { async resolve() { return { ok: true, value: { type: 'trae', scope: { id: 'scope' }, currentUser: null, capabilities: { authenticated: false, comment: false, triage: false, push: false, admin: false }, authenticated: false } }; } },
    securityAlerts: {
      async inspect() { return { ok: true, value: { kind: 'dependabot', number: 7, state: 'open', data: { number: 7 } } }; },
      async dismiss() { return { ok: true, value: { remoteId: '7', changed: true } }; }
    },
    repositoryMetadata: {
      async reconcileLabels() { return { ok: true, value: { changed: false, created: [], updated: [], removed: [], skipped: ['type: task'] } }; },
      async reconcileMilestones() { return { ok: true, value: { changed: false, created: [], skipped: ['General Backlog'] } }; }
    }
  } as never);
  const security = await provider.securityAlerts!.inspect({} as never);
  assert.equal(security.ok, true);
  const labels = await provider.repositoryMetadata!.reconcileLabels({} as never);
  assert.equal(labels.ok, true);
  const invalid = wrapProviderOperations({
    type: 'trae', contractVersion: 1,
    context: { async resolve() { return { ok: true, value: { type: 'trae', scope: { id: 'scope' }, currentUser: null, capabilities: { authenticated: false, comment: false, triage: false, push: false, admin: false }, authenticated: false } }; } },
    securityAlerts: {
      async inspect() { return { ok: true, value: { kind: 'dependabot', number: 0, state: 'open', data: null } }; },
      async dismiss() { return { ok: true, value: { remoteId: '7', changed: true } }; }
    }
  } as never);
  const invalidAlert = await invalid.securityAlerts!.inspect({} as never);
  assert.equal(invalidAlert.ok, false);
  if (!invalidAlert.ok) assert.equal(invalidAlert.error.code, 'PLATFORM_PROVIDER_RESULT_INVALID');
});
