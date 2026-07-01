import { runDaemon } from './daemon.ts';
import { start, stop, status, logs } from './process-control.ts';

const USAGE = `Usage: ai server <command> [options]

Commands:
  start [--foreground]   Start the local daemon (detached; --foreground stays attached for debugging)
  stop                   Stop the running daemon
  status                 Show whether the daemon is running
  logs [-f | --follow]   Print the daemon log ('-f' to follow new lines)
  help                   Show this help message

The daemon hosts IM adapters and command routing for agent-infra.`;

export async function runServer(args: string[]): Promise<void> {
  const [subcommand, ...rest] = args;

  if (!subcommand) {
    process.stdout.write(`${USAGE}\n`);
    process.exitCode = 1;
    return;
  }
  if (subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
    process.stdout.write(`${USAGE}\n`);
    return;
  }

  switch (subcommand) {
    case 'start':
      await start({ foreground: rest.includes('--foreground') });
      break;
    case 'stop':
      await stop();
      break;
    case 'status':
      status();
      break;
    case 'logs':
      await logs({ follow: rest.includes('-f') || rest.includes('--follow') });
      break;
    // Internal entry point for the detached daemon child (not shown in USAGE).
    case '__daemon':
      await runDaemon();
      break;
    default:
      process.stderr.write(`Unknown server command: ${subcommand}\n`);
      process.stdout.write(`${USAGE}\n`);
      process.exitCode = 1;
  }
}
