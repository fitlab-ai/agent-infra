import { loadConfig } from '../config.ts';
import {
  assertValidBranchName,
  containerNameCandidates,
  sandboxBranchLabel,
  sandboxLabel
} from '../constants.ts';
import { detectEngine } from '../engine.ts';
import {
  fetchSandboxRows,
  resolveBranchArg,
  selectSandboxContainer,
  startSandboxContainer
} from './list-running.ts';

const USAGE = `Usage: ai sandbox start <branch | TASK-id | N | '#N'>

Start an existing sandbox container that has stopped (for example after the
Docker daemon was restarted or replaced). The container must already exist:
if none is found, run 'ai sandbox create <branch>' first. A container that is
already running is left untouched.`;

export async function start(args: string[]): Promise<void> {
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    process.stdout.write(`${USAGE}\n`);
    if (args.length === 0) {
      process.exitCode = 1;
    }
    return;
  }

  const [firstArg = ''] = args;
  const config = loadConfig();
  const engine = detectEngine(config);
  const branch = resolveBranchArg(firstArg, { repoRoot: config.repoRoot });
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

  if (found.running) {
    process.stdout.write(`Sandbox '${found.name}' is already running.\n`);
    return;
  }

  startSandboxContainer(engine, found.name);
  process.stdout.write(`Started sandbox '${found.name}'.\n`);
}
