import { loadConfig } from '../config.ts';
import { assertValidBranchName, containerNameCandidates } from '../constants.ts';
import { detectEngine } from '../engine.ts';
import {
  formatCredentialWarnings,
  formatRemaining,
  reconcileClaudeCredentials,
  redactCommandError,
  validateClaudeCredentialsEnvOverride
} from '../credentials.ts';
import { runInteractiveEngine, runSafeEngine } from '../shell.ts';
import { resolveTaskBranch } from '../task-resolver.ts';
import { dotfilesCacheDir, materializeDotfiles } from '../dotfiles.ts';
import { runInteractiveWithClipboardBridge } from '../clipboard/bridge.ts';
import { detectHostTimezone } from '../host-timezone.ts';
import { isTaskShortRef, resolveTaskShortRef } from './list-running.ts';

const USAGE = `Usage: ai sandbox exec <branch | TASK-id | N | '#N'> [cmd...]

N (bare) and '#N' both reference the same active task short id from
.agents/workspace/active/.short-ids.json. They resolve only via that
registry — they do not reference a container's row position in
'ai sandbox ls' output.`;
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
  isTTY = process.stderr.isTTY
): string | null {
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
  const [firstArg = '', ...cmd] = args;
  let branch: string;
  if (isTaskShortRef(firstArg)) {
    branch = resolveTaskShortRef(firstArg, { repoRoot: config.repoRoot });
  } else {
    branch = resolveTaskBranch(firstArg, config.repoRoot);
  }
  assertValidBranchName(branch);
  const running = runSafeEngine(engine, 'docker', ['ps', '--format', '{{.Names}}']).split('\n');
  const container = containerNameCandidates(config, branch).find((name) => running.includes(name));

  if (!container) {
    throw new Error(`No running sandbox found for branch '${branch}'`);
  }

  if (config.tools.includes('claude-code')) {
    try {
      // Scan all projects so a refresh from a neighbouring sandbox can still flow back to the host.
      const result = reconcileClaudeCredentials(config.home);
      const message = formatCredentialSyncStatus(result);
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
