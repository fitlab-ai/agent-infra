export default async function createPlatformProvider(input) {
  return {
    type: input.providerType,
    contractVersion: input.contractVersion,
    context: {
      async resolve() {
        return { ok: true, value: { type: input.providerType } };
      }
    }
  };
}
