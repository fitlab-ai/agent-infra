import { PUBLIC_CLI_ROUTE_SELECTORS } from '../internal/cli-route-inventory.ts';

const USAGE = `Usage: ai sandbox <command> [options]

Commands:
  create <branch> [base]       Create a sandbox (VM + image + worktree + container)
  exec [--recreate] <branch | TASK-id | N> [cmd...]
                               Enter sandbox or run a command. N (bare) is the
                               recommended form for task short ids (e.g.
                               'ai sandbox exec 11').
  ls                           List sandboxes for the current project (the '#'
                               column is a display-only row number; the 'SHORT'
                               column shows the active task short id, '-' if none)
  show <branch | TASK-id | N>
                               Show one sandbox's worktree and per-tool state paths
  prune [--dry-run]            Remove orphaned per-branch state dirs
  rebuild [--quiet] [--refresh]
                               Rebuild the sandbox image (--refresh pulls base + tools)
  refresh                      Sync host Claude Code credentials to all sandbox copies
  rm <branch | TASK-id> | --unbound | --purge
                               Remove one sandbox; use a full TASK-id for task-bound
                               cleanup and a branch for branch-only cleanup. --unbound
                               removes sandboxes not bound to an active task short id.
  start [--recreate] <branch | TASK-id | N>
                               Verify or recover an existing sandbox container;
                               optionally replace only the container on failure
  vm status|start|stop         Manage the sandbox VM (macOS) or check the backend (Windows)

Run 'ai sandbox <command> --help' for details.`;
const SANDBOX_OPERATIONS = PUBLIC_CLI_ROUTE_SELECTORS.sandbox;

type SandboxHandler = (args: string[]) => Promise<void>;

const SANDBOX_HANDLERS = {
  create: async (args) => {
    const { create } = await import('./commands/create.ts');
    await create(args);
  },
  exec: async (args) => {
    const { enter } = await import('./commands/enter.ts');
    const exitCode = await enter(args);
    if (typeof exitCode === 'number' && exitCode !== 0) {
      process.exitCode = exitCode;
    }
  },
  ls: async (args) => {
    const { ls } = await import('./commands/ls.ts');
    ls(args);
  },
  show: async (args) => {
    const { show } = await import('./commands/show.ts');
    show(args);
  },
  prune: async (args) => {
    const { prune } = await import('./commands/prune.ts');
    await prune(args);
  },
  rebuild: async (args) => {
    const { rebuild } = await import('./commands/rebuild.ts');
    await rebuild(args);
  },
  refresh: async (args) => {
    const { refresh } = await import('./commands/refresh.ts');
    const exitCode = await refresh(args);
    if (typeof exitCode === 'number' && exitCode !== 0) {
      process.exitCode = exitCode;
    }
  },
  rm: async (args) => {
    const { rm } = await import('./commands/rm.ts');
    await rm(args);
  },
  start: async (args) => {
    const { start } = await import('./commands/start.ts');
    await start(args);
  },
  vm: async (args) => {
    const { vm } = await import('./commands/vm.ts');
    await vm(args);
  }
} satisfies Record<typeof SANDBOX_OPERATIONS[number], SandboxHandler>;

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

  if (!SANDBOX_OPERATIONS.includes(subcommand as typeof SANDBOX_OPERATIONS[number])) {
    throw new Error(`Unknown sandbox command: ${subcommand}`);
  }

  await SANDBOX_HANDLERS[subcommand as typeof SANDBOX_OPERATIONS[number]](rest);
}
