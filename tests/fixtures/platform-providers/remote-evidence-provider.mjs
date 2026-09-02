export default async function createPlatformProvider(input) {
  const pullRequests = input.config.pullRequests || {};
  const evidenceEnabled = input.config.evidenceEnabled !== false;
  return {
    type: input.providerType,
    contractVersion: input.contractVersion,
    context: {
      async resolve() {
        return {
          ok: true,
          value: {
            type: input.providerType,
            scope: { id: 'o/r', label: 'o/r' },
            currentUser: { id: 'reviewer' },
            capabilities: {
              authenticated: true,
              comment: true,
              triage: true,
              push: true,
              admin: false
            },
            authenticated: true
          }
        };
      }
    },
    changeRequests: {
      async inspect(request) {
        const value = pullRequests[String(request.target.number)];
        return value
          ? { ok: true, value }
          : { ok: false, error: { code: 'PR_NOT_FOUND', message: 'Pull request was not found', retryable: false } };
      },
      async listClosing() { return { ok: true, value: [] }; },
      async create() { return { ok: false, error: { code: 'UNUSED', message: 'unused', retryable: false } }; },
      async update() { return { ok: false, error: { code: 'UNUSED', message: 'unused', retryable: false } }; },
      async resolveGitEvidence(request) {
        if (!evidenceEnabled) {
          return {
            ok: false,
            error: {
              code: 'PLATFORM_CAPABILITY_UNSUPPORTED',
              message: 'Git evidence is not supported by this provider',
              retryable: false
            }
          };
        }
        return {
          ok: true,
          value: {
            remoteUrl: String(input.config.remoteUrl || ''),
            reviewedHeadRef: `refs/pull/${request.target.number}/head`,
            targetHeadRef: `refs/heads/${request.expected.targetBranch || 'main'}`
          }
        };
      }
    }
  };
}
