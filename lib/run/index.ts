import fs from 'node:fs';
import path from 'node:path';
import { loadServerConfig } from '../server/config.ts';
import { resolveTaskBranch } from '../sandbox/task-resolver.ts';
import { createRunId, runInSandbox, type SandboxRunMetadata } from '../sandbox/capture.ts';
import { loadShortIdByTaskId, normalizeShortIdInput } from '../task/short-id.ts';
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
  runId?: string;
};

export type SandboxRunResult = RunProcessResult & {
  run?: SandboxRunMetadata;
};

export type RunSkillOptions = {
  command?: Record<string, unknown>;
  repoRoot?: string;
  runHost?: (command: string[]) => Promise<RunProcessResult>;
  runSandbox?: (request: SandboxRunRequest) => Promise<SandboxRunResult>;
  writeStdout?: (chunk: string) => void;
  writeStderr?: (chunk: string) => void;
};

const USAGE = `Usage: ai run <skill> [task-ref] [args...] [--tui <name>]

Task skills are scheduled inside the sandbox tmux session; ai run returns once
the tmux window is created.

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

const TASK_ID_RE = /^TASK-\d{8}-\d{6}$/;

function readShortIdLength(repoRoot: string): number {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(repoRoot, '.agents', '.airc.json'), 'utf8'));
    const value = cfg?.task?.shortIdLength;
    if (typeof value === 'number' && Number.isFinite(value) && value >= 1) return value;
  } catch {
    // Use the project default when config is absent in lightweight tests.
  }
  return 2;
}

function readActiveShortIdRegistry(repoRoot: string): Record<string, string> {
  const registryPath = path.join(repoRoot, '.agents', 'workspace', 'active', '.short-ids.json');
  try {
    const data = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    return data && typeof data === 'object' && data.ids && typeof data.ids === 'object' ? data.ids : {};
  } catch {
    return {};
  }
}

type ActiveTaskIdentity = {
  taskId: string;
  taskDir: string;
  taskRef: string;
};

function resolveActiveTaskIdentity(taskRef: string, repoRoot: string): ActiveTaskIdentity | null {
  let taskId: string | null = null;
  let resolvedTaskRef = taskRef;

  if (TASK_ID_RE.test(taskRef)) {
    taskId = taskRef;
    resolvedTaskRef = loadShortIdByTaskId(repoRoot).get(taskId) ?? taskRef;
  } else {
    const normalized = normalizeShortIdInput(taskRef, { shortIdLength: readShortIdLength(repoRoot) });
    if (normalized.kind !== 'shortId') return null;
    resolvedTaskRef = normalized.value;
    taskId = readActiveShortIdRegistry(repoRoot)[normalized.value.slice(1)] ?? null;
  }

  if (!taskId) return null;
  const taskDir = path.join(repoRoot, '.agents', 'workspace', 'active', taskId);
  if (!fs.existsSync(path.join(taskDir, 'task.md'))) return null;
  return { taskId, taskDir, taskRef: resolvedTaskRef };
}

function formatLocalTimestamp(date: Date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  const year = date.getFullYear();
  const month = pad(date.getMonth() + 1);
  const day = pad(date.getDate());
  const hour = pad(date.getHours());
  const minute = pad(date.getMinutes());
  const second = pad(date.getSeconds());
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const offsetHour = pad(Math.floor(Math.abs(offsetMinutes) / 60));
  const offsetMinute = pad(Math.abs(offsetMinutes) % 60);
  return `${year}-${month}-${day} ${hour}:${minute}:${second}${sign}${offsetHour}:${offsetMinute}`;
}

function writeRunRecord(params: {
  identity: ActiveTaskIdentity;
  run: SandboxRunMetadata;
  branch: string;
  command: string[];
}): void {
  const runsDir = path.join(params.identity.taskDir, 'runs');
  fs.mkdirSync(runsDir, { recursive: true });
  const record = {
    version: 1,
    run_id: params.run.runId,
    task_id: params.identity.taskId,
    task_ref: params.identity.taskRef,
    branch: params.branch,
    engine: params.run.engine,
    container: params.run.container,
    run_dir: params.run.runDir,
    status_file: `${params.run.runDir}/status`,
    log_file: `${params.run.runDir}/output.log`,
    created_at: formatLocalTimestamp(),
    command: params.command
  };
  fs.writeFileSync(
    path.join(runsDir, `${params.run.runId}.json`),
    `${JSON.stringify(record, null, 2)}\n`,
    'utf8'
  );
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
  const identity = resolveActiveTaskIdentity(parsed.taskRef, repoRoot);
  const runId = identity ? createRunId() : undefined;
  const writeStdout = options.writeStdout ?? ((chunk: string) => process.stdout.write(chunk));
  const writeStderr = options.writeStderr ?? ((chunk: string) => process.stderr.write(chunk));
  const runSandbox =
    options.runSandbox ??
    ((request: SandboxRunRequest) => runInSandbox(request));
  const result = await runSandbox({ taskRef: parsed.taskRef, branch, command, runId });
  if (result.stdout) {
    writeStdout(result.stdout);
  }
  if (result.stderr) {
    writeStderr(result.stderr);
  }
  if ((result.exitCode ?? (result.signal ? 1 : 0)) === 0 && identity && result.run) {
    writeRunRecord({ identity, run: result.run, branch, command });
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
