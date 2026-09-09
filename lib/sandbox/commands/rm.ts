import { parseArgs } from 'node:util';
import { loadConfig } from '../config.ts';
import { createSandboxCapabilityPlan } from '../agent-client-reconciler.ts';
import { resolveSandboxCleanupTarget } from '../workspace-identity.ts';
import { rmOne, rmPurge, rmUnbound } from '../removal.ts';

const USAGE = `Usage:
  ai sandbox rm <branch | TASK-id | short id> Remove one sandbox; use a full TASK-id for a task-bound sandbox and a branch for branch-only sandboxes
  ai sandbox rm --unbound [--dry-run] [--yes] Remove completed task-bound and branch-only sandboxes and verified auxiliary state; active, blocked, and archive tasks are protected
  ai sandbox rm --purge                     Tear down ALL sandboxes for the project (containers, worktrees, image, VM)`;
export async function rm(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      all: { type: 'boolean' },
      unbound: { type: 'boolean' },
      purge: { type: 'boolean' },
      'dry-run': { type: 'boolean' },
      yes: { type: 'boolean', short: 'y' },
      help: { type: 'boolean', short: 'h' }
    }
  });

  if (values.all) {
    throw new Error('CLI_FLAG_REMOVED: --all was removed; use --unbound');
  }

  if (values.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }

  if (values.unbound && values.purge) {
    throw new Error('--unbound and --purge are mutually exclusive');
  }

  if ((values['dry-run'] || values.yes) && !values.unbound) {
    throw new Error('--dry-run and --yes only apply to --unbound');
  }

  if ((values.unbound || values.purge) && positionals.length > 0) {
    throw new Error(`${values.unbound ? '--unbound' : '--purge'} does not take a branch argument`);
  }

  if (!values.unbound && !values.purge && positionals.length !== 1) {
    throw new Error(USAGE);
  }

  const config = loadConfig();
  const tools = [...createSandboxCapabilityPlan(config).cleanupInventory];

  if (values.purge) {
    await rmPurge(config, tools);
    return;
  }

  if (values.unbound) {
    await rmUnbound(config, tools, {
      dryRun: Boolean(values['dry-run']),
      assumeYes: Boolean(values.yes)
    });
    return;
  }

  const cleanupTarget = resolveSandboxCleanupTarget(positionals[0] ?? '', config.repoRoot);
  await rmOne(config, tools, cleanupTarget.branch, { cleanupTarget });
}
