import fs from 'node:fs';

function recordCall(config, operation) {
  if (typeof config.callsPath === 'string') fs.appendFileSync(config.callsPath, `${operation}\n`);
}

function receipt(id, changed = true) {
  return { ok: true, value: { remoteId: id, changed } };
}

function wrongTarget(message) {
  return { ok: false, error: { code: 'WRONG_TARGET', message, retryable: false } };
}

function configuredIdentity(config, resource, number) {
  const kind = config.identityKind || 'number';
  return kind === 'number' ? { kind, value: number } : { kind, value: resource === 'change' ? String(number) : `${resource}-${number}` };
}

function issue(config, labels) {
  return {
    id: 'issue-7',
    identity: configuredIdentity(config, 'issue', 7),
    number: 7,
    title: 'External Issue',
    body: '',
    state: 'open',
    labels,
    assignees: [],
    milestone: null,
    fields: {},
    displayUrl: 'https://external.example/issues/7'
  };
}

function changeRequest(config, labels) {
  return {
    id: 'change-1',
    identity: configuredIdentity(config, 'change', 1),
    number: 1,
    state: 'open',
    title: 'External Change',
    body: '',
    headSha: 'a'.repeat(40),
    baseSha: 'b'.repeat(40),
    displayUrl: 'https://external.example/changes/1',
    draft: false,
    labels,
    assignees: [],
    milestone: null,
    mergeCommitSha: null,
    mergeability: { state: 'unknown', detail: null },
    head: { repository: 'external/project', ref: 'feature', sha: 'a'.repeat(40) },
    base: { repository: 'external/project', ref: 'main', sha: 'b'.repeat(40) }
  };
}

export default async function createPlatformProvider(input) {
  const config = input.config || {};
  let issueLabels = ['in: core', 'keep'];
  let pullRequestLabels = ['in: stale', 'type: feature'];
  const context = {
    type: input.providerType,
    scope: { id: 'external/project', label: 'external/project' },
    currentUser: { id: 'external-user' },
    capabilities: { authenticated: true, comment: true, triage: true, push: true, admin: false },
    authenticated: true
  };
  const issueIdentity = configuredIdentity(config, 'issue', 7);
  const pullRequestIdentity = configuredIdentity(config, 'change', 1);
  return {
    type: input.providerType,
    contractVersion: input.contractVersion,
    identity: { issue: config.identityKind || 'number', 'pull-request': config.identityKind || 'number' },
    context: {
      async resolve() {
        recordCall(config, 'context.resolve');
        return { ok: true, value: context };
      }
    },
    issues: {
      async listLabels() {
        recordCall(config, 'issues.listLabels');
        return { ok: true, value: ['in: core', 'in: stale'] };
      },
      async describeRepository() {
        recordCall(config, 'issues.describeRepository');
        return {
          ok: true,
          value: {
            repository: { identity: { kind: 'key', value: 'external/project' }, name: 'external/project', url: null },
            labels: [], milestones: [], issueTypes: [], fields: []
          }
        };
      },
      async inspect(request) {
        recordCall(config, 'issues.inspect');
        if (JSON.stringify(request.target) !== JSON.stringify(issueIdentity)) return wrongTarget('Issue inspect target identity was not preserved');
        return { ok: true, value: issue(config, issueLabels) };
      },
      async create() {
        recordCall(config, 'issues.create');
        return receipt('issue-created');
      },
      async update(request) {
        recordCall(config, 'issues.update');
        if (JSON.stringify(request.target) !== JSON.stringify(issueIdentity)) {
          return wrongTarget('Issue update target identity was not preserved');
        }
        if (request.mutation.idempotencyKey !== `issue:update:${JSON.stringify(issueIdentity)}:in-labels`) {
          return wrongTarget('Issue mutation identity was not preserved');
        }
        issueLabels = request.patch.labels || issueLabels;
        return receipt('issue-updated');
      }
    },
    changeRequests: {
      async inspect(request) {
        recordCall(config, 'changeRequests.inspect');
        if (JSON.stringify(request.target) !== JSON.stringify(pullRequestIdentity)) return wrongTarget('Change request inspect target identity was not preserved');
        return { ok: true, value: changeRequest(config, pullRequestLabels) };
      },
      async listFiles(request) {
        recordCall(config, 'changeRequests.listFiles');
        if (JSON.stringify(request.target) !== JSON.stringify(pullRequestIdentity)) return wrongTarget('Change request files target identity was not preserved');
        return { ok: true, value: ['lib/core.ts'] };
      },
      async listClosingIssues(request) {
        recordCall(config, 'changeRequests.listClosingIssues');
        if (JSON.stringify(request.target) !== JSON.stringify(pullRequestIdentity)) return wrongTarget('Closing issues target identity was not preserved');
        return { ok: true, value: [issueIdentity] };
      },
      async listClosing() {
        recordCall(config, 'changeRequests.listClosing');
        return { ok: true, value: [] };
      },
      async create() {
        recordCall(config, 'changeRequests.create');
        return receipt('change-created');
      },
      async update(request) {
        recordCall(config, 'changeRequests.update');
        if (JSON.stringify(request.target) !== JSON.stringify(pullRequestIdentity)) {
          return wrongTarget('Change request update target identity was not preserved');
        }
        if (request.mutation.idempotencyKey !== `pull-request:update:${JSON.stringify(pullRequestIdentity)}:in-labels`) {
          return wrongTarget('Change request mutation identity was not preserved');
        }
        pullRequestLabels = request.patch.labels || pullRequestLabels;
        return receipt('change-updated');
      },
      async resolveGitEvidence() {
        recordCall(config, 'changeRequests.resolveGitEvidence');
        return { ok: true, value: { remoteUrl: 'https://external.example/project', reviewedHeadRef: 'refs/heads/feature', targetHeadRef: 'refs/heads/main' } };
      }
    },
    verification: {
      async fetchRemoteFacts() {
        recordCall(config, 'verification.fetchRemoteFacts');
        return { ok: true, value: { issue: issue(config, issueLabels), comments: [], changeRequest: changeRequest(config, pullRequestLabels), commit: null, fields: {} } };
      }
    }
  };
}
