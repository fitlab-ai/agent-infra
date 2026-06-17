const USAGE = `Usage: ai task <command> [options]

Commands:
  ls [--all | --blocked | --completed]   List tasks (default: active)
  show <N | #N | TASK-id>                Print a task.md
  files <ref>                            List artifacts in a task dir (numbered)
  cat <ref> <artifact | N>               Print a task artifact (by name or number)

Examples:
  ai task ls
  ai task show 11
  ai task show TASK-20260612-162737
  ai task files 11
  ai task cat 11 analysis
  ai task cat 11 3

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
    case 'files': {
      const { files } = await import('./commands/files.ts');
      files(rest);
      break;
    }
    case 'cat': {
      const { cat } = await import('./commands/cat.ts');
      cat(rest);
      break;
    }
    default:
      process.stderr.write(`Unknown task command: ${subcommand}\n\n`);
      process.stdout.write(`${USAGE}\n`);
      process.exitCode = 1;
  }
}
