import * as lark from '@larksuiteoapi/node-sdk';

// Transport layer for the feishu adapter. All @larksuiteoapi/node-sdk surface is
// confined here so the adapter body (index.ts) depends only on this narrow
// interface plus the pure normalizeMessage(). That keeps normalize unit-testable
// without the SDK and lets the adapter be assembled against a fake transport.

export type FeishuTransport = {
  // Begin receiving messages. onMessage is invoked with the raw SDK event for
  // each inbound im.message.receive_v1.
  start: (onMessage: (raw: unknown) => Promise<void>) => Promise<void>;
  stop: () => Promise<void>;
  send: (chatId: string, text: string) => Promise<void>;
};

export type NormalizedMessage = {
  userId: string;
  chatId: string;
  text: string;
  messageId: string;
  raw: unknown;
};

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

// Strip feishu mention placeholders (e.g. "@_user_1") that the platform injects
// for @-mentions, then collapse surrounding whitespace. A group message like
// "@_user_1 /ping" normalizes to "/ping" so the daemon dispatcher matches it.
function stripMentions(text: string): string {
  return text.replace(/@_user_\d+/g, ' ').replace(/\s+/g, ' ').trim();
}

// Parse an im.message.receive_v1 event into the daemon's shape. Pure: no SDK,
// no IO. Throws on missing/invalid fields so the adapter can drop a single bad
// message without crashing the long connection.
export function normalizeMessage(event: unknown): NormalizedMessage {
  const message = asRecord(asRecord(event).message);
  const messageId = message.message_id;
  const chatId = message.chat_id;
  const content = message.content;
  if (typeof messageId !== 'string' || typeof chatId !== 'string' || typeof content !== 'string') {
    throw new Error('feishu: malformed im.message.receive_v1 event (missing message_id/chat_id/content)');
  }

  const senderId = asRecord(asRecord(asRecord(event).sender).sender_id);
  const userId =
    (typeof senderId.open_id === 'string' && senderId.open_id) ||
    (typeof senderId.union_id === 'string' && senderId.union_id) ||
    (typeof senderId.user_id === 'string' && senderId.user_id) ||
    '';

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error('feishu: message.content is not valid JSON');
  }
  const rawText = asRecord(parsed).text;
  if (typeof rawText !== 'string') {
    throw new Error('feishu: unsupported message content (no text field)');
  }

  return { userId, chatId, text: stripMentions(rawText), messageId, raw: event };
}

function resolveDomain(value: unknown): number {
  return value === 'lark' || value === 'Lark' ? lark.Domain.Lark : lark.Domain.Feishu;
}

// Build the real SDK-backed transport from adapter config. appId/appSecret come
// from server config (appSecret only via server.local.json / env). The WSClient
// long connection delivers events; the Client REST call sends replies.
// Feishu self-built app IDs have this shape; the SDK's WSClient.start() silently
// rejects anything else, so we validate up front to fail loudly instead.
const APP_ID_PATTERN = /^cli_[0-9a-fA-F]{16}$/;

export function createFeishuTransport(config: Record<string, unknown>): FeishuTransport {
  const appId = String(config.appId ?? '').trim();
  const appSecret = String(config.appSecret ?? '').trim();
  const domain = resolveDomain(config.domain);

  // Fail fast on missing or malformed credentials. The SDK only logs to its own
  // logger and resolves WSClient.start() for an empty or malformed appId, so
  // without these checks an enabled-but-misconfigured feishu adapter would be
  // counted as loaded while the long connection never opens. Throwing here lets
  // loadAdapters log `failed to load adapter "feishu": ...` and skip it.
  if (appId === '' || appSecret === '') {
    throw new Error(
      'feishu: appId and appSecret are required; put appSecret in .agents/server.local.json or AGENT_INFRA_SERVER_adapters__feishu__appSecret'
    );
  }
  if (!APP_ID_PATTERN.test(appId)) {
    throw new Error('feishu: appId must match cli_[0-9a-fA-F]{16}');
  }

  const client = new lark.Client({ appId, appSecret, domain });
  const wsClient = new lark.WSClient({ appId, appSecret, domain, loggerLevel: lark.LoggerLevel.warn });

  return {
    async start(onMessage) {
      const eventDispatcher = new lark.EventDispatcher({}).register({
        'im.message.receive_v1': async (data: unknown) => {
          await onMessage(data);
        }
      });
      wsClient.start({ eventDispatcher });
    },
    async stop() {
      // Best-effort: close the long connection if the SDK exposes it. Never throw
      // from shutdown — unloadAdapters isolates stop failures, but staying quiet
      // keeps the daemon shutdown path clean.
      const closable = wsClient as unknown as { close?: () => void };
      try {
        closable.close?.();
      } catch {
        // Ignore: the daemon is shutting down regardless.
      }
    },
    async send(chatId, text) {
      await client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: { receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text }) }
      });
    }
  };
}
