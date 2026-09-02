export default async function createPlatformProvider(input) {
  const remoteUrl = String(input.config.remoteUrl || '');
  const reviewedHeadRef = String(input.config.reviewedHeadRef || 'refs/pull/1/head');
  return {
    type: input.providerType,
    contractVersion: input.contractVersion,
    context: {
      async resolve(operation) {
        return {
          ok: true,
          value: {
            type: input.providerType,
            scope: { id: 'o/r' },
            currentUser: { id: 'reviewer' },
            capabilities: {
              authenticated: true,
              comment: true,
              triage: true,
              push: true,
              admin: false
            },
            authenticated: true,
            metadata: { operationCwd: operation.workingDirectory }
          }
        };
      }
    },
    changeRequests: {
      async inspect() { return { ok: false, error: { code: 'UNUSED', message: 'unused', retryable: false } }; },
      async listClosing() { return { ok: true, value: [] }; },
      async create() { return { ok: false, error: { code: 'UNUSED', message: 'unused', retryable: false } }; },
      async update() { return { ok: false, error: { code: 'UNUSED', message: 'unused', retryable: false } }; },
      async resolveGitEvidence() {
        return {
          ok: true,
          value: {
            remoteUrl,
            reviewedHeadRef,
            targetHeadRef: 'refs/heads/main'
          }
        };
      }
    }
  };
}
