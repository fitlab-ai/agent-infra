import fs from 'node:fs';
import path from 'node:path';
import { resolveTaskRef, detectRepoRoot, enumerateTaskDirs } from '../resolve-ref.ts';
import { enumerateArtifacts, resolveArtifact } from '../artifacts.ts';
import { loadShortIdByTaskId } from '../short-id.ts';

const USAGE = `Usage: ai task grep <pattern> [ref] [artifact | N]

Literal (non-regex) line search across task artifacts.
  <pattern>          Literal substring to match (NOT a regex). Case-sensitive by default.
  [ref]              Bare numeric / '#N' short id, or a full TASK-YYYYMMDD-HHMMSS id.
                     Omit to scan every task under active / blocked / completed
                     (archive is skipped). With a ref, narrows to that single task
                     (a TASK-id ref can also resolve an archived task).
  [artifact | N]     Only valid with <ref>. Artifact filename (with or without '.md')
                     or the number from 'ai task files'. Narrows to a single artifact.

Options:
  -i, --ignore-case  Case-insensitive matching.
  --                 Treat the rest as positional (use for patterns starting with '-').

Output: '{taskId} [#short] {fileStem}:{line}: {matched-line}' (short id only for active tasks).
Exits 1 with no output when nothing matches.
`;

function makeMatcher(pattern: string, ignoreCase: boolean): (line: string) => boolean {
  if (ignoreCase) {
    const needle = pattern.toLowerCase();
    return (line) => line.toLowerCase().includes(needle);
  }
  return (line) => line.includes(pattern);
}

// Split content into lines with grep-like semantics: a trailing newline does
// not yield a phantom final empty line, but genuine interior blank lines stay.
function splitLines(content: string): string[] {
  const lines = content.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function scanArtifact(
  taskId: string,
  shortToken: string | undefined,
  artifactPath: string,
  matcher: (line: string) => boolean,
  emit: (line: string) => void
): number {
  const content = fs.readFileSync(artifactPath, 'utf8');
  const stem = path.basename(artifactPath).replace(/\.md$/, '');
  const prefix = shortToken ? `${taskId} ${shortToken}` : taskId;
  let count = 0;
  splitLines(content).forEach((line, i) => {
    if (matcher(line)) {
      emit(`${prefix} ${stem}:${i + 1}: ${line}\n`);
      count++;
    }
  });
  return count;
}

function grep(args: string[] = []): void {
  const positional: string[] = [];
  let ignoreCase = false;
  let optsEnded = false;
  for (const a of args) {
    if (!optsEnded && a === '--') { optsEnded = true; continue; }
    if (!optsEnded && (a === '-h' || a === '--help')) {
      process.stdout.write(USAGE);
      return;
    }
    if (!optsEnded && (a === '-i' || a === '--ignore-case')) { ignoreCase = true; continue; }
    if (!optsEnded && a.startsWith('-') && a !== '-') {
      process.stderr.write(`ai task grep: unknown flag: ${a}\n`);
      process.exitCode = 1;
      return;
    }
    positional.push(a);
  }

  if (positional.length === 0) {
    process.stdout.write(USAGE);
    process.exitCode = 1;
    return;
  }
  if (positional.length > 3) {
    process.stderr.write('ai task grep: too many arguments\n');
    process.exitCode = 1;
    return;
  }

  const [pattern, ref, artifactOrN] = positional;
  const matcher = makeMatcher(pattern!, ignoreCase);
  const chunks: string[] = [];
  const emit = (line: string) => chunks.push(line);
  let total = 0;

  if (ref === undefined) {
    // No ref: full scan across active / blocked / completed (no archive).
    let repoRoot: string;
    try {
      repoRoot = detectRepoRoot();
    } catch (e) {
      process.stderr.write(`ai task grep: ${(e as Error).message}\n`);
      process.exitCode = 1;
      return;
    }
    const shortMap = loadShortIdByTaskId(repoRoot);
    for (const { taskId, taskDir } of enumerateTaskDirs(repoRoot)) {
      const shortToken = shortMap.get(taskId);
      for (const a of enumerateArtifacts(taskDir)) {
        total += scanArtifact(taskId, shortToken, a.path, matcher, emit);
      }
    }
  } else {
    const resolved = resolveTaskRef(ref);
    if (!resolved.ok) {
      process.stderr.write(`ai task grep: ${resolved.message}\n`);
      process.exitCode = 1;
      return;
    }
    const shortToken = loadShortIdByTaskId(resolved.repoRoot).get(resolved.taskId);
    if (artifactOrN !== undefined) {
      let artifactPath: string;
      try {
        artifactPath = resolveArtifact(resolved.taskDir, artifactOrN);
      } catch (e) {
        process.stderr.write(`ai task grep: ${(e as Error).message}\n`);
        process.exitCode = 1;
        return;
      }
      total += scanArtifact(resolved.taskId, shortToken, artifactPath, matcher, emit);
    } else {
      for (const a of enumerateArtifacts(resolved.taskDir)) {
        total += scanArtifact(resolved.taskId, shortToken, a.path, matcher, emit);
      }
    }
  }

  if (total === 0) {
    process.exitCode = 1;
    return;
  }
  process.stdout.write(chunks.join(''));
}

export { grep };
