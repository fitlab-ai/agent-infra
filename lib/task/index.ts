const USAGE = `Usage: ai task <command> [options]

Commands:
  ls [--all | --blocked | --completed]   List tasks (default: active)
  show <N | #N | TASK-id>                Print a task.md

Examples:
  ai task ls
  ai task show 11
  ai task show TASK-20260612-162737

Run 'ai task <command> --help' for details.`;

export async function runTask(args: string[]): Promise<void> {
  const [subcommand, ...rest] = args;

  if (!subcommand) {
    process.stdout.write(`${USAGE}\n`);
    process.exitCode = 1;
    return;
  }

  if (subcommand === '--help' || subcommand === '-h' || subcommand === 'help') {
    process.stdout.write(`${USAGE}\n`);
    return;
  }

  switch (subcommand) {
    case 'ls': {
      const { ls } = await import('./commands/ls.ts');
      ls(rest);
      break;
    }
    case 'show': {
      const { show } = await import('./commands/show.ts');
      show(rest);
      break;
    }
    default:
      process.stderr.write(`Unknown task command: ${subcommand}\n\n`);
      process.stdout.write(`${USAGE}\n`);
      process.exitCode = 1;
  }
}
