import fs from 'node:fs';
import { parseTaskScope } from '../command-options.ts';
import { resolveTaskContext } from '../resolve-ref.ts';
import { resolveArtifact } from '../artifacts.ts';

const USAGE = `Usage: ai task cat <artifact | N>
       ai task cat (--task <ref> | -t <ref>) <artifact | N>
       ai task cat <ref> <artifact | N>

Prints a task artifact's raw content to stdout.
  One positional    Uses current task context and treats the operand as the artifact.
  <ref>            Bare numeric / '#N' short id, or a full TASK-YYYYMMDD-HHMMSS id.
  <artifact | N>   Artifact filename (with or without '.md'), or the number from 'ai task files'.
`;

function cat(args: string[] = []): void {
  if (args[0] === '--help' || args[0] === '-h') {
    process.stdout.write(USAGE);
    return;
  }
  let scope;
  try { scope = parseTaskScope(args); } catch (error) {
    process.stderr.write(`ai task cat: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; return;
  }
  let taskRef: string | undefined;
  let artifact: string | undefined;
  if (scope.explicit) {
    if (scope.positionals.length !== 1) { process.stdout.write(USAGE); process.exitCode = 1; return; }
    taskRef = scope.taskRef; artifact = scope.positionals[0];
  } else if (scope.positionals.length === 1) {
    artifact = scope.positionals[0];
  } else if (scope.positionals.length === 2) {
    [taskRef, artifact] = scope.positionals;
  } else { process.stdout.write(USAGE); process.exitCode = 1; return; }
  const resolved = resolveTaskContext(taskRef);
  if (!resolved.ok) {
    process.stderr.write(`ai task cat: ${resolved.message}\n`);
    process.exitCode = 1;
    return;
  }
  let artifactPath: string;
  try {
    artifactPath = resolveArtifact(resolved.taskDir, artifact!);
  } catch (e) {
    process.stderr.write(`ai task cat: ${(e as Error).message}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(fs.readFileSync(artifactPath, 'utf8'));
}

export { cat };
