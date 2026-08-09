import fs from 'node:fs';
import path from 'node:path';
import { isRemovedHashShortIdInput } from '../task/short-id.ts';

const TASK_ID_RE = /^TASK-\d{8}-\d{6}$/;
const SHORT_ID_RE = /^\d+$/;

export type SandboxWorkspaceIdentity =
  | Readonly<{ mode: 'task-bound'; taskId: string; shortId: string }>
  | Readonly<{ mode: 'branch-only' }>;

export type SandboxContainerWorkspaceIdentity =
  | Readonly<{ mode: 'task-bound'; taskId: string }>
  | Readonly<{ mode: 'branch-only' }>
  | Readonly<{ mode: 'legacy-invalid' }>;

export type SandboxTarget = Readonly<{
  requestedRef: string;
  branch: string;
  workspace: SandboxWorkspaceIdentity;
}>;

function stripQuotes(value: string): string {
  return value.replace(/^(?:"([^"]*)"|'([^']*)')$/, '$1$2');
}

function taskBranch(taskMd: string, taskId: string): string {
  const content = fs.readFileSync(taskMd, 'utf8');
  const value = content.match(/^branch:\s*(.+)$/m)?.[1]?.trim()
    ?? content.match(/^- \*\*(?:分支|Branch)\*\*：[ \t]*`?([^`\n]+)`?$/m)?.[1]?.trim();
  if (!value) throw new Error(`Task ${taskId} has no branch field in task.md`);
  return stripQuotes(value);
}

function activeRegistry(repoRoot: string): Record<string, string> {
  const registryPath = path.join(repoRoot, '.agents', 'workspace', 'active', '.short-ids.json');
  if (!fs.existsSync(registryPath)) return {};
  const value = JSON.parse(fs.readFileSync(registryPath, 'utf8')) as unknown;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Active task short-id registry is invalid');
  }
  const ids = 'ids' in value && value.ids && typeof value.ids === 'object' && !Array.isArray(value.ids)
    ? value.ids as Record<string, unknown>
    : value as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(ids).filter((entry): entry is [string, string] =>
      SHORT_ID_RE.test(entry[0]) && typeof entry[1] === 'string' && TASK_ID_RE.test(entry[1])
    )
  );
}

function taskIdentity(repoRoot: string, taskId: string, registry: Record<string, string>): SandboxWorkspaceIdentity {
  const taskMd = path.join(repoRoot, '.agents', 'workspace', 'active', taskId, 'task.md');
  if (!fs.existsSync(taskMd)) throw new Error(`Active task not found: ${taskId}`);
  const shortIds = Object.entries(registry).filter(([, id]) => id === taskId).map(([shortId]) => shortId);
  if (shortIds.length !== 1) {
    throw new Error(`Task ${taskId} must have exactly one active short id`);
  }
  return { mode: 'task-bound', taskId, shortId: shortIds[0]! };
}

export function resolveSandboxTarget(requestedRef: string, repoRoot: string): SandboxTarget {
  if (isRemovedHashShortIdInput(requestedRef)) {
    throw new Error(`Invalid task short id '${requestedRef}': task short ids must use bare digits`);
  }
  const registry = activeRegistry(repoRoot);
  if (SHORT_ID_RE.test(requestedRef)) {
    const matchingShortIds = Object.keys(registry).filter((shortId) =>
      shortId === requestedRef || Number(shortId) === Number(requestedRef)
    );
    if (matchingShortIds.length > 1) {
      throw new Error(`Short id '${requestedRef}' is ambiguous in active task registry`);
    }
    const canonicalShortId = matchingShortIds[0];
    const taskId = canonicalShortId ? registry[canonicalShortId] : undefined;
    if (!taskId) throw new Error(`Short id '${requestedRef}' not found in active task registry`);
    const workspace = taskIdentity(repoRoot, taskId, registry);
    return { requestedRef, branch: taskBranch(path.join(repoRoot, '.agents', 'workspace', 'active', taskId, 'task.md'), taskId), workspace };
  }
  if (TASK_ID_RE.test(requestedRef)) {
    const workspace = taskIdentity(repoRoot, requestedRef, registry);
    return { requestedRef, branch: taskBranch(path.join(repoRoot, '.agents', 'workspace', 'active', requestedRef, 'task.md'), requestedRef), workspace };
  }

  const activeRoot = path.join(repoRoot, '.agents', 'workspace', 'active');
  const matches = fs.existsSync(activeRoot)
    ? fs.readdirSync(activeRoot, { withFileTypes: true }).flatMap((entry) => {
      if (!entry.isDirectory() || !TASK_ID_RE.test(entry.name)) return [];
      const taskMd = path.join(activeRoot, entry.name, 'task.md');
      if (!fs.existsSync(taskMd)) return [];
      return taskBranch(taskMd, entry.name) === requestedRef ? [entry.name] : [];
    })
    : [];
  if (matches.length > 1) {
    throw new Error(`SANDBOX_TASK_IDENTITY_AMBIGUOUS: branch '${requestedRef}' is bound to multiple active tasks`);
  }
  if (matches.length === 1) {
    const taskId = matches[0]!;
    return { requestedRef, branch: requestedRef, workspace: taskIdentity(repoRoot, taskId, registry) };
  }
  return { requestedRef, branch: requestedRef, workspace: { mode: 'branch-only' } };
}

export function parseSandboxWorkspaceIdentity(
  labels: Readonly<Record<string, string>>,
  keys: Readonly<{ mode: string; taskId: string }>
): SandboxContainerWorkspaceIdentity {
  const mode = labels[keys.mode];
  const taskId = labels[keys.taskId];
  if (mode === 'branch-only' && taskId === undefined) return { mode: 'branch-only' };
  if (mode === 'task-bound' && typeof taskId === 'string' && TASK_ID_RE.test(taskId)) {
    return { mode: 'task-bound', taskId };
  }
  return { mode: 'legacy-invalid' };
}

export function sameSandboxWorkspaceIdentity(
  left: SandboxWorkspaceIdentity | SandboxContainerWorkspaceIdentity,
  right: SandboxWorkspaceIdentity | SandboxContainerWorkspaceIdentity
): boolean {
  return left.mode === right.mode
    && (left.mode !== 'task-bound' || (right.mode === 'task-bound' && left.taskId === right.taskId));
}
