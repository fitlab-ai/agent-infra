import type { ServerConfig } from '../config.ts';
import type { Logger } from '../logger.ts';

// Adapter contract for agent-infra-server.
//
// This is a pure type + constant module: it carries no runtime logic and no
// third-party imports. Subtask B (the feishu adapter) and subtask C (the
// command protocol / runner) build against these shapes. Bump
// ADAPTER_CONTRACT_VERSION on a breaking change so plugin-loader can reject
// adapters compiled against an older contract.
export const ADAPTER_CONTRACT_VERSION = 1;

// A normalized inbound message handed to the daemon command dispatcher.
export type InboundMessage = {
  adapter: string;
  userId: string;
  chatId: string;
  text: string;
  messageId: string;
  raw: unknown;
  reply: (text: string) => Promise<void>;
};

// Runtime context passed to every adapter's start(). dispatch() is registered
// by the daemon; signal aborts when the daemon shuts down.
export type AdapterCtx = {
  config: ServerConfig;
  logger: Logger;
  dispatch: (message: InboundMessage) => Promise<void>;
  signal: AbortSignal;
};

// The interface every adapter factory's default export must produce.
export type Adapter = {
  name: string;
  start: (ctx: AdapterCtx) => Promise<void>;
  stop: () => Promise<void>;
  sendMessage: (target: { chatId: string }, text: string) => Promise<void>;
};

// The shape of an adapter module's default export (a factory).
export type AdapterFactory = (adapterConfig: Record<string, unknown>) => Adapter;
