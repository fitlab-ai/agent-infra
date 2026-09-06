import fs from 'node:fs';

import {
  accessSandboxTaskView,
  parseSandboxTaskView,
  taskViewFromStatus,
  type SandboxTaskView,
  type TaskViewAccessEffect
} from '../sandbox/control/task-view.ts';
import { resolveTaskRef } from '../task/resolve-ref.ts';
import {
  PUBLIC_CLI_COMMAND_ALIASES,
  PUBLIC_CLI_SELECTOR_ALIASES
} from './cli-route-inventory.ts';

export type TaskOperationDispatcher = 'public' | 'internal';
export type TaskOperationScope = 'task-bound' | 'non-task' | 'conditional';
export type TaskOperationEffect = TaskViewAccessEffect;
export type TaskRefSource = 'argv' | 'environment' | 'none' | 'delegated' | 'input';

export type TaskOperationDescriptor = Readonly<{
  dispatcher: TaskOperationDispatcher;
  command: string;
  selector: string;
  scope: TaskOperationScope;
  effect: TaskOperationEffect;
  taskRefSource: TaskRefSource;
  guardBeforeImport: true;
}>;

const descriptor = (
  dispatcher: TaskOperationDispatcher,
  command: string,
  selector: string,
  scope: TaskOperationScope,
  effect: TaskOperationEffect,
  taskRefSource: TaskRefSource = scope === 'non-task' ? 'none' : 'argv'
): TaskOperationDescriptor => ({ dispatcher, command, selector, scope, effect, taskRefSource, guardBeforeImport: true });

