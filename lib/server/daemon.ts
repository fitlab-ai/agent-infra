import { VERSION } from '../version.ts';
import { loadServerConfig } from './config.ts';
import type { ServerConfig } from './config.ts';
import { createLogger } from './logger.ts';
import type { Logger } from './logger.ts';
import { loadAdapters, unloadAdapters } from './plugin-loader.ts';
import type { InboundMessage } from './adapters/_contract.ts';
import { authorize } from './auth.ts';
import { commandHelp, parseCommand } from './protocol.ts';
import { runAi } from './runner.ts';
import type { RunnerOptions, RunnerResult } from './runner.ts';
import { streamCommand } from './streamer.ts';
import { markdownMessage, replyOutbound, textMessage } from './display.ts';
import { buildStatusModel, statusModelToDisplay, type StatusModel } from '../task/commands/status.ts';
import { getProcessStartTime, removePidRecordIfMatches } from './process-state.ts';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type MessageDispatcherOptions = {
  config: ServerConfig;
  logger: Pick<Logger, 'info'>;
  runAi?: (args: string[], options?: RunnerOptions) => Promise<RunnerResult>;
  buildStatusModel?: (ref: string) => StatusModel;
  statusModelToDisplay?: (model: StatusModel) => ReturnType<typeof statusModelToDisplay>;
};

function isTaskStatus(argv: string[]): boolean {
  return argv[0] === 'task' && argv[1] === 'status' && typeof argv[2] === 'string';
}

export function createMessageDispatcher(options: MessageDispatcherOptions): (message: InboundMessage) => Promise<void> {
  const runAiImpl = options.runAi ?? runAi;
  const buildStatusModelImpl = options.buildStatusModel ?? buildStatusModel;
  const statusModelToDisplayImpl = options.statusModelToDisplay ?? statusModelToDisplay;

  return async (message: InboundMessage): Promise<void> => {
    const plan = parseCommand(message.text);
    if (plan.kind === 'ignore') return;
    if (plan.kind === 'error') {
      await replyOutbound(message, textMessage(plan.message));
      options.logger.info(`command rejected from ${message.adapter}:${message.userId}: ${plan.message}`);
      return;
    }
    if (plan.kind === 'builtin' && plan.name === 'ping') {
      await replyOutbound(message, textMessage(`pong ${VERSION}`));
      return;
    }
    if (plan.kind === 'builtin' && plan.name === 'help') {
      await replyOutbound(message, markdownMessage(commandHelp()));
      return;
    }
    if (plan.kind === 'builtin' && plan.name === 'version') {
      await replyOutbound(message, textMessage(`agent-infra ${VERSION}`));
      return;
    }
    if (plan.kind === 'ai') {
      const allowed = authorize(
        { adapter: message.adapter, userId: message.userId },
        plan.role,
        options.config.auth
      );
      if (!allowed.ok) {
        await replyOutbound(message, textMessage(allowed.message));
        options.logger.info(`unauthorized command from ${message.adapter}:${message.userId}: ${allowed.message}`);
        return;
      }

      if (isTaskStatus(plan.argv)) {
        try {
          await replyOutbound(message, statusModelToDisplayImpl(buildStatusModelImpl(plan.argv[2]!)));
          return;
        } catch {
          // Fall back to the existing CLI streaming path. This preserves the
          // old behavior for invalid refs and any status-model collection error.
        }
      }

      await streamCommand(
        {
          title: `ai ${plan.argv.join(' ')}`,
          chunkChars: typeof options.config.stream?.chunkChars === 'number' ? options.config.stream.chunkChars : 4000,
          throttleMs: typeof options.config.stream?.throttleMs === 'number' ? options.config.stream.throttleMs : 1500
        },
        (emit) => runAiImpl(plan.argv, { onChunk: emit }),
        (outbound) => replyOutbound(message, outbound)
      );
    }
  };
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
  const ownStartTime = getProcessStartTime(process.pid);

  const abortController = new AbortController();
  let resolveShutdown: () => void = () => {};
  const shutdown = new Promise<void>((resolve) => {
    resolveShutdown = resolve;
  });

  const dispatch = createMessageDispatcher({ config, logger });

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
      if (ownStartTime !== null) {
        removePidRecordIfMatches(config.pidFile, {
          version: 1,
          pid: process.pid,
          startTime: ownStartTime
        });
      }
      resolveShutdown();
    })();
  };
  process.on('SIGINT', () => handleSignal('SIGINT'));
  process.on('SIGTERM', () => handleSignal('SIGTERM'));

  await shutdown;
  process.exit(0);
}
