const USAGE = `Usage: ai sandbox <command> [options]

Commands:
  create <branch> [base]       Create a sandbox (VM + image + worktree + container)
  exec <branch | '#N'> [cmd...]
                               Enter sandbox or run a command (use leftmost '#' column from 'ls')
  ls                           List sandboxes for the current project
  prune [--dry-run]            Remove orphaned per-branch state dirs
  rebuild [--quiet] [--refresh]
                               Rebuild the sandbox image (--refresh pulls base + tools)
  refresh                      Sync host Claude Code credentials to all sandbox copies
  rm <branch> [--all]          Remove a sandbox or all sandboxes
  vm status|start|stop         Manage the sandbox VM (macOS) or check the backend (Windows)

Run 'ai sandbox <command> --help' for details.`;

export async function runSandbox(args: string[]): Promise<void> {
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
    case 'create': {
      const { create } = await import('./commands/create.ts');
      await create(rest);
      break;
    }
    case 'exec': {
      const { enter } = await import('./commands/enter.ts');
      const exitCode = await enter(rest);
      if (typeof exitCode === 'number' && exitCode !== 0) {
        process.exitCode = exitCode;
      }
      break;
    }
    case 'refresh': {
      const { refresh } = await import('./commands/refresh.ts');
      const exitCode = await refresh(rest);
      if (typeof exitCode === 'number' && exitCode !== 0) {
        process.exitCode = exitCode;
      }
      break;
    }
    case 'ls': {
      const { ls } = await import('./commands/ls.ts');
      ls(rest);
      break;
    }
    case 'rm': {
      const { rm } = await import('./commands/rm.ts');
      await rm(rest);
      break;
    }
    case 'prune': {
      const { prune } = await import('./commands/prune.ts');
      await prune(rest);
      break;
    }
    case 'vm': {
      const { vm } = await import('./commands/vm.ts');
      await vm(rest);
      break;
    }
    case 'rebuild': {
      const { rebuild } = await import('./commands/rebuild.ts');
      await rebuild(rest);
      break;
    }
    default:
      throw new Error(`Unknown sandbox command: ${subcommand}`);
  }
}