function internalTaskRoutes(): TaskOperationDescriptor[] {
  return [
    descriptor('internal', 'task-create', 'input', 'conditional', 'progress'),
    descriptor('internal', 'sandbox-control', 'serve', 'non-task', 'progress', 'none'),
    descriptor('internal', 'sandbox-control', 'execute', 'non-task', 'progress', 'none'),
    descriptor('internal', 'sandbox-control', 'recover', 'conditional', 'recovery', 'delegated'),
    descriptor('internal', 'sandbox-control', 'client', 'conditional', 'progress', 'delegated'),
    descriptor('internal', 'agent-client', 'next-steps', 'non-task', 'diagnostic', 'none'),
    descriptor('internal', 'agent-client', 'model-selection', 'non-task', 'diagnostic', 'none'),
    descriptor('internal', 'codex-lifecycle', 'preflight', 'non-task', 'diagnostic', 'none'),
    descriptor('internal', 'codex-lifecycle', 'capability-arm', 'conditional', 'progress'),
    descriptor('internal', 'codex-lifecycle', 'hook-event', 'conditional', 'progress'),
    descriptor('internal', 'codex-lifecycle', 'resolve-start', 'conditional', 'progress'),
    descriptor('internal', 'codex-lifecycle', 'resolve-stop', 'conditional', 'progress'),
    descriptor('internal', 'codex-lifecycle', 'consume', 'conditional', 'progress'),
    descriptor('internal', 'codex-sandbox-controller', 'verify-context', 'task-bound', 'diagnostic'),
    descriptor('internal', 'codex-sandbox-controller', 'run', 'task-bound', 'progress'),
    descriptor('internal', 'git-workflow', 'inspect', 'conditional', 'diagnostic'),
    descriptor('internal', 'git-workflow', 'preview-tree', 'conditional', 'diagnostic'),
    descriptor('internal', 'git-workflow', 'snapshot', 'conditional', 'diagnostic'),
    descriptor('internal', 'git-workflow', 'compare-trees', 'conditional', 'diagnostic'),
    descriptor('internal', 'git-workflow', 'commit', 'task-bound', 'progress', 'input'),
    descriptor('internal', 'git-workflow', 'push-rebased', 'task-bound', 'remote-write'),
    descriptor('internal', 'task-delivery', 'deliver', 'task-bound', 'remote-write'),
    descriptor('internal', 'release-workflow', 'inspect', 'non-task', 'diagnostic', 'none'),
    descriptor('internal', 'release-workflow', 'prepare', 'non-task', 'progress', 'none'),
    descriptor('internal', 'release-workflow', 'publish', 'non-task', 'remote-write', 'none'),
    descriptor('internal', 'release-workflow', 'post-prepare', 'non-task', 'progress', 'none'),
    descriptor('internal', 'release-workflow', 'post-publish', 'non-task', 'remote-write', 'none'),
    descriptor('internal', 'platform-release-notes', 'context', 'non-task', 'diagnostic', 'none'),
    descriptor('internal', 'platform-release-notes', 'stage', 'non-task', 'artifact-write', 'none'),
    descriptor('internal', 'platform-release-notes', 'publish', 'non-task', 'remote-write', 'none'),
    descriptor('internal', 'platform-context', 'resolve', 'non-task', 'diagnostic', 'none'),
    descriptor('internal', 'platform-comment', 'list', 'non-task', 'diagnostic', 'none'),
    descriptor('internal', 'platform-comment', 'owner', 'task-bound', 'diagnostic'),
    descriptor('internal', 'platform-comment', 'backfill', 'task-bound', 'remote-write'),
    descriptor('internal', 'platform-comment', 'sync', 'task-bound', 'remote-write'),
    descriptor('internal', 'platform-issue', 'inspect', 'task-bound', 'diagnostic'),
    descriptor('internal', 'platform-issue', 'create', 'task-bound', 'remote-write'),
    descriptor('internal', 'platform-issue', 'bind', 'task-bound', 'remote-write'),
    descriptor('internal', 'platform-issue', 'sync', 'task-bound', 'remote-write'),
    descriptor('internal', 'platform-pr', 'inspect', 'task-bound', 'diagnostic'),
    descriptor('internal', 'platform-pr', 'summary-context', 'task-bound', 'diagnostic'),
    descriptor('internal', 'platform-pr', 'resolve-external', 'task-bound', 'remote-write'),
    descriptor('internal', 'platform-pr', 'create', 'task-bound', 'remote-write'),
    descriptor('internal', 'platform-pr', 'bind', 'task-bound', 'remote-write'),
    descriptor('internal', 'platform-pr', 'skip', 'task-bound', 'progress'),
    descriptor('internal', 'platform-pr', 'sync', 'task-bound', 'remote-write'),
    descriptor('internal', 'platform-pr', 'change-report', 'task-bound', 'remote-write'),
    descriptor('internal', 'platform-pr', 'summary-sync', 'task-bound', 'remote-write'),
    descriptor('internal', 'platform-pr', 'sync-in-labels', 'non-task', 'remote-write', 'none'),
    descriptor('internal', 'platform-pr-review', 'inspect', 'non-task', 'diagnostic', 'none'),
    descriptor('internal', 'platform-pr-review', 'list', 'non-task', 'diagnostic', 'none'),
    descriptor('internal', 'platform-pr-review', 'publish-pr', 'non-task', 'remote-write', 'none'),
    descriptor('internal', 'platform-pr-review', 'publish-task', 'task-bound', 'remote-write'),
    descriptor('internal', 'pr-review-grade', 'decide', 'non-task', 'diagnostic', 'none'),
    descriptor('internal', 'pr-review-grade', 'resolve-host', 'non-task', 'diagnostic', 'none'),
    descriptor('internal', 'pr-review-grade', 'verify-artifact', 'non-task', 'diagnostic', 'none'),
    descriptor('internal', 'platform-checks', 'inspect', 'conditional', 'diagnostic'),
    descriptor('internal', 'platform-checks', 'watch', 'conditional', 'diagnostic'),
    descriptor('internal', 'platform-checks', 'resolve-run', 'conditional', 'diagnostic'),
    descriptor('internal', 'platform-checks', 'logs', 'conditional', 'diagnostic'),
    descriptor('internal', 'task-context', 'resolve', 'task-bound', 'diagnostic'),
    descriptor('internal', 'task-ledger', 'decision-next-id', 'task-bound', 'diagnostic'),
    descriptor('internal', 'task-ledger', 'stage-status', 'task-bound', 'diagnostic'),
    descriptor('internal', 'task-ledger', 'finding-upsert', 'task-bound', 'progress'),
    descriptor('internal', 'task-ledger', 'finding-respond', 'task-bound', 'progress'),
    descriptor('internal', 'task-ledger', 'finding-review', 'task-bound', 'progress'),
    descriptor('internal', 'task-ledger', 'decision-upsert', 'task-bound', 'progress'),
    descriptor('internal', 'task-ledger', 'rework-intent-upsert', 'task-bound', 'progress'),
    descriptor('internal', 'task-warning', 'list', 'task-bound', 'diagnostic'),
    descriptor('internal', 'task-warning', 'add', 'task-bound', 'progress'),
    descriptor('internal', 'task-warning', 'set-status', 'task-bound', 'progress'),
    descriptor('internal', 'task-activity', 'pr-review-inspect', 'task-bound', 'diagnostic'),
    descriptor('internal', 'task-activity', 'pr-review-start', 'task-bound', 'progress'),
    descriptor('internal', 'task-activity', 'pr-review-complete', 'task-bound', 'progress'),
    descriptor('internal', 'task-activity', 'pr-review-terminate', 'task-bound', 'progress'),
    descriptor('internal', 'task-artifact', 'inspect', 'task-bound', 'diagnostic'),
    descriptor('internal', 'task-artifact', 'finalize-local', 'task-bound', 'artifact-write'),
    descriptor('internal', 'task-orchestration', 'status', 'task-bound', 'diagnostic'),
    descriptor('internal', 'task-orchestration', 'progress', 'task-bound', 'progress'),
    descriptor('internal', 'task-review', 'finalize-summary', 'task-bound', 'progress'),
    descriptor('internal', 'task-event', 'event', 'task-bound', 'progress'),
    descriptor('internal', 'task-invalidation', 'reconcile', 'task-bound', 'progress'),
    descriptor('internal', 'task-override', 'diagnose', 'task-bound', 'diagnostic'),
    descriptor('internal', 'task-override', 'issue', 'task-bound', 'progress'),
    descriptor('internal', 'task-override', 'consume', 'task-bound', 'progress'),
    descriptor('internal', 'task-lifecycle', 'intent', 'task-bound', 'progress'),
    descriptor('internal', 'task-finalization', 'complete', 'task-bound', 'progress'),
    descriptor('internal', 'task-short-id', 'list', 'conditional', 'diagnostic'),
    descriptor('internal', 'task-short-id', 'list-verify', 'conditional', 'diagnostic'),
    descriptor('internal', 'task-short-id', 'alloc', 'task-bound', 'progress'),
    descriptor('internal', 'task-short-id', 'release', 'task-bound', 'progress'),
    descriptor('internal', 'task-short-id', 'resolve', 'task-bound', 'progress'),
    descriptor('internal', 'task-snapshot', 'snapshot', 'conditional', 'diagnostic'),
    descriptor('internal', 'task-verify', 'event', 'task-bound', 'terminal-verdict'),
    descriptor('internal', 'task-validate', 'snapshot', 'conditional', 'diagnostic'),
    descriptor('internal', 'task-validate', 'inplace', 'task-bound', 'progress')
  ];
}

