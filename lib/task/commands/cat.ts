import fs from 'node:fs';
import { resolveTaskRef } from '../resolve-ref.ts';
import { resolveArtifact } from '../artifacts.ts';

const USAGE = `Usage: ai task cat <N | #N | TASK-id> <artifact | N>

Prints a task artifact's raw content to stdout.
  <ref>            Bare numeric / '#N' short id, or a full TASK-YYYYMMDD-HHMMSS id.
  <artifact | N>   Artifact filename (with or without '.md'), or the number from 'ai task files'.
`;

function cat(args: string[] = []): void {
  if (args[0] === '--help' || args[0] === '-h') {
    process.stdout.write(USAGE);
    return;
  }
  if (args.length < 2) {
    process.stdout.write(USAGE);
    process.exitCode = 1;
    return;
  }
  const resolved = resolveTaskRef(args[0]!);
  if (!resolved.ok) {
    process.stderr.write(`ai task cat: ${resolved.message}\n`);
    process.exitCode = 1;
    return;
  }
  let artifactPath: string;
  try {
    artifactPath = resolveArtifact(resolved.taskDir, args[1]!);
  } catch (e) {
    process.stderr.write(`ai task cat: ${(e as Error).message}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(fs.readFileSync(artifactPath, 'utf8'));
}

export { cat };
