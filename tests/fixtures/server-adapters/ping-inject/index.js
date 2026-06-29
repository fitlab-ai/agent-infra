// Test-only injection adapter for the e2e ping path. Plain ESM JavaScript (no
// TypeScript) so a built daemon (`node dist/bin/cli.js`) can import it on any
// node>=22 without type stripping. Loaded only when the daemon sets
// AGENT_INFRA_SERVER_TEST_ADAPTERS_DIR (never in production). On start it injects
// a single "/ping" inbound message through the daemon dispatcher and writes the
// reply back to the server log, where the e2e test asserts on it.
export default function createPingInjectAdapter() {
  return {
    name: 'ping-inject',
    async start(ctx) {
      const message = {
        adapter: 'ping-inject',
        userId: 'test-user',
        chatId: 'test-chat',
        text: '/ping',
        messageId: 'test-1',
        raw: {},
        reply: async (text) => {
          ctx.logger.ok(`ping-inject reply: ${text}`);
        }
      };
      await ctx.dispatch(message);
    },
    async stop() {},
    async sendMessage() {}
  };
}
