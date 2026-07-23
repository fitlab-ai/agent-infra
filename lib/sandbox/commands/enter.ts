import { loadConfig } from '../config.ts';
import {
  assertValidBranchName,
  containerNameCandidates,
  sandboxBranchLabel,
  sandboxLabel
} from '../constants.ts';
import { detectEngine } from '../engine.ts';
import { ensureSandboxReady } from '../recovery.ts';
import {
  formatCredentialWarnings,
  formatRemaining,
  hasClaudeProviderAuth,
  reconcileClaudeCredentials,
  redactCommandError,
  validateClaudeCredentialsEnvOverride
} from '../credentials.ts';
import { runInteractiveEngine } from '../shell.ts';
import { dotfilesCacheDir, materializeDotfiles } from '../dotfiles.ts';
import { runInteractiveWithClipboardBridge } from '../clipboard/bridge.ts';
import { detectHostTimezone } from '../host-timezone.ts';
import {
  fetchSandboxRows,
  resolveBranchArg,
  selectSandboxContainer,
} from './list-running.ts';

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

export function formatCredentialSyncStatus(
  result: ReturnType<typeof reconcileClaudeCredentials>,
  isTTY = process.stderr.isTTY,
  providerAuthAvailable = false
): string | null {
  if (providerAuthAvailable && (result.status === 'STALE_ACCESS' || result.status === 'MISSING')) {
    return null;
  }
  if (result.status === 'STALE_ACCESS') {
    return 'Warning: Claude Code credentials on host appear stale. Run "ai sandbox refresh" or "claude /login" to renew.\n';
  }
  if (result.status === 'MISSING') {
    return 'Warning: Claude Code credentials missing on host. Run "claude /login" to authenticate.\n';
  }
  if (result.status === 'KEYCHAIN_WRITE_FAILED') {
    return `Warning: A sandbox refresh produced newer credentials but host Keychain write failed (${formatCredentialWarnings(result.warnings)}). Run "ai sandbox refresh" again or "claude /status" on the host to retry.\n`;
  }
  if (result.status === 'KEYCHAIN_LOCKED' || result.status === 'KEYCHAIN_ERROR') {
    return 'Warning: Host keychain is unavailable; Claude credential sync skipped. Run "ai sandbox refresh" for details.\n';
  }
  if (result.status === 'OK' && result.authoritative !== 'host') {
    const message = `Synced Claude Code credentials from sandbox refresh back to host (expires in ${formatRemaining(result.expiresAt)})`;
    return isTTY ? `\x1b[2m${message}\x1b[0m\n` : `${message}\n`;
  }
  if (result.status === 'OK' && result.filesWritten.length > 0) {
    const message = `Synced Claude Code credentials from host Keychain (expires in ${formatRemaining(result.expiresAt)})`;
    return isTTY ? `\x1b[2m${message}\x1b[0m\n` : `${message}\n`;
  }
  return null;
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
  validateClaudeCredentialsEnvOverride();
  const engine = detectEngine(config);
  const parsed = parseEnterArgs(args);
  const branch = resolveBranchArg(parsed.target, { repoRoot: config.repoRoot });
  assertValidBranchName(branch);

  const { running, nonRunning } = fetchSandboxRows(
    engine,
    sandboxLabel(config),
    sandboxBranchLabel(config)
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
  const ready = await ensureSandboxReady({
    config,
    engine,
    branch,
    row: found,
    allowRecreate: parsed.recreate,
    recreate: async (targetBranch) => {
      const { create } = await import('./create.ts');
      await create([targetBranch, '--no-refresh']);
    }
  });
  const container = ready.container;
  const cmd = parsed.command;

  if (config.tools.includes('claude-code')) {
    try {
      // Scan all projects so a refresh from a neighbouring sandbox can still flow back to the host.
      const providerAuthAvailable = hasClaudeProviderAuth(config.home);
      const result = reconcileClaudeCredentials(config.home);
      const message = formatCredentialSyncStatus(result, process.stderr.isTTY, providerAuthAvailable);
      if (message) {
        process.stderr.write(message);
      }
    } catch (error) {
      process.stderr.write(`Warning: Failed to sync Claude Code credentials: ${redactCommandError(error instanceof Error ? error.message : 'unknown error')}\n`);
    }
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
