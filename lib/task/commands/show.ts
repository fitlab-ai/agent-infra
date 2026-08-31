import fs from 'node:fs';
import { parseTaskScope } from '../command-options.ts';
import { resolveTaskContext } from '../resolve-ref.ts';

const USAGE = `Usage: ai task show [--task <ref> | -t <ref>]

Prints the task.md content for the matching task.
  Omit the ref       Resolve the unique active task for the current branch.
  --task/-t <ref>    Bare numeric short id, or a full TASK-YYYYMMDD-HHMMSS id.
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
  if (scope.positionals.length > 0) {
    process.stderr.write('ai task show: positional task ref is not supported; use --task <ref> or -t <ref>\n'); process.exitCode = 1; return;
  }
  const resolved = resolveTaskContext(scope.taskRef);
  if (!resolved.ok) {
    process.stderr.write(`ai task show: ${resolved.message}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(fs.readFileSync(resolved.taskMdPath, 'utf8'));
}

export { show };
