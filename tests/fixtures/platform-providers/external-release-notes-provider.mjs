function receipt(value = 'release') {
  return { ok: true, value: { remoteId: value, changed: true } };
}

export default async function createPlatformProvider(input) {
  return {
    type: input.providerType,
    contractVersion: input.contractVersion,
    identity: { release: 'key', 'pull-request': 'id', issue: 'id' },
    context: {
      async resolve() {
        return {
          ok: true,
          value: {
            type: input.providerType,
            scope: { id: 'release/project', label: 'release/project' },
            currentUser: null,
            capabilities: { authenticated: true, comment: false, triage: false, push: false, admin: false },
            authenticated: true
          }
        };
      }
    },
    releases: {
      async inspect() { return { ok: false, error: { code: 'RESOURCE_NOT_FOUND', message: 'not found', retryable: false } }; },
      async create() { return receipt('release-created'); },
      async update() { return receipt('release-updated'); },
      async reconcileMilestones() { return { ok: true, value: { changed: false, created: [], closed: [] } }; },
      async publishNotes() { return receipt('notes-published'); },
      async collectNotes(request) {
        return {
          ok: true,
          value: {
            history: request.commitOids.map((sha) => ({ sha, message: '', authoredAt: request.toTime, author: null })),
            mergedPullRequests: [],
            closingIssues: [],
            actors: []
          }
        };
      }
    }
  };
}