function publicTaskRoutes(): TaskOperationDescriptor[] {
  return [
    descriptor('public', 'agent-client', 'list', 'non-task', 'diagnostic', 'none'),
    descriptor('public', 'agent-client', 'status', 'non-task', 'diagnostic', 'none'),
    descriptor('public', 'agent-client', 'enable', 'non-task', 'progress', 'none'),
    descriptor('public', 'agent-client', 'disable', 'non-task', 'progress', 'none'),
    descriptor('public', 'agent-client', 'configure', 'non-task', 'progress', 'none'),
    descriptor('public', 'cp', 'cp', 'non-task', 'remote-write', 'none'),
    descriptor('public', 'data', 'capture', 'non-task', 'diagnostic', 'none'),
    descriptor('public', 'data', 'verify', 'non-task', 'diagnostic', 'none'),
    descriptor('public', 'data', 'audit', 'non-task', 'diagnostic', 'none'),
    descriptor('public', 'data', 'repair', 'non-task', 'progress', 'none'),
    descriptor('public', 'data', 'export', 'non-task', 'diagnostic', 'none'),
    descriptor('public', 'decide', 'decide', 'task-bound', 'progress'),
    descriptor('public', 'help', 'help', 'non-task', 'diagnostic', 'none'),
    descriptor('public', 'version', 'version', 'non-task', 'diagnostic', 'none'),
    descriptor('public', 'init', 'init', 'non-task', 'progress', 'none'),
    descriptor('public', 'merge', 'merge', 'conditional', 'progress'),
    descriptor('public', 'run', 'create-task', 'conditional', 'progress'),
    descriptor('public', 'run', 'task-skill', 'task-bound', 'progress'),
    descriptor('public', 'run', 'recreate', 'task-bound', 'recovery'),
    descriptor('public', 'sandbox', 'ls', 'conditional', 'diagnostic'),
    descriptor('public', 'sandbox', 'show', 'conditional', 'diagnostic'),
    descriptor('public', 'sandbox', 'create', 'conditional', 'recovery'),
    descriptor('public', 'sandbox', 'exec', 'conditional', 'recovery'),
    descriptor('public', 'sandbox', 'start', 'conditional', 'recovery'),
    descriptor('public', 'sandbox', 'rm', 'conditional', 'cleanup'),
    descriptor('public', 'sandbox', 'prune', 'non-task', 'cleanup', 'none'),
    descriptor('public', 'sandbox', 'rebuild', 'non-task', 'progress', 'none'),
    descriptor('public', 'sandbox', 'refresh', 'non-task', 'progress', 'none'),
    descriptor('public', 'sandbox', 'vm', 'non-task', 'progress', 'none'),
    descriptor('public', 'server', 'start', 'non-task', 'progress', 'none'),
    descriptor('public', 'server', 'stop', 'non-task', 'progress', 'none'),
    descriptor('public', 'server', 'status', 'non-task', 'diagnostic', 'none'),
    descriptor('public', 'server', 'logs', 'non-task', 'diagnostic', 'none'),
    descriptor('public', 'server', '__daemon', 'non-task', 'progress', 'none'),
    descriptor('public', 'task', 'cat', 'task-bound', 'diagnostic'),
    descriptor('public', 'task', 'decisions', 'task-bound', 'diagnostic'),
    descriptor('public', 'task', 'files', 'task-bound', 'diagnostic'),
    descriptor('public', 'task', 'grep', 'task-bound', 'diagnostic'),
    descriptor('public', 'task', 'issue-body', 'task-bound', 'diagnostic'),
    descriptor('public', 'task', 'log', 'task-bound', 'diagnostic'),
    descriptor('public', 'task', 'ls', 'task-bound', 'diagnostic'),
    descriptor('public', 'task', 'show', 'task-bound', 'diagnostic'),
    descriptor('public', 'task', 'status', 'task-bound', 'diagnostic'),
    descriptor('public', 'sync', 'sync', 'non-task', 'progress', 'none'),
    descriptor('public', 'update', 'update', 'non-task', 'progress', 'none')
  ];
}

