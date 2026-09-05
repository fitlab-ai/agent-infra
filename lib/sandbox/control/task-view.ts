import fs from 'node:fs';
import path from 'node:path';

export const SANDBOX_TASK_VIEW_STATES = ['not-applicable', 'current', 'finalized-stale', 'unknown'] as const;
export const SANDBOX_TASK_VIEW_SOURCES = ['active', 'completed', 'unknown'] as const;

export type SandboxTaskViewState = typeof SANDBOX_TASK_VIEW_STATES[number];
export type SandboxTaskViewSource = typeof SANDBOX_TASK_VIEW_SOURCES[number];
export type SandboxTaskViewReceipt = Readonly<{
  receiptId: string;
  revision: number;
  generation: string;
  requestId: string;
}>;
export type SandboxTaskView = Readonly<{
  state: SandboxTaskViewState;
  taskId: string | null;
  observedSource: SandboxTaskViewSource | null;
  receipt: SandboxTaskViewReceipt | null;
  reasonCode: string | null;
}>;

export type TaskViewProjectionInput = Readonly<{
  mode: 'task-bound' | 'branch-only';
  taskId: string | null;
  generation: string;
  source: SandboxTaskViewSource;
  sourceMatches: boolean;
  receipt?: unknown;
  requestId?: string;
}>;

export type TaskViewAccessEffect =
  | 'diagnostic'
  | 'progress'
  | 'artifact-write'
  | 'terminal-verdict'
  | 'recovery'
  | 'cleanup'
  | 'remote-write';

export type TaskViewAccess = Readonly<{
  allowed: boolean;
  state: SandboxTaskViewState;
  reasonCode: string | null;
  message: string | null;
}>;

function invalidView(message: string): Error {
  return new Error(`SANDBOX_TASK_VIEW_INVALID: ${message}`);
}

function receiptIdentity(value: unknown, generation: string, requestId?: string): SandboxTaskViewReceipt | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const receipt = value as Record<string, unknown>;
  const binding = receipt.controlBinding;
  if (!binding || typeof binding !== 'object' || Array.isArray(binding)) return null;
  const controlBinding = binding as Record<string, unknown>;
  if (receipt.version !== 2 || typeof receipt.receiptId !== 'string' || receipt.receiptId.length === 0
    || !Number.isSafeInteger(receipt.revision) || (receipt.revision as number) < 0
    || receipt.lifecycle !== 'done'
    || controlBinding.generation !== generation
    || typeof controlBinding.requestId !== 'string'
    || !/^[a-f0-9-]{16,64}$/u.test(controlBinding.requestId)
    || (requestId !== undefined && controlBinding.requestId !== requestId)) return null;
  return {
    receiptId: receipt.receiptId,
    revision: receipt.revision as number,
    generation,
    requestId: controlBinding.requestId
  };
}

export function parseSandboxTaskView(value: unknown): SandboxTaskView {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidView('taskView must be an object');
  const view = value as Record<string, unknown>;
  const receipt = view.receipt === null ? null : parseSandboxTaskViewReceipt(view.receipt);
  if (!SANDBOX_TASK_VIEW_STATES.includes(view.state as SandboxTaskViewState)
    || (view.taskId !== null && typeof view.taskId !== 'string')
    || (view.observedSource !== null && !SANDBOX_TASK_VIEW_SOURCES.includes(view.observedSource as SandboxTaskViewSource))
    || (view.reasonCode !== null && typeof view.reasonCode !== 'string')
    || (view.receipt !== null && receipt === null)) {
    throw invalidView('taskView schema is invalid');
  }
  if (view.state === 'not-applicable' && (view.taskId !== null || view.observedSource !== null || view.receipt !== null)) {
    throw invalidView('not-applicable taskView cannot carry task evidence');
  }
  if (view.state === 'current' && (view.taskId === null || view.observedSource === null)) {
    throw invalidView('current taskView requires taskId and observedSource');
  }
  if (view.state === 'current' && view.observedSource === 'completed' && view.receipt === null) {
    throw invalidView('completed current taskView requires receipt');
  }
  if (view.state === 'finalized-stale' && (view.taskId === null || view.receipt === null)) {
    throw invalidView('finalized-stale taskView requires taskId and receipt');
  }
  return view as SandboxTaskView;
}

function parseSandboxTaskViewReceipt(value: unknown): SandboxTaskViewReceipt | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const receipt = value as Record<string, unknown>;
  if (Object.keys(receipt).sort().join(',') !== 'generation,receiptId,requestId,revision'
    || typeof receipt.receiptId !== 'string' || receipt.receiptId.length === 0
    || !Number.isSafeInteger(receipt.revision) || (receipt.revision as number) < 0
    || typeof receipt.generation !== 'string' || receipt.generation.length === 0
    || typeof receipt.requestId !== 'string' || !/^[a-f0-9-]{16,64}$/u.test(receipt.requestId)) return null;
  return receipt as SandboxTaskViewReceipt;
}

