import fs from 'node:fs';
import { resolveTaskRef } from '../resolve-ref.ts';

const USAGE = `Usage: ai task show <N | #N | TASK-id>

Prints the task.md content for the matching task.
  N (bare numeric)   Recommended; resolves the active short id via the registry.
  '#N'               Compatibility form for old commands.
  TASK-YYYYMMDD-HHMMSS  Locates a task in active / blocked / completed / archive.
`;

function show(args: string[] = []): void {
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    process.stdout.write(USAGE);
    if (args.length === 0) process.exitCode = 1;
    return;
  }
  const resolved = resolveTaskRef(args[0]!);
  if (!resolved.ok) {
    process.stderr.write(`ai task show: ${resolved.message}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(fs.readFileSync(resolved.taskMdPath, 'utf8'));
}

export { show };
