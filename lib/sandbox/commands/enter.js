import { loadConfig } from '../config.js';
import { assertValidBranchName, containerNameCandidates } from '../constants.js';
import { runInteractive, runSafe } from '../shell.js';
import { resolveTaskBranch } from '../task-resolver.js';

const USAGE = `Usage: ai sandbox exec <branch> [cmd...]`;

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

export function terminalEnvFlags(env = process.env) {
  const flags = [];
  for (const name of FORWARDED_TERMINAL_ENV) {
    const value = env[name];
    if (value) {
      flags.push('-e', `${name}=${value}`);
    }
  }
  return flags;
}

export function enter(args) {
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    process.stdout.write(`${USAGE}\n`);
    if (args.length === 0) {
      return 1;
    }
    return 0;
  }

  const config = loadConfig();
  const [branchOrTaskId, ...cmd] = args;
  const branch = resolveTaskBranch(branchOrTaskId, config.repoRoot);
  assertValidBranchName(branch);
  const running = runSafe('docker', ['ps', '--format', '{{.Names}}']).split('\n');
  const container = containerNameCandidates(config, branch).find((name) => running.includes(name));

  if (!container) {
    throw new Error(`No running sandbox found for branch '${branch}'`);
  }

  const envFlags = terminalEnvFlags();
  return cmd.length === 0
    ? runInteractive('docker', ['exec', '-it', ...envFlags, container, 'bash'])
    : runInteractive('docker', ['exec', '-it', ...envFlags, container, ...cmd]);
}
