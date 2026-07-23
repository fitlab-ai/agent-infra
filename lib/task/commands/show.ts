import fs from 'node:fs';
import { parseTaskScope } from '../command-options.ts';
import { resolveTaskContext } from '../resolve-ref.ts';

const USAGE = `Usage: ai task show [<N | TASK-id> | --task <ref> | -t <ref>]

Prints the task.md content for the matching task.
  Omit the ref       Resolve the unique active task for the current branch.
  N (bare numeric)   Recommended; resolves the active short id via the registry.
  TASK-YYYYMMDD-HHMMSS  Locates a task in active / blocked / completed / archive.
`;

function show(args: string[] = []): void {
  if (args[0] === '--help' || args[0] === '-h') {
    process.stdout.write(USAGE);
    return;
  }
  let scope;
  try { scope = parseTaskScope(args); } catch (error) {
    process.stderr.write(`ai task show: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1; return;
  }
  if (scope.positionals.length > 1 || (scope.explicit && scope.positionals.length > 0)) {
    process.stderr.write('ai task show: task ref must be provided once\n'); process.exitCode = 1; return;
  }
  const resolved = resolveTaskContext(scope.taskRef ?? scope.positionals[0]);
  if (!resolved.ok) {
    process.stderr.write(`ai task show: ${resolved.message}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(fs.readFileSync(resolved.taskMdPath, 'utf8'));
}

export { show };
