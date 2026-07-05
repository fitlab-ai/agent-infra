import type { Adapter, AdapterCtx, AdapterFactory, InboundMessage } from '../_contract.ts';
import { cardMessage, createFeishuTransport, normalizeMessage } from './transport.ts';
import type { FeishuTransport } from './transport.ts';

// Assemble the feishu adapter. The transport is injectable so unit tests can
// drive start/dispatch/reply/sendMessage against a fake transport without the
// real SDK; production uses the default SDK-backed transport.
export function createFeishuAdapter(
  config: Record<string, unknown>,
  transport: FeishuTransport = createFeishuTransport(config)
): Adapter {
  let ctx: AdapterCtx | null = null;

  return {
    name: 'feishu',
    async start(adapterCtx) {
      ctx = adapterCtx;
      await transport.start(async (raw) => {
        try {
          const normalized = normalizeMessage(raw);
          const message: InboundMessage = {
            adapter: 'feishu',
            userId: normalized.userId,
            chatId: normalized.chatId,
            text: normalized.text,
            messageId: normalized.messageId,
            raw: normalized.raw,
            reply: async (text) => {
              await transport.send(normalized.chatId, cardMessage(text));
            }
          };
          await adapterCtx.dispatch(message);
        } catch (error) {
          ctx?.logger.err(`feishu: dropped message: ${error instanceof Error ? error.message : String(error)}`);
        }
      });
    },
    async stop() {
      await transport.stop();
    },
    async sendMessage(target, text) {
      await transport.send(target.chatId, cardMessage(text));
    }
  };
}

const factory: AdapterFactory = (adapterConfig) => createFeishuAdapter(adapterConfig);

export default factory;
