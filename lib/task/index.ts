const USAGE = `Usage: ai task <command> [options]

Commands:
  cat <ref> <artifact | N>               Print a task artifact (by name or number)
  files <ref>                            List artifacts in a task dir (numbered)
  grep <pattern> [ref] [artifact | N]    Literal search across task artifacts (omit ref to scan all)
  log <ref>                              Render a task's activity log as a timeline
  ls [--all | --blocked | --completed]   List tasks (default: active)
  show <N | #N | TASK-id>                Print a task.md
  status <ref>                           Aggregated status view (metadata / artifacts / git / platform)

Examples:
  ai task cat 11 analysis
  ai task cat 11 3
  ai task files 11
  ai task grep resolveArtifact
  ai task grep resolveArtifact 11
  ai task log 11
  ai task ls
  ai task show 11
  ai task show TASK-20260612-162737
  ai task status 11

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
    case 'grep': {
      const { grep } = await import('./commands/grep.ts');
      grep(rest);
      break;
    }
    case 'log': {
      const { log } = await import('./commands/log.ts');
      log(rest);
      break;
    }
    case 'status': {
      const { status } = await import('./commands/status.ts');
      status(rest);
      break;
    }
    default:
      process.stderr.write(`Unknown task command: ${subcommand}\n\n`);
      process.stdout.write(`${USAGE}\n`);
      process.exitCode = 1;
  }
}
