export default async function createPlatformProvider(input) {
  const state = String(input.config.state || 'open');
  return {
    type: input.providerType,
    contractVersion: input.contractVersion,
    context: {
      async resolve() {
        return {
          ok: true,
          value: {
            type: input.providerType,
            scope: { id: 'fixture/project', label: 'fixture/project' },
            currentUser: { id: 'fixture-user' },
            capabilities: { authenticated: true, comment: true, triage: true, push: true, admin: false },
            authenticated: true
          }
        };
      }
    },
    securityAlerts: {
      async inspect(request) {
        return { ok: true, value: { kind: request.kind, number: request.number, state, data: { state, number: request.number } } };
      },
      async dismiss(request) {
        return { ok: true, value: { remoteId: `${request.kind}:${request.number}`, changed: true } };
      }
    },
    repositoryMetadata: {
      async reconcileLabels(request) {
        return {
          ok: true,
          value: {
            changed: request.cleanupStaleIn,
            created: request.desired.slice(0, 1).map((item) => item.name),
            updated: [],
            removed: request.cleanupStaleIn ? ['in: stale'] : [],
            skipped: request.desired.slice(1).map((item) => item.name)
          }
        };
      },
      async reconcileMilestones(request) {
        return {
          ok: true,
          value: {
            changed: request.desired.length > 0,
            created: request.desired.map((item) => item.title),
            skipped: []
          }
        };
      }
    }
  };
}
