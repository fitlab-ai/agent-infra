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
  fetchSandboxRows,
  resolveBranchArg,
  selectSandboxContainer,
} from './list-running.ts';

const USAGE = `Usage: ai sandbox start [--recreate] <branch | TASK-id | N | '#N'>

Start an existing sandbox container that has stopped (for example after the
Docker daemon was restarted or replaced). The container must already exist:
if none is found, run 'ai sandbox create <branch>' first. A container that is
already running is checked without modifying healthy runtime state. --recreate
allows container-only replacement after in-place recovery fails.`;

export function parseStartArgs(args: string[]): { target: string; recreate: boolean; help: boolean } {
  let recreate = false;
  let help = false;
  const positionals: string[] = [];
  for (const arg of args) {
    if (arg === '--recreate') {
      recreate = true;
    } else if (arg === '--help' || arg === '-h') {
      help = true;
    } else if (arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}\n${USAGE}`);
    } else {
      positionals.push(arg);
    }
  }
  if (!help && positionals.length !== 1) {
    throw new Error(USAGE);
  }
  return { target: positionals[0] ?? '', recreate, help };
}

export async function start(args: string[]): Promise<void> {
  if (args.length === 0) {
    process.stdout.write(`${USAGE}\n`);
    process.exitCode = 1;
    return;
  }
  const parsed = parseStartArgs(args);
  if (parsed.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }

  const config = loadConfig();
  const engine = detectEngine(config);
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
      `No sandbox container for branch '${branch}'. Run 'ai sandbox create ${branch}' to create one.`
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
  const message = ready.path === 'healthy'
    ? `Sandbox '${ready.container}' is already running and healthy.`
    : ready.path === 'recreated'
      ? `Recreated sandbox '${ready.container}' and verified readiness.`
      : `Recovered sandbox '${ready.container}' and verified readiness.`;
  process.stdout.write(`${message}\n`);
}
