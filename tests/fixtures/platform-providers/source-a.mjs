export default async function createPlatformProvider(input) {
  return {
    type: input.providerType,
    contractVersion: input.contractVersion,
    context: {
      async resolve(operation) {
        return {
          ok: true,
          value: {
            type: input.providerType,
            scope: { id: 'source-a' },
            currentUser: null,
            capabilities: {
              authenticated: false,
              comment: false,
              triage: false,
              push: false,
              admin: false
            },
            authenticated: false,
            metadata: { operationCwd: operation.workingDirectory }
          }
        };
      }
    }
  };
}
