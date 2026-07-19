import { formatTable } from '../../table.ts';
import { parseTaskScope } from '../command-options.ts';
import { resolveTaskContext } from '../resolve-ref.ts';
import { enumerateArtifacts } from '../artifacts.ts';

const USAGE = `Usage: ai task files [<N | #N | TASK-id> | --task <ref> | -t <ref>]

Lists the artifacts in a task directory with stable numbers.
  Omit <ref>   Resolve the unique active task for the current branch.
  <ref>   Bare numeric / '#N' short id, or a full TASK-YYYYMMDD-HHMMSS id.

Columns: # (artifact number, usable with 'ai task cat') / NAME / SIZE (bytes) / MTIME
`;

const TABLE_HEADERS = ['#', 'NAME', 'SIZE', 'MTIME'] as const;

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function formatMtime(mtimeMs: number): string {
  const d = new Date(mtimeMs);
  return (
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
    `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
  );
}

function files(args: string[] = []): void {
  if (args[0] === '--help' || args[0] === '-h') {
    process.stdout.write(USAGE);
    return;
  }
  let scope;
  try { scope = parseTaskScope(args); } catch (error) {
    process.stderr.write(`ai task files: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; return;
  }
  if (scope.positionals.length > 1 || (scope.explicit && scope.positionals.length > 0)) {
    process.stderr.write('ai task files: task ref must be provided once\n'); process.exitCode = 1; return;
  }
  const resolved = resolveTaskContext(scope.taskRef ?? scope.positionals[0]);
  if (!resolved.ok) {
    process.stderr.write(`ai task files: ${resolved.message}\n`);
    process.exitCode = 1;
    return;
  }
  const artifacts = enumerateArtifacts(resolved.taskDir);
  // Show the name without the `.md` suffix so the NAME column is exactly what
  // `ai task cat <ref> <name>` accepts (the resolver re-adds `.md`).
  const rows = artifacts.map((a) => [
    String(a.index),
    a.name.replace(/\.md$/, ''),
    String(a.size),
    formatMtime(a.mtimeMs)
  ]);
  for (const line of formatTable(TABLE_HEADERS, rows, { zebra: Boolean(process.stdout.isTTY) })) {
    process.stdout.write(`${line}\n`);
  }
}

export { files };