export const INTERNAL_OPERATION_DESCRIPTORS = Object.freeze(internalTaskRoutes());
export const PUBLIC_OPERATION_DESCRIPTORS = Object.freeze(publicTaskRoutes());
export const TASK_OPERATION_DESCRIPTORS = Object.freeze([
  ...INTERNAL_OPERATION_DESCRIPTORS,
  ...PUBLIC_OPERATION_DESCRIPTORS
]);

export const INTERNAL_DISPATCHER_ROUTES = Object.freeze([
  'task-create', 'sandbox-control', 'agent-client', 'codex-lifecycle', 'codex-sandbox-controller',
  'git-workflow', 'task-delivery', 'release-workflow', 'platform-release-notes', 'platform-context',
  'platform-comment', 'platform-issue', 'platform-pr', 'platform-pr-review', 'pr-review-grade',
  'platform-checks', 'task-context', 'task-ledger', 'task-warning', 'task-activity', 'task-artifact',
  'task-orchestration', 'task-review', 'task-event', 'task-invalidation', 'task-lifecycle',
  'task-finalization', 'task-override', 'task-short-id', 'task-snapshot', 'task-verify', 'task-validate'
]);
export const PUBLIC_DISPATCHER_ROUTES = Object.freeze([
  'agent-client', 'cp', 'data', 'decide', 'help', 'init', 'merge', 'run', 'sandbox', 'server', 'task', 'sync', 'update', 'version'
]);

function first(args: readonly string[]): string {
  return args[0] ?? '';
}

