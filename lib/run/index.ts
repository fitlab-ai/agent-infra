import fs from 'node:fs';
import path from 'node:path';
import { loadServerConfig } from '../server/config.ts';
import { resolveSandboxTarget, type SandboxWorkspaceIdentity } from '../sandbox/workspace-identity.ts';
import { createRunId, runInSandbox, type SandboxRunMetadata } from '../sandbox/capture.ts';
import { loadShortIdByTaskId, normalizeShortIdInput } from '../task/short-id.ts';
import { buildTuiCommand, renderPrompt, selectTui } from './tui.ts';
import { getSkillRunSpec } from './skills.ts';
import { runHostCommand, type RunProcessResult } from './host.ts';
import { PUBLIC_CLI_ROUTE_SELECTORS } from '../internal/cli-route-inventory.ts';

export type ParsedRunArgs = {
  skill: string;
  taskRef: string | null;
  args: string[];
  tui: string | null;
  recreate?: true;
};

export type SandboxRunRequest = {
  taskRef: string;
  branch: string;
  workspace?: SandboxWorkspaceIdentity;
  command: string[];
  runId?: string;
  recreate?: boolean;
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

const USAGE = `Usage: ai run --skill <skill> [--task <task-ref>] [--tui <name>] [--recreate] [-- <skill-args...>]

Task skills are scheduled inside the sandbox tmux session; ai run returns once
the tmux window is created. --recreate authorizes container-only replacement
when in-place sandbox recovery fails; it is not included in the TUI prompt.

Examples:
  ai run --skill create-task "describe the task" --tui codex
  ai run --skill code-task --task 7 --tui codex --recreate`;

function optionValue(args: string[], index: number, option: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${option} requires a value`);
  return value;
}

function extractHostOptions(args: string[]): {
  positionals: string[];
  forwarded: string[];
  skill: string | null;
  taskRef: string | null;
  tui: string | null;
  recreate: boolean;
} {
  const positionals: string[] = [];
  const forwarded: string[] = [];
  let skill: string | null = null;
  let taskRef: string | null = null;
  let tui: string | null = null;
  let recreate = false;
  let separator = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (separator) {
      forwarded.push(arg);
    } else if (arg === '--') {
      separator = true;
    } else if (arg === '--skill') {
      if (skill !== null) throw new Error("duplicate option '--skill'");
      skill = optionValue(args, i, '--skill');
      i += 1;
    } else if (arg === '--task') {
      if (taskRef !== null) throw new Error("duplicate option '--task'");
      taskRef = optionValue(args, i, '--task');
      i += 1;
    } else if (arg === '--tui') {
      if (tui !== null) throw new Error("duplicate option '--tui'");
      tui = optionValue(args, i, '--tui');
      i += 1;
    } else if (arg === '--recreate') {
      if (recreate) throw new Error("duplicate option '--recreate'");
      recreate = true;
    } else if (arg.startsWith('-')) {
      throw new Error(`Unknown option '${arg}'`);
    } else {
      positionals.push(arg);
    }
  }
  return { positionals, forwarded, skill, taskRef, tui, recreate };
}

export function parseRunArgs(args: string[]): ParsedRunArgs {
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    throw new Error(USAGE);
  }
  const { positionals, forwarded, skill, taskRef, tui, recreate } = extractHostOptions(args);
  if (!skill) throw new Error("option '--skill' is required");
  const spec = getSkillRunSpec(skill);
  if (!spec) throw new Error(`Unknown skill '${skill}'`);
  const routeSelector = spec.kind === 'create' ? 'create-task' : recreate ? 'recreate' : 'task-skill';
  if (!PUBLIC_CLI_ROUTE_SELECTORS.run.includes(routeSelector as typeof PUBLIC_CLI_ROUTE_SELECTORS.run[number])) {
    throw new Error(`Unsupported run route '${routeSelector}'`);
  }
  if (spec.kind === 'create') {
    if (taskRef !== null) throw new Error("create-task does not accept '--task'");
    if (recreate) throw new Error('--recreate is only valid for sandbox task runs');
    const createArgs = [...positionals, ...forwarded];
    if (createArgs.length === 0) throw new Error('create-task requires a description');
    return { skill, taskRef: null, args: createArgs, tui };
  }
  if (positionals.length > 0) {
    throw new Error('ai run requires --skill and --task; positional host arguments are not supported');
  }
  if (taskRef === null) throw new Error(`${skill} requires a task-ref`);
  return {
    skill,
    taskRef,
    args: forwarded,
    tui,
    ...(recreate ? { recreate: true as const } : {})
  };
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
  } else {
    const normalized = normalizeShortIdInput(taskRef, { shortIdLength: readShortIdLength(repoRoot) });
    if (normalized.kind !== 'shortId') return null;
    resolvedTaskRef = normalized.value;
    taskId = readActiveShortIdRegistry(repoRoot)[normalized.value] ?? null;
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
  const prompt = renderPrompt({ tui, skill: parsed.skill, args: parsed.args });
  const [file, argv] = buildTuiCommand(tui, prompt);
  const command = [file, ...argv];

  if (parsed.taskRef === null) {
    const result = await (options.runHost ?? runHostCommand)(command);
    return result.exitCode ?? (result.signal ? 1 : 0);
  }

  const repoRoot = options.repoRoot ?? config?.repoRoot ?? process.cwd();
  const target = resolveSandboxTarget(parsed.taskRef, repoRoot);
  const branch = target.branch;
  const identity = resolveActiveTaskIdentity(parsed.taskRef, repoRoot);
  const runId = identity ? createRunId() : undefined;
  const writeStdout = options.writeStdout ?? ((chunk: string) => process.stdout.write(chunk));
  const writeStderr = options.writeStderr ?? ((chunk: string) => process.stderr.write(chunk));
  const runSandbox =
    options.runSandbox ??
    ((request: SandboxRunRequest) => runInSandbox(request));
  const result = await runSandbox({
    taskRef: parsed.taskRef,
    branch,
    workspace: target.workspace,
    command,
    runId,
    recreate: parsed.recreate
  });
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
