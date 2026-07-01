import { VERSION } from '../version.ts';
import { loadServerConfig } from './config.ts';
import { createLogger } from './logger.ts';
import { loadAdapters, unloadAdapters } from './plugin-loader.ts';
import type { InboundMessage } from './adapters/_contract.ts';
import { authorize } from './auth.ts';
import { commandHelp, parseCommand } from './protocol.ts';
import { runAi } from './runner.ts';
import { streamCommand } from './streamer.ts';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// The daemon main loop. Runs in the detached child spawned by
// process-control.start(), or in the foreground for debugging.
//
// Lifecycle (keep-alive / shutdown model):
//   - The heartbeat interval is kept *ref'd*. It is both the keep-alive that
//     holds the event loop open while subtask A has no adapters, and the
//     observable signal that `ai server logs -f` shows.
//   - runDaemon() awaits a shutdown promise that only resolves once a
//     SIGINT/SIGTERM handler has finished graceful cleanup. We never unref()
//     the only keep-alive timer (that would let the process exit immediately).
export async function runDaemon(): Promise<void> {
  let config;
  try {
    config = loadServerConfig();
  } catch (error) {
    process.stderr.write(`${errorMessage(error)}\n`);
    process.exit(1);
  }

  const logger = createLogger(config.log);
  logger.info(`daemon starting agent-infra ${VERSION} pid=${process.pid}`);

  const abortController = new AbortController();
  let resolveShutdown: () => void = () => {};
  const shutdown = new Promise<void>((resolve) => {
    resolveShutdown = resolve;
  });

  const dispatch = async (message: InboundMessage): Promise<void> => {
    const plan = parseCommand(message.text);
    if (plan.kind === 'ignore') return;
    if (plan.kind === 'error') {
      await message.reply(plan.message);
      logger.info(`command rejected from ${message.adapter}:${message.userId}: ${plan.message}`);
      return;
    }
    if (plan.kind === 'builtin' && plan.name === 'ping') {
      await message.reply(`pong ${VERSION}`);
      return;
    }
    if (plan.kind === 'builtin' && plan.name === 'help') {
      await message.reply(commandHelp());
      return;
    }
    if (plan.kind === 'builtin' && plan.name === 'version') {
      await message.reply(`agent-infra ${VERSION}`);
      return;
    }
    if (plan.kind === 'ai') {
      const allowed = authorize(
        { adapter: message.adapter, userId: message.userId },
        plan.role,
        config.auth
      );
      if (!allowed.ok) {
        await message.reply(allowed.message);
        logger.info(`unauthorized command from ${message.adapter}:${message.userId}: ${allowed.message}`);
        return;
      }
      await streamCommand(
        {
          title: `ai ${plan.argv.join(' ')}`,
          chunkChars: typeof config.stream?.chunkChars === 'number' ? config.stream.chunkChars : 4000,
          throttleMs: typeof config.stream?.throttleMs === 'number' ? config.stream.throttleMs : 1500
        },
        (emit) => runAi(plan.argv, { onChunk: emit }),
        (text) => message.reply(text)
      );
    }
  };

  const ctx = { config, logger, dispatch, signal: abortController.signal };
  const adapters = await loadAdapters(config, ctx);
  logger.ok(`loaded ${adapters.length} adapter(s)`);

  const heartbeat = setInterval(() => logger.info('heartbeat'), config.heartbeatMs);

  let shuttingDown = false;
  const handleSignal = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`received ${signal}, shutting down`);
    abortController.abort();
    void (async () => {
      await unloadAdapters(adapters);
      clearInterval(heartbeat);
      logger.close();
      resolveShutdown();
    })();
  };
  process.on('SIGINT', () => handleSignal('SIGINT'));
  process.on('SIGTERM', () => handleSignal('SIGTERM'));

  await shutdown;
  process.exit(0);
}
