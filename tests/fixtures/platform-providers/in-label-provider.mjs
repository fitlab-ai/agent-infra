import fs from 'node:fs';

function recordCall(config, operation) {
  if (typeof config.callsPath === 'string') fs.appendFileSync(config.callsPath, `${operation}\n`);
}

function receipt(id, changed = true) {
  return { ok: true, value: { remoteId: id, changed } };
}

function issue(labels) {
  return {
    id: 'issue-7',
    identity: { kind: 'number', value: 7 },
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

function changeRequest(labels) {
  return {
    id: 'change-1',
    identity: { kind: 'number', value: 1 },
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
  return {
    type: input.providerType,
    contractVersion: input.contractVersion,
    identity: { issue: 'number', 'pull-request': 'number' },
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
      async inspect() {
        recordCall(config, 'issues.inspect');
        return { ok: true, value: issue(issueLabels) };
      },
      async create() {
        recordCall(config, 'issues.create');
        return receipt('issue-created');
      },
      async update(request) {
        recordCall(config, 'issues.update');
        issueLabels = request.patch.labels || issueLabels;
        return receipt('issue-updated');
      }
    },
    changeRequests: {
      async inspect() {
        recordCall(config, 'changeRequests.inspect');
        return { ok: true, value: changeRequest(pullRequestLabels) };
      },
      async listFiles() {
        recordCall(config, 'changeRequests.listFiles');
        return { ok: true, value: ['lib/core.ts'] };
      },
      async listClosingIssues() {
        recordCall(config, 'changeRequests.listClosingIssues');
        return { ok: true, value: [{ kind: 'number', value: 7 }] };
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
        return { ok: true, value: { issue: issue(issueLabels), comments: [], changeRequest: changeRequest(pullRequestLabels), commit: null, fields: {} } };
      }
    }
  };
}
