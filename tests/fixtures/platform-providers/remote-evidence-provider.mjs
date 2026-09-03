export default async function createPlatformProvider(input) {
  const pullRequests = input.config.pullRequests || {};
  const evidenceEnabled = input.config.evidenceEnabled !== false;
  return {
    type: input.providerType,
    contractVersion: input.contractVersion,
    identity: { 'pull-request': 'number' },
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
        const value = pullRequests[String(request.target.value)];
        return value
          ? { ok: true, value: {
            id: String(value.id || value.nodeId),
            identity: value.identity || { kind: 'number', value: value.number },
            number: value.number,
            state: value.state,
            title: value.title,
            body: value.body,
            baseSha: value.base?.sha,
            headSha: value.head?.sha,
            mergedAt: value.mergedAt,
            displayUrl: value.displayUrl || value.url,
            draft: value.draft,
            labels: value.labels,
            assignees: value.assignees,
            milestone: value.milestone,
            mergeCommitSha: value.mergeCommitSha,
            head: value.head,
            base: value.base
          } }
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
            reviewedHeadRef: `refs/pull/${request.target.value}/head`,
            targetHeadRef: `refs/heads/${request.expected.targetBranch || 'main'}`
          }
        };
      }
    }
  };
}