export function taskViewForManifest(params: Readonly<{
  repoRoot: string;
  mode: 'task-bound' | 'branch-only';
  taskId: string | null;
  generation: string;
  receipt?: unknown;
}>): SandboxTaskView {
  if (params.mode !== 'task-bound' || !params.taskId) {
    return { state: 'not-applicable', taskId: null, observedSource: null, receipt: null, reasonCode: null };
  }
  const active = path.join(params.repoRoot, '.agents', 'workspace', 'active', params.taskId, 'task.md');
  const completed = path.join(params.repoRoot, '.agents', 'workspace', 'completed', params.taskId, 'task.md');
  const activeExists = fs.existsSync(active);
  const completedExists = fs.existsSync(completed);
  if (activeExists === completedExists) {
    return {
      state: 'unknown', taskId: params.taskId,
      observedSource: activeExists ? 'unknown' : null,
      receipt: null, reasonCode: activeExists ? 'SANDBOX_TASK_VIEW_SOURCE_CONFLICT' : 'SANDBOX_TASK_VIEW_SOURCE_MISSING'
    };
  }
  const source = completedExists ? 'completed' : 'active';
  const receipt = receiptIdentity(params.receipt, params.generation);
  const receiptProvided = params.receipt !== undefined && params.receipt !== null;
  if (source === 'completed' && receipt) {
    return { state: 'current', taskId: params.taskId, observedSource: source, receipt, reasonCode: null };
  }
  if (source === 'active' && receipt) {
    return {
      state: 'finalized-stale', taskId: params.taskId, observedSource: source, receipt,
      reasonCode: 'SANDBOX_TASK_VIEW_SOURCE_STALE'
    };
  }
  if (receiptProvided) {
    return {
      state: 'unknown', taskId: params.taskId, observedSource: source, receipt: null,
      reasonCode: 'SANDBOX_TASK_VIEW_RECEIPT_INVALID'
    };
  }
  if (source === 'active') {
    return { state: 'current', taskId: params.taskId, observedSource: source, receipt: null, reasonCode: null };
  }
  return {
    state: 'unknown', taskId: params.taskId, observedSource: source, receipt: null,
    reasonCode: 'SANDBOX_TASK_VIEW_EVIDENCE_UNAVAILABLE'
  };
}

export function projectSandboxTaskView(input: TaskViewProjectionInput): SandboxTaskView {
  if (input.mode !== 'task-bound' || !input.taskId) {
    return { state: 'not-applicable', taskId: null, observedSource: null, receipt: null, reasonCode: null };
  }
  const receipt = receiptIdentity(input.receipt, input.generation, input.requestId);
  if (input.source === 'completed' && receipt && input.sourceMatches) {
    return { state: 'current', taskId: input.taskId, observedSource: 'completed', receipt, reasonCode: null };
  }
  if (receipt && input.source === 'active' && !input.sourceMatches) {
    return { state: 'finalized-stale', taskId: input.taskId, observedSource: 'active', receipt, reasonCode: 'SANDBOX_TASK_VIEW_SOURCE_STALE' };
  }
  if (!receipt && input.source === 'active' && input.sourceMatches) {
    return { state: 'current', taskId: input.taskId, observedSource: 'active', receipt: null, reasonCode: null };
  }
  return {
    state: 'unknown',
    taskId: input.taskId,
    observedSource: input.source,
    receipt,
    reasonCode: receipt ? 'SANDBOX_TASK_VIEW_SOURCE_UNCONFIRMED' : 'SANDBOX_TASK_VIEW_EVIDENCE_UNAVAILABLE'
  };
}

export function taskViewAfterFinalization(params: Readonly<{
  taskId: string;
  generation: string;
  requestId: string;
  receipt: unknown;
}>): SandboxTaskView {
  const receipt = receiptIdentity(params.receipt, params.generation, params.requestId);
  if (!receipt) {
    return {
      state: 'unknown', taskId: params.taskId, observedSource: 'unknown', receipt: null,
      reasonCode: 'SANDBOX_TASK_VIEW_RECEIPT_INVALID'
    };
  }
  return {
    state: 'finalized-stale', taskId: params.taskId, observedSource: 'active', receipt,
    reasonCode: 'SANDBOX_TASK_VIEW_FINALIZED'
  };
}

export function mergeSandboxTaskView(
  canonical: SandboxTaskView,
  previous: SandboxTaskView
): SandboxTaskView {
  if (previous.state !== 'finalized-stale' && previous.state !== 'unknown') return canonical;
  if (canonical.state === 'current' && canonical.observedSource === 'completed' && canonical.receipt !== null) {
    return canonical;
  }
  return previous;
}

export function accessSandboxTaskView(view: SandboxTaskView, effect: TaskViewAccessEffect): TaskViewAccess {
  if (effect === 'diagnostic' || effect === 'cleanup' || effect === 'recovery') {
    return { allowed: true, state: view.state, reasonCode: view.reasonCode, message: null };
  }
  if (view.state === 'current' && view.observedSource === 'active') {
    return { allowed: true, state: view.state, reasonCode: null, message: null };
  }
  const reasonCode = view.state === 'current'
    ? 'SANDBOX_TASK_VIEW_COMPLETED_READ_ONLY'
    : view.reasonCode ?? `SANDBOX_TASK_VIEW_${view.state.toUpperCase().replaceAll('-', '_')}`;
  return {
    allowed: false,
    state: view.state,
    reasonCode,
    message: view.state === 'unknown'
      ? 'task view cannot be confirmed; inspect status, recover the original request, or explicitly clean up the sandbox'
      : view.state === 'finalized-stale'
        ? 'task view is finalized/stale; exit or clean up the sandbox, or use a validated re-entry'
        : 'completed task views are read-only'
  };
}

export function taskViewFromStatus(value: unknown): SandboxTaskView {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidView('status must be an object');
  const status = value as Record<string, unknown>;
  if (status.version !== 3) throw invalidView('status version is unsupported');
  const taskView = parseSandboxTaskView(status.taskView);
  if (taskView.receipt && taskView.receipt.generation !== status.generation) {
    throw invalidView('taskView receipt generation does not match status generation');
  }
  return taskView;
}
