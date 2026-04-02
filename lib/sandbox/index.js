const USAGE = `Usage: ai sandbox <command> [options]

Commands:
  create <branch> [base]       Create a sandbox (VM + image + worktree + container)
  exec <branch> [cmd...]       Enter sandbox or run a command
  ls                           List sandboxes for the current project
  rm <branch> [--all]          Remove a sandbox or all sandboxes
  vm status|start|stop         Manage the sandbox VM (macOS only)
  rebuild [--quiet]            Rebuild the sandbox image

Run 'ai sandbox <command> --help' for details.`;

export async function runSandbox(args) {
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
      const { create } = await import('./commands/create.js');
      await create(rest);
      break;
    }
    case 'exec': {
      const { enter } = await import('./commands/enter.js');
      const exitCode = enter(rest);
      if (typeof exitCode === 'number' && exitCode !== 0) {
        process.exitCode = exitCode;
      }
      break;
    }
    case 'ls': {
      const { ls } = await import('./commands/ls.js');
      ls(rest);
      break;
    }
    case 'rm': {
      const { rm } = await import('./commands/rm.js');
      await rm(rest);
      break;
    }
    case 'vm': {
      const { vm } = await import('./commands/vm.js');
      await vm(rest);
      break;
    }
    case 'rebuild': {
      const { rebuild } = await import('./commands/rebuild.js');
      await rebuild(rest);
      break;
    }
    default:
      throw new Error(`Unknown sandbox command: ${subcommand}`);
  }
}
