import { loadServerConfig } from '../server/config.ts';
import { resolveTaskBranch } from '../sandbox/task-resolver.ts';
import { runInSandbox } from '../sandbox/capture.ts';
import { buildTuiCommand, renderPrompt, selectTui } from './tui.ts';
import { getSkillRunSpec } from './skills.ts';
import { runHostCommand, type RunProcessResult } from './host.ts';

export type ParsedRunArgs = {
  skill: string;
  taskRef: string | null;
  args: string[];
  tui: string | null;
};

export type SandboxRunRequest = {
  taskRef: string;
  branch: string;
  command: string[];
};

export type RunSkillOptions = {
  command?: Record<string, unknown>;
  repoRoot?: string;
  runHost?: (command: string[]) => Promise<RunProcessResult>;
  runSandbox?: (request: SandboxRunRequest) => Promise<RunProcessResult>;
  writeStdout?: (chunk: string) => void;
  writeStderr?: (chunk: string) => void;
};

const USAGE = `Usage: ai run <skill> [task-ref] [args...] [--tui <name>]

Examples:
  ai run create-task "describe the task" --tui codex
  ai run code-task #7 --tui codex`;

function extractTui(args: string[]): { rest: string[]; tui: string | null } {
  const rest: string[] = [];
  let tui: string | null = null;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (arg === '--tui') {
      const value = args[i + 1];
      if (!value) throw new Error('--tui requires a value');
      tui = value;
      i += 1;
      continue;
    }
    rest.push(arg);
  }
  return { rest, tui };
}

export function parseRunArgs(args: string[]): ParsedRunArgs {
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    throw new Error(USAGE);
  }
  const { rest, tui } = extractTui(args);
  const [skill = '', maybeTaskRef, ...remaining] = rest;
  const spec = getSkillRunSpec(skill);
  if (!spec) throw new Error(`Unknown skill '${skill}'`);
  if (spec.kind === 'create') {
    const createArgs = rest.slice(1);
    if (createArgs.length === 0) throw new Error('create-task requires a description');
    return { skill, taskRef: null, args: createArgs, tui };
  }
  if (!maybeTaskRef) throw new Error(`${skill} requires a task-ref`);
  return { skill, taskRef: maybeTaskRef, args: remaining, tui };
}

function assertAllowedByConfig(skill: string, commandConfig: Record<string, unknown>): void {
  const allowed = commandConfig.allowedSkills;
  if (!Array.isArray(allowed)) return;
  if (!allowed.every((entry) => typeof entry === 'string')) {
    throw new Error('command.allowedSkills must be an array of skill names');
  }
  if (!allowed.includes(skill)) {
    throw new Error(`Skill '${skill}' is not allowed by command.allowedSkills`);
  }
}

export async function runSkill(args: string[], options: RunSkillOptions = {}): Promise<number> {
  const parsed = parseRunArgs(args);
  const config = options.command ? null : loadServerConfig({ rootDir: options.repoRoot });
  const commandConfig = options.command ?? config?.command ?? {};
  assertAllowedByConfig(parsed.skill, commandConfig);
  const tui = selectTui(parsed.skill, { cliTui: parsed.tui, command: commandConfig });
  const promptArgs = parsed.taskRef === null ? parsed.args : [parsed.taskRef, ...parsed.args];
  const prompt = renderPrompt({ tui, skill: parsed.skill, args: promptArgs });
  const [file, argv] = buildTuiCommand(tui, prompt);
  const command = [file, ...argv];

  if (parsed.taskRef === null) {
    const result = await (options.runHost ?? runHostCommand)(command);
    return result.exitCode ?? (result.signal ? 1 : 0);
  }

  const repoRoot = options.repoRoot ?? config?.repoRoot ?? process.cwd();
  const branch = resolveTaskBranch(parsed.taskRef, repoRoot);
  const runSandbox = options.runSandbox ?? ((request: SandboxRunRequest) => runInSandbox(request));
  const result = await runSandbox({ taskRef: parsed.taskRef, branch, command });
  if (result.stdout) {
    (options.writeStdout ?? ((chunk: string) => process.stdout.write(chunk)))(result.stdout);
  }
  if (result.stderr) {
    (options.writeStderr ?? ((chunk: string) => process.stderr.write(chunk)))(result.stderr);
  }
  return result.exitCode ?? (result.signal ? 1 : 0);
}

export async function cmdRun(args: string[]): Promise<void> {
  try {
    const code = await runSkill(args);
    process.exitCode = code;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith('Usage:')) {
      process.stdout.write(`${message}\n`);
      process.exitCode = args.length === 0 ? 1 : 0;
    } else {
      process.stderr.write(`Error: ${message}\n`);
      process.exitCode = 1;
    }
  }
}
