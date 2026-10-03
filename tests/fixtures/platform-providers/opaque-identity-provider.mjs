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

function changeRequest(value = 'pr-42', config = {}) {
  const repository = config.repository || 'opaque/project';
  const headSha = config.headSha || '1111111';
  const baseSha = config.baseSha || '2222222';
  return {
    id: value,
    identity: identity(value),
    ...(config.number === undefined ? {} : { number: config.number }),
    title: 'Opaque change request',
    body: '',
    state: 'open',
    headSha,
    baseSha,
    head: { repository, ref: 'feature', sha: headSha },
    base: { repository, ref: 'main', sha: baseSha },
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
  const summaries = new Map();
  const config = input.config || {};
  const parentKey = (parent) => JSON.stringify(parent);
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
    context: { async resolve() {
      const repository = config.repository || 'opaque/project';
      return { ok: true, value: { ...context, scope: { id: repository, label: repository } } };
    } },
    issues: {
      async describeRepository() { return { ok: true, value: { repository: { identity: identity('repository'), name: 'opaque/project', url: 'https://opaque.example/project' }, labels: [], milestones: [], issueTypes: [], fields: [] } }; },
      async inspect(request) { return { ok: true, value: issue(request.target.value) }; },
      async create() { return receipt('issue-created'); },
      async update() { return receipt('issue-updated'); }
    },
    comments: {
      async list(request) { return { ok: true, value: [...(summaries.get(parentKey(request.parent)) || [])] }; },
      async write(request) {
        const key = parentKey(request.parent);
        const current = summaries.get(key) || [];
        const id = request.existingComment?.value || 'comment-1';
        const next = {
          id,
          author: { id: 'opaque-user' },
          body: request.body,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          createdSequence: 1
        };
        const index = current.findIndex((comment) => comment.id === id);
        if (index >= 0) current[index] = next;
        else current.push(next);
        summaries.set(key, current);
        return { ok: true, value: { remoteId: id, changed: true } };
      },
      async delete(request) {
        const key = parentKey(request.parent);
        const current = summaries.get(key) || [];
        summaries.set(key, current.filter((comment) => comment.id !== request.comment.value));
        return receipt('comment-deleted');
      }
    },
    changeRequests: {
      async inspect(request) { return { ok: true, value: changeRequest(request.target.value, config) }; },
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