function optionValue(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index >= 0) return args[index + 1];
  const prefix = `${name}=`;
  return args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function internalSelector(command: string, args: readonly string[]): string {
  if (command === 'sandbox-control') return first(args);
  if (command === 'task-create') return 'input';
  if (command === 'task-lifecycle') return args[1] ? 'intent' : '';
  if (command === 'task-finalization') return args[1] === 'complete' ? 'complete' : '';
  if (command === 'task-event') return args[1] ? 'event' : '';
  if (command === 'task-verify') return args[0] && args[1] ? 'event' : '';
  if (command === 'task-snapshot') return 'snapshot';
  if (command === 'task-validate') return optionValue(args, '--scope') ?? 'snapshot';
  if (command === 'task-short-id') return first(args) === 'list' && args.includes('--verify') ? 'list-verify' : first(args);
  if (command === 'task-orchestration') return args[1] === 'status' ? 'status' : args[1] ? 'progress' : '';
  if (command === 'task-review') return args[1] ?? '';
  if (command === 'task-invalidation') return args[1] ?? '';
  if (command === 'task-override') return args[1] ?? '';
  if (command === 'task-artifact') return args[1] ?? '';
  if (command === 'platform-pr-review' && first(args) === 'publish') {
    const scope = optionValue(args, '--scope') ?? '';
    return /^TASK-\d{8}-\d{6}$/u.test(scope) ? 'publish-task' : /^pr\d+$/u.test(scope) ? 'publish-pr' : '';
  }
  if (['task-ledger', 'task-warning', 'task-activity'].includes(command)) return args[1] ?? '';
  if (command === 'task-delivery') return args[1] ?? '';
  if (command === 'task-context') return first(args);
  return first(args);
}

function publicSelector(command: string, args: readonly string[]): string {
  if (command === 'agent-client' || command === 'data' || command === 'server' || command === 'sandbox' || command === 'task') {
    const selector = first(args);
    if (command === 'task') {
      return PUBLIC_CLI_SELECTOR_ALIASES.task[selector as keyof typeof PUBLIC_CLI_SELECTOR_ALIASES.task] ?? selector;
    }
    return selector;
  }
  if (command === 'run') {
    const skill = optionValue(args, '--skill');
    if (skill === 'create-task') return 'create-task';
    if (args.includes('--recreate')) return 'recreate';
    return skill ? 'task-skill' : '';
  }
  return command;
}

function descriptorsFor(dispatcher: TaskOperationDispatcher): readonly TaskOperationDescriptor[] {
  return dispatcher === 'internal' ? INTERNAL_OPERATION_DESCRIPTORS : PUBLIC_OPERATION_DESCRIPTORS;
}

export function resolveTaskOperation(
  dispatcher: TaskOperationDispatcher,
  command: string,
  args: readonly string[] = []
): TaskOperationDescriptor | null {
  const normalizedCommand = dispatcher === 'public'
    ? PUBLIC_CLI_COMMAND_ALIASES[command as keyof typeof PUBLIC_CLI_COMMAND_ALIASES] ?? command
    : command;
  const selector = dispatcher === 'internal' ? internalSelector(normalizedCommand, args) : publicSelector(normalizedCommand, args);
  if (!selector) return null;
  return descriptorsFor(dispatcher).find((item) => item.command === normalizedCommand && item.selector === selector) ?? null;
}

export function resolveDelegatedTaskOperation(args: readonly string[]): TaskOperationDescriptor | null {
  const [operation, ...rest] = args;
  if (operation !== 'client' || !rest[0]) return null;
  return resolveTaskOperation('internal', rest[0], rest.slice(1));
}

const TASK_MARKER_KEYS = [
  'AGENT_INFRA_TASK_ID',
  'AGENT_INFRA_CONTROL_TOKEN',
  'AGENT_INFRA_CONTROL_GENERATION',
  'AGENT_INFRA_CONTROL_DIR',
  'AGENT_INFRA_CONTROL_STATUS_DIR',
  'AGENT_INFRA_RUNTIME_DIR'
] as const;
const TASK_CONTROL_MARKER_KEYS = [
  'AGENT_INFRA_CONTROL_TOKEN',
  'AGENT_INFRA_CONTROL_GENERATION',
  'AGENT_INFRA_CONTROL_DIR',
  'AGENT_INFRA_CONTROL_STATUS_DIR'
] as const;

type TaskMarkerState = 'none' | 'branch-only' | 'task-bound' | 'incomplete';

function taskMarkerState(env: NodeJS.ProcessEnv): TaskMarkerState {
  const present = (key: typeof TASK_MARKER_KEYS[number]) => Boolean(env[key]);
  const taskId = present('AGENT_INFRA_TASK_ID');
  const controls = TASK_CONTROL_MARKER_KEYS.every(present);
  const runtime = present('AGENT_INFRA_RUNTIME_DIR');
  const any = TASK_MARKER_KEYS.some(present);
  if (!any) return 'none';
  if (taskId && controls && runtime) return 'task-bound';
  if (!taskId && controls && !runtime) return 'branch-only';
  return 'incomplete';
}

