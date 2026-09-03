function identity(value) {
  return { kind: 'id', value };
}

function issue(value = 'issue-42') {
  return {
    id: value,
    identity: identity(value),
    title: 'Opaque issue',
    body: '',
    state: 'open',
    labels: [],
    assignees: [],
    milestone: null,
    fields: {},
    displayUrl: `https://opaque.example/issues/${value}`
  };
}

function changeRequest(value = 'pr-42') {
  return {
    id: value,
    identity: identity(value),
    title: 'Opaque change request',
    body: '',
    state: 'open',
    headSha: '1111111',
    baseSha: '2222222',
    head: { repository: 'opaque/project', ref: 'feature', sha: '1111111' },
    base: { repository: 'opaque/project', ref: 'main', sha: '2222222' },
    displayUrl: `https://opaque.example/changes/${value}`,
    draft: false,
    labels: [],
    assignees: [],
    milestone: null,
    mergedAt: null,
    mergeCommitSha: null
  };
}

function receipt(value = 'receipt') {
  return { ok: true, value: { remoteId: value, changed: true } };
}

export default async function createPlatformProvider(input) {
  const context = {
    type: input.providerType,
    scope: { id: 'opaque/project', label: 'opaque/project' },
    currentUser: { id: 'opaque-user' },
    capabilities: { authenticated: true, comment: true, triage: true, push: true, admin: false },
    authenticated: true
  };
  return {
    type: input.providerType,
    contractVersion: input.contractVersion,
    identity: { issue: 'id', 'pull-request': 'id', comment: 'id', release: 'key' },
    context: { async resolve() { return { ok: true, value: context }; } },
    issues: {
      async describeRepository() { return { ok: true, value: { repository: { identity: identity('repository'), name: 'opaque/project', url: 'https://opaque.example/project' }, labels: [], milestones: [], issueTypes: [], fields: [] } }; },
      async inspect(request) { return { ok: true, value: issue(request.target.value) }; },
      async create() { return receipt('issue-created'); },
      async update() { return receipt('issue-updated'); }
    },
    comments: {
      async list() { return { ok: true, value: [] }; },
      async write() { return receipt('comment-written'); },
      async delete() { return receipt('comment-deleted'); }
    },
    changeRequests: {
      async inspect(request) { return { ok: true, value: changeRequest(request.target.value) }; },
      async listClosing() { return { ok: true, value: [] }; },
      async create() { return receipt('pr-created'); },
      async update() { return receipt('pr-updated'); },
      async resolveGitEvidence() { return { ok: true, value: { remoteUrl: 'https://opaque.example/project', reviewedHeadRef: 'refs/heads/feature', targetHeadRef: 'refs/heads/main' } }; }
    },
    checks: {
      async inspectRequired() { return { ok: true, value: [] }; },
      async resolveRun() { return { ok: true, value: { name: 'check', status: 'completed', runId: 'run-1' } }; },
      async fetchLogs() { return { ok: true, value: { runId: 'run-1', text: '' } }; }
    },
    reviews: {
      async list() { return { ok: true, value: [] }; },
      async publish() { return receipt('review-published'); }
    },
    verification: {
      async fetchRemoteFacts() { return { ok: true, value: { issue: issue(), comments: [], changeRequest: changeRequest(), commit: null, fields: {} } }; }
    }
  };
}
