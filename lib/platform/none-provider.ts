import type {
  PlatformContextSnapshot,
  PlatformProvider,
  PlatformProviderFactoryInput,
  ProviderResult
} from './provider-contract.ts';

function createNoneProvider(input: PlatformProviderFactoryInput): PlatformProvider {
  return {
    type: input.providerType,
    contractVersion: 1,
    context: {
      async resolve(): Promise<ProviderResult<PlatformContextSnapshot>> {
        return {
          ok: true,
          value: {
            type: input.providerType,
            scope: { id: input.repositoryRoot },
            currentUser: null,
            capabilities: {
              authenticated: false,
              comment: false,
              triage: false,
              push: false,
              admin: false
            },
            authenticated: false
          }
        };
      }
    }
  };
}

export { createNoneProvider };