export function hasTaskBoundMarker(env: NodeJS.ProcessEnv = process.env): boolean {
  return taskMarkerState(env) === 'task-bound';
}

function explicitTaskRefForOperation(
  dispatcher: TaskOperationDispatcher,
  command: string,
  args: readonly string[],
  selected: TaskOperationDescriptor
): string | null {
  if (selected.taskRefSource === 'none' || selected.taskRefSource === 'environment') return null;
  if (selected.taskRefSource === 'input') return inputTaskRefForOperation(args);
  if (command === 'sandbox-control' && args[0] === 'client') {
    return explicitTaskRefForOperation('internal', args[1] ?? '', args.slice(2), selected);
  }
  if (dispatcher === 'public') {
    if (command === 'decide' || command === 'run' || command === 'task') {
      return optionValue(args, '--task') ?? optionValue(args, '-t') ?? null;
    }
    if (command === 'sandbox') {
      const subcommand = first(args);
      if (!['create', 'exec', 'show', 'rm', 'start'].includes(subcommand)) return null;
      const targetIndex = (subcommand === 'exec' || subcommand === 'start') && args[1] === '--recreate' ? 2 : 1;
      return args[targetIndex] ?? null;
    }
    return command === 'merge' ? null : first(args) || null;
  }
  if (command === 'codex-lifecycle') return optionValue(args, '--task-id') ?? null;
  if (command === 'platform-comment' || command === 'platform-issue') {
    return first(args) === 'list' ? null : args[1] ?? null;
  }
  if (command === 'platform-pr') return first(args) === 'sync-in-labels' ? null : args[1] ?? null;
  if (command === 'platform-pr-review') return optionValue(args, '--scope') ?? null;
  if (command === 'platform-checks') return args[1] ?? null;
  if (command === 'task-context') {
    const taskArgs = args.slice(1);
    return optionValue(taskArgs, '--task')
      ?? optionValue(taskArgs, '-t')
      ?? taskArgs.find((arg) => !arg.startsWith('--'))
      ?? null;
  }
  if (command === 'task-create' || command === 'task-short-id' && first(args) === 'list') return null;
  if (command === 'task-short-id') return args[1] ?? null;
  return first(args) || null;
}

function inputTaskRefForOperation(args: readonly string[]): string | null {
  const inputPath = optionValue(args, '--input');
  if (!inputPath) return null;
  try {
    const input = JSON.parse(fs.readFileSync(inputPath, 'utf8')) as { taskRef?: unknown };
    return typeof input.taskRef === 'string' && input.taskRef.trim() ? input.taskRef.trim() : null;
  } catch {
    return null;
  }
}

function isTaskInputRef(taskRef: string): boolean {
  return /^TASK-\d{8}-\d{6}$/u.test(taskRef) || /^\d+$/u.test(taskRef);
}

function taskRefMatchesEnvironment(taskRef: string, taskId: string): boolean {
  if (/^TASK-\d{8}-\d{6}$/u.test(taskRef)) return taskRef === taskId;
  if (!/^\d+$/u.test(taskRef)) return true;
  try {
    const resolved = resolveTaskRef(taskRef);
    return resolved.ok && resolved.taskId === taskId;
  } catch {
    return false;
  }
}

function isSandboxExecutorRoute(
  dispatcher: TaskOperationDispatcher,
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv
): boolean {
  return dispatcher === 'internal'
    && command === 'sandbox-control'
    && first(args) === 'execute'
    && Boolean(env.AGENT_INFRA_EXECUTOR_MANIFEST)
    && Boolean(env.AGENT_INFRA_RUNTIME_DIR)
    && !TASK_CONTROL_MARKER_KEYS.some((key) => Boolean(env[key]));
}

function viewFromEnvironment(env: NodeJS.ProcessEnv): SandboxTaskView {
  const statusDir = env.AGENT_INFRA_CONTROL_STATUS_DIR;
  if (!statusDir) {
    return { state: 'unknown', taskId: env.AGENT_INFRA_TASK_ID ?? null, observedSource: 'unknown', receipt: null, reasonCode: 'SANDBOX_TASK_VIEW_STATUS_MISSING' };
  }
  try {
    const view = taskViewFromStatus(JSON.parse(fs.readFileSync(`${statusDir}/status.json`, 'utf8')));
    if (view.taskId !== env.AGENT_INFRA_TASK_ID) {
      return {
        state: 'unknown', taskId: env.AGENT_INFRA_TASK_ID ?? null, observedSource: 'unknown', receipt: null,
        reasonCode: 'SANDBOX_TASK_VIEW_TASK_ID_MISMATCH'
      };
    }
    return view;
  } catch {
    return { state: 'unknown', taskId: env.AGENT_INFRA_TASK_ID ?? null, observedSource: 'unknown', receipt: null, reasonCode: 'SANDBOX_TASK_VIEW_STATUS_INVALID' };
  }
}

