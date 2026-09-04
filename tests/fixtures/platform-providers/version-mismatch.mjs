export default async function createPlatformProvider(input) {
  return {
    type: input.providerType,
    contractVersion: 99,
    context: { resolve: async () => ({ ok: true, value: {} }) }
  };
}
