import { loadConfig } from '../config.js';
import { assertValidBranchName, containerNameCandidates } from '../constants.js';
import { runInteractive, runSafe } from '../shell.js';

const USAGE = `Usage: ai sandbox exec <branch> [cmd...]`;

export function enter(args) {
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    process.stdout.write(`${USAGE}\n`);
    if (args.length === 0) {
      return 1;
    }
    return 0;
  }

  const [branch, ...cmd] = args;
  assertValidBranchName(branch);

  const config = loadConfig();
  const running = runSafe('docker', ['ps', '--format', '{{.Names}}']).split('\n');
  const container = containerNameCandidates(config, branch).find((name) => running.includes(name));

  if (!container) {
    throw new Error(`No running sandbox found for branch '${branch}'`);
  }

  return cmd.length === 0
    ? runInteractive('docker', ['exec', '-it', container, 'bash'])
    : runInteractive('docker', ['exec', '-it', container, ...cmd]);
}
