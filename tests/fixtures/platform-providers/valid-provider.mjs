export default async function createPlatformProvider(input) {
  globalThis.__agentInfraProviderFactoryCalls = (globalThis.__agentInfraProviderFactoryCalls || 0) + 1;
  return {
    type: input.providerType,
    contractVersion: input.contractVersion,
    context: {
      async resolve(operation) {
        return {
          ok: true,
          value: {
            type: input.providerType,
            scope: { id: 'fixture-scope' },
            currentUser: null,
            capabilities: {
              authenticated: false,
              comment: false,
              triage: false,
              push: false,
              admin: false
            },
            authenticated: false,
            metadata: {
              factoryRoot: input.repositoryRoot,
              factoryConfig: input.config,
              operationCwd: operation.workingDirectory
            }
          }
        };
      }
    }
  };
}
