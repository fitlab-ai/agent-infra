import fs from 'node:fs';
import path from 'node:path';
import { resolveTaskContext, resolveTaskRef } from '../resolve-ref.ts';
import { enumerateArtifacts, resolveArtifact } from '../artifacts.ts';
import { loadShortIdByTaskId } from '../short-id.ts';

const USAGE = `Usage: ai task grep [--current | --task <ref> | -t <ref>] <pattern> [artifact | N]

Literal (non-regex) line search across task artifacts.
  <pattern>          Literal substring to match (NOT a regex). Case-sensitive by default.
  --current          Limit search to the unique active task for the current branch.
  -t, --task <ref>   Limit search to an explicit task (bare short id or TASK-id).
  [artifact | N]     Artifact filename (with or without '.md')
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

type GrepOptions = {
  positional: string[];
  ignoreCase: boolean;
  current: boolean;
  taskRef?: string;
  optsEnded: boolean;
  index: number;
};

function argumentError(message: string): false {
  process.stderr.write(`ai task grep: ${message}\n`);
  process.exitCode = 1;
  return false;
}

function parseTaskOption(args: string[], state: GrepOptions, option: string): boolean {
  if (state.taskRef !== undefined) return argumentError("duplicate option '--task'");
  const value = args[++state.index];
  if (!value || value.startsWith('-')) return argumentError(`${option} requires a value`);
  state.taskRef = value;
  return true;
}

function parseOption(args: string[], state: GrepOptions): boolean {
  const arg = args[state.index]!;
  if (state.optsEnded) { state.positional.push(arg); return true; }
  if (arg === '--') { state.optsEnded = true; return true; }
  if (arg === '-h' || arg === '--help') { process.stdout.write(USAGE); return false; }
  if (arg === '-i' || arg === '--ignore-case') { state.ignoreCase = true; return true; }
  if (arg === '--current') { state.current = true; return true; }
  if (arg === '--task' || arg === '-t') return parseTaskOption(args, state, arg);
  if (arg.startsWith('--task=')) return argumentError('--task=... is not supported; use --task <ref> or -t <ref>');
  if (arg.startsWith('-') && arg !== '-') return argumentError(`unknown flag: ${arg}`);
  state.positional.push(arg);
  return true;
}

function parseArgs(args: string[]): GrepOptions | undefined {
  const state: GrepOptions = { positional: [], ignoreCase: false, current: false, optsEnded: false, index: 0 };
  for (; state.index < args.length; state.index += 1) {
    if (!parseOption(args, state)) return undefined;
  }
  if (state.positional.length === 0) {
    process.stdout.write(USAGE);
    process.exitCode = 1;
    return undefined;
  }
  if (state.current && state.taskRef !== undefined) {
    argumentError('--current and --task are mutually exclusive');
    return undefined;
  }
  if (state.positional.length > 2) {
    argumentError('too many arguments');
    return undefined;
  }
  return state;
}

function grep(args: string[] = []): void {
  const options = parseArgs(args);
  if (!options) return;
  const { positional, ignoreCase, current, taskRef } = options;
  const [pattern, artifactOrN] = positional;
  const matcher = makeMatcher(pattern!, ignoreCase);
  const chunks: string[] = [];
  const emit = (line: string) => chunks.push(line);
  let total = 0;

  const resolved = current || taskRef === undefined
    ? resolveTaskContext()
    : resolveTaskRef(taskRef);
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

  if (total === 0) {
    process.exitCode = 1;
    return;
  }
  process.stdout.write(chunks.join(''));
}

export { grep };
