export default async function createPlatformProvider(input) {
  return {
    type: input.providerType,
    contractVersion: input.contractVersion,
    identity: { issue: 'id', 'pull-request': 'id' },
    context: {
      async resolve() {
        return {
          ok: true,
          value: {
            type: input.providerType,
            scope: { id: 'external/project', label: 'external/project' },
            currentUser: { id: 'external-user' },
            capabilities: { authenticated: true, comment: true, triage: true, push: true, admin: false },
            authenticated: true
          }
        };
      }
    },
    changeRequests: {
      async inspect() {
        return {
          ok: true,
          value: {
            id: 'cr-1', identity: { kind: 'id', value: 'cr-1' }, state: 'open', title: 'External CR', body: '',
            headSha: '1111111', baseSha: '2222222', displayUrl: 'https://external.example/cr-1', draft: false,
            labels: [], assignees: [], milestone: null, mergedAt: null, mergeCommitSha: null,
            head: { repository: 'external/project', ref: 'feature', sha: '1111111' },
            base: { repository: 'external/project', ref: 'main', sha: '2222222' }
          }
        };
      },
      async listClosing() { return { ok: true, value: [] }; },
      async create() { return { ok: false, error: { code: 'UNUSED', message: 'unused', retryable: false } }; },
      async update() { return { ok: false, error: { code: 'UNUSED', message: 'unused', retryable: false } }; },
      async resolveGitEvidence() { return { ok: false, error: { code: 'PLATFORM_CAPABILITY_UNSUPPORTED', message: 'unsupported', retryable: false } }; }
    }
  };
}