export function formatTaskViewDiagnostic(view: SandboxTaskView): string {
  const task = view.taskId ?? '-';
  const source = view.observedSource ?? '-';
  const reason = view.reasonCode ? ` reason=${view.reasonCode}` : '';
  return `Task view: ${view.state} task=${task} source=${source}${reason}\n`;
}

export class TaskViewOperationError extends Error {
  readonly code: string;
  readonly exitCode: number;
  constructor(code: string, message: string, exitCode = 1) {
    super(`${code}: ${message}`);
    this.name = 'TaskViewOperationError';
    this.code = code;
    this.exitCode = exitCode;
  }
}

export function guardTaskOperation(
  dispatcher: TaskOperationDispatcher,
  command: string,
  args: readonly string[] = [],
  options: Readonly<{ env?: NodeJS.ProcessEnv; taskView?: SandboxTaskView }> = {}
): Readonly<{ descriptor: TaskOperationDescriptor; taskView: SandboxTaskView | null }> {
  const env = options.env ?? process.env;
  if (args[0] === '--help' || args[0] === '-h' || args[0] === 'help') {
    return {
      descriptor: resolveTaskOperation(dispatcher, command, args)
        ?? descriptor(dispatcher, command, 'help', 'non-task', 'diagnostic', 'none'),
      taskView: null
    };
  }
  const markerState = taskMarkerState(env);
  if (markerState === 'incomplete' && !isSandboxExecutorRoute(dispatcher, command, args, env)) {
    throw new TaskViewOperationError(
      'SANDBOX_TASK_VIEW_MARKER_INVALID',
      'sandbox task markers are incomplete; refusing to infer host-direct authority'
    );
  }
  const selected = command === 'sandbox-control'
    ? first(args) === 'client'
      ? resolveDelegatedTaskOperation(args)
      : resolveTaskOperation(dispatcher, command, args)
    : resolveTaskOperation(dispatcher, command, args);
  if (!selected) {
    if (markerState === 'task-bound') {
      throw new TaskViewOperationError('TASK_VIEW_OPERATION_UNREGISTERED', `operation '${command} ${first(args)}' is not registered for a task-bound workspace`);
    }
    return { descriptor: descriptor(dispatcher, command, 'unregistered', 'non-task', 'diagnostic', 'none'), taskView: null };
  }
  if (selected.scope === 'non-task' || markerState !== 'task-bound') return { descriptor: selected, taskView: null };
  const taskId = env.AGENT_INFRA_TASK_ID!;
  const taskView = options.taskView ?? viewFromEnvironment(env);
  if (taskView.state === 'not-applicable' && selected.effect !== 'cleanup') {
    throw new TaskViewOperationError('SANDBOX_TASK_VIEW_INVALID', 'task-bound operation has no applicable task view');
  }
  const access = accessSandboxTaskView(taskView, selected.effect);
  if (!access.allowed) throw new TaskViewOperationError(access.reasonCode ?? 'SANDBOX_TASK_VIEW_DENIED', access.message ?? 'task view denied');
  const taskRef = explicitTaskRefForOperation(dispatcher, command, args, selected);
  if (selected.taskRefSource === 'input' && (!taskRef || !isTaskInputRef(taskRef))) {
    throw new TaskViewOperationError(
      'SANDBOX_TASK_REF_INVALID',
      'task-bound input must contain a valid taskRef'
    );
  }
  if (taskRef && !taskRefMatchesEnvironment(taskRef, taskId)) {
    throw new TaskViewOperationError(
      'SANDBOX_TASK_REF_MISMATCH',
      `task-bound operation targets '${taskRef}', but the sandbox is bound to '${taskId}'`
    );
  }
  return { descriptor: selected, taskView };
}

export function assertTaskViewStatus(value: unknown): SandboxTaskView {
  return parseSandboxTaskView(value);
}
