import { loadConfig } from '../config.ts';
import {
  assertValidBranchName,
  containerNameCandidates,
  sandboxBranchLabel,
  sandboxLabel,
  sandboxTaskIdLabel,
  sandboxWorkspaceModeLabel
} from '../constants.ts';
import { detectEngine } from '../engine.ts';
import { ensureSandboxReady } from '../recovery.ts';
import {
  createSandboxCapabilityPlan,
  runBoundedSandboxHookCommand,
  runSandboxHooks
} from '../agent-client-reconciler.ts';
import { runInteractiveEngine } from '../shell.ts';
import { dotfilesCacheDir, materializeDotfiles } from '../dotfiles.ts';
import { redactCommandError } from '../redaction.ts';
import { runInteractiveWithClipboardBridge } from '../clipboard/bridge.ts';
import { detectHostTimezone } from '../host-timezone.ts';
import {
  fetchSandboxRows,
  selectSandboxContainer,
} from './list-running.ts';
import {
  resolveSandboxReentryContext,
  resolveSandboxTarget
} from '../workspace-identity.ts';

const USAGE = `Usage: ai sandbox exec [--recreate] <branch | TASK-id | N> [cmd...]

N references an active task short id from
.agents/workspace/active/.short-ids.json. They resolve only via that
registry — they do not reference a container's row position in
'ai sandbox ls' output. --recreate is a host recovery flag only before the
target; the same token after the target is passed to the container command.`;
const TMUX_ENTRY_PATH = '/usr/local/bin/sandbox-tmux-entry';

// Terminal-detection variables that interactive TUIs (e.g. claude-code)
// inspect to enable progressive enhancements such as the kitty keyboard
// protocol, which is what makes Shift+Enter distinguishable from Enter.
// `docker exec` does not forward these by default, so we must pass them
// through explicitly.
const FORWARDED_TERMINAL_ENV = [
  'TERM_PROGRAM',
  'TERM_PROGRAM_VERSION',
  'LC_TERMINAL',
  'LC_TERMINAL_VERSION'
];

export function terminalEnvFlags(env: NodeJS.ProcessEnv = process.env): string[] {
  const flags: string[] = [];
  for (const name of FORWARDED_TERMINAL_ENV) {
    const value = env[name];
    if (value) {
      flags.push('-e', `${name}=${value}`);
    }
  }
  return flags;
}

export function hostTimezoneEnvFlags(detect = detectHostTimezone): string[] {
  const tz = detect();
  return tz ? ['-e', `TZ=${tz}`] : [];
}

export function clipboardBridgeDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = (env.AI_SANDBOX_NO_CLIPBOARD_BRIDGE ?? '').trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

export function runSandboxInteractive(params: {
  engine: string;
  dockerArgs: string[];
  container: string;
  home: string;
  env?: NodeJS.ProcessEnv;
  runBridge?: typeof runInteractiveWithClipboardBridge;
  runInteractive?: typeof runInteractiveEngine;
}): number | Promise<number> {
  const {
    engine,
    dockerArgs,
    container,
    home,
    env = process.env,
    runBridge = runInteractiveWithClipboardBridge,
    runInteractive = runInteractiveEngine
  } = params;

  if (clipboardBridgeDisabled(env)) {
    return runInteractive(engine, 'docker', dockerArgs);
  }

  return runBridge({ engine, dockerArgs, container, home });
}

export function parseEnterArgs(args: string[]): {
  target: string;
  command: string[];
  recreate: boolean;
} {
  let recreate = false;
  let index = 0;
  while (args[index] === '--recreate') {
    recreate = true;
    index += 1;
  }
  const target = args[index] ?? '';
  if (!target) {
    throw new Error(USAGE);
  }
  return { target, command: args.slice(index + 1), recreate };
}

export async function enter(args: string[]): Promise<number> {
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    process.stdout.write(`${USAGE}\n`);
    if (args.length === 0) {
      return 1;
    }
    return 0;
  }

  const config = loadConfig();
  const engine = detectEngine(config);
  const parsed = parseEnterArgs(args);
  const target = resolveSandboxTarget(parsed.target, config.repoRoot);
  const branch = target.branch;
  assertValidBranchName(branch);

  const { running, nonRunning } = fetchSandboxRows(
    engine,
    sandboxLabel(config),
    sandboxBranchLabel(config),
    {
      mode: sandboxWorkspaceModeLabel(config),
      taskId: sandboxTaskIdLabel(config)
    }
  );
  const found = selectSandboxContainer(
    [...running, ...nonRunning],
    containerNameCandidates(config, branch)
  );

  if (!found) {
    throw new Error(
      `No sandbox found for branch '${branch}'. Run 'ai sandbox create ${branch}' to create one.`
    );
  }
  const containerWorkspace = found.workspaceMode === 'task-bound' && found.taskId
    ? { mode: 'task-bound' as const, taskId: found.taskId }
    : found.workspaceMode === 'branch-only'
      ? { mode: 'branch-only' as const }
      : { mode: 'legacy-invalid' as const };
  const reentry = resolveSandboxReentryContext({
    target,
    containerWorkspace,
    repoRoot: config.repoRoot
  });
  const ready = await ensureSandboxReady({
    config,
    engine,
    branch,
    workspace: reentry.workspace,
    reentry: reentry.reentry,
    row: found,
    allowRecreate: parsed.recreate,
    recreate: async () => {
      const { create } = await import('./create.ts');
      await create([target.requestedRef, '--no-refresh']);
    }
  });
  const container = ready.container;
  const cmd = parsed.command;
  const capabilityPlan = createSandboxCapabilityPlan(config);
  const enterHookResults = await runSandboxHooks({
    hooks: capabilityPlan.hooksByPhase['before-enter'],
    phase: 'before-enter',
    context: {
      config,
      plan: capabilityPlan,
      enter: { hostHome: config.home, hostEnv: { ...process.env } }
    },
    runCommand: runBoundedSandboxHookCommand
  });
  for (const result of enterHookResults) {
    if (result.status === 'fatal') {
      throw new Error(result.message ?? `Sandbox hook '${result.hookId}' failed.`);
    }
    if (result.status === 'warning') {
      process.stderr.write(
        `Warning: ${result.message ?? `Sandbox hook '${result.hookId}' did not complete.`}\n`
      );
    }
    if (result.message && result.status !== 'warning') process.stderr.write(result.message);
  }

  const envFlags = [...terminalEnvFlags(), ...hostTimezoneEnvFlags()];
  if (cmd.length === 0) {
    try {
      materializeDotfiles(config.dotfilesDir, dotfilesCacheDir(config.home, config.project));
    } catch (error) {
      process.stderr.write(`Warning: dotfiles snapshot rebuild failed: ${redactCommandError(error instanceof Error ? error.message : 'unknown error')}\n`);
    }

    const dockerArgs = ['exec', '-it', ...envFlags, container, 'bash', TMUX_ENTRY_PATH];
    return runSandboxInteractive({
      engine,
      dockerArgs,
      container,
      home: config.home
    });
  }

  return runInteractiveEngine(engine, 'docker', ['exec', '-it', ...envFlags, container, ...cmd]);
}
