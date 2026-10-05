import path from 'node:path';

import { resolveTaskRef } from '../../../task/resolve-ref.ts';
import { managedDelegationRole } from '../../../task/delegation-receipts.ts';

const MARKER_PREFIX = '--agent-infra-binding-';
const TASK_ID_PATTERN = /^TASK-[0-9]{8}-[0-9]{6}$/u;
const SAFE_LABEL_PATTERN = /^[A-Za-z0-9_-]{1,80}$/u;
const SAFE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;

type CodexLifecycleTaskBinding = Readonly<{
  taskId: string;
  runId: string;
  receiptId: string;
}>;

function assertSafeTaskName(taskName: string): void {
  if (
    Buffer.byteLength(taskName, 'utf8') > 255
    || taskName.includes('/')
    || taskName.includes('\\')
    || taskName === '.'
    || taskName === '..'
  ) throw new Error('Codex task_name must be one path-safe component of at most 255 bytes');
}

function encodeCodexLifecycleBinding(binding: CodexLifecycleTaskBinding): string {
  if (!TASK_ID_PATTERN.test(binding.taskId)
    || !SAFE_ID_PATTERN.test(binding.runId)
    || !SAFE_ID_PATTERN.test(binding.receiptId)) {
    throw new Error('Codex lifecycle task binding is invalid');
  }
  return `${MARKER_PREFIX}${Buffer.from(JSON.stringify(binding)).toString('base64url')}`;
}

function appendCodexLifecycleBinding(label: string, binding: CodexLifecycleTaskBinding): string {
  if (!SAFE_LABEL_PATTERN.test(label)) throw new Error('Codex task_name label is invalid');
  const taskName = `${label}${encodeCodexLifecycleBinding(binding)}`;
  assertSafeTaskName(taskName);
  return taskName;
}

function parseCodexLifecycleBinding(taskName: string): Readonly<{
  taskName: string;
  label: string;
  binding: CodexLifecycleTaskBinding;
}> | null {
  assertSafeTaskName(taskName);
  const markerIndex = taskName.lastIndexOf(MARKER_PREFIX);
  if (markerIndex < 1) return null;
  const label = taskName.slice(0, markerIndex);
  const encoded = taskName.slice(markerIndex + MARKER_PREFIX.length);
  if (!SAFE_LABEL_PATTERN.test(label) || !/^[A-Za-z0-9_-]+$/u.test(encoded)) return null;
  try {
    const value = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (Object.keys(value).sort().join(',') !== 'receiptId,runId,taskId'
      || typeof value.taskId !== 'string' || !TASK_ID_PATTERN.test(value.taskId)
      || typeof value.runId !== 'string' || !SAFE_ID_PATTERN.test(value.runId)
      || typeof value.receiptId !== 'string' || !SAFE_ID_PATTERN.test(value.receiptId)) return null;
    return Object.freeze({
      taskName,
      label,
      binding: Object.freeze({ taskId: value.taskId, runId: value.runId, receiptId: value.receiptId })
    });
  } catch {
    return null;
  }
}

function resolveCodexLifecycleStoreRoot(taskRef: string, options: Readonly<{ repoRoot?: string }> = {}): string {
  const resolved = resolveTaskRef(taskRef, { repoRoot: options.repoRoot });
  if (!resolved.ok) throw new Error(`${resolved.code}: ${resolved.message}`);
  return path.join(resolved.taskDir, '.runtime', 'codex-lifecycle');
}

function verifyCodexLifecycleTaskBinding(
  binding: CodexLifecycleTaskBinding,
  run: Readonly<{ taskId: string; runId: string; status: string; pendingDelegation: Readonly<{
    id: string; taskId: string; runId: string; client: string; role: string; status: string;
    requestedModel: string | null; requestedReasoningEffort: string | null;
  }> | null }>,
  nativeAgent: string,
  expected: Readonly<{ requestedModel?: string; requestedReasoningEffort?: string }> = {}
): void {
  const receipt = run.pendingDelegation;
  if (!receipt
    || run.status !== 'running'
    || run.taskId !== binding.taskId
    || run.runId !== binding.runId
    || receipt.taskId !== binding.taskId
    || receipt.runId !== binding.runId
    || receipt.id !== binding.receiptId
    || receipt.client !== 'codex'
    || receipt.status !== 'prepared'
    || managedDelegationRole(nativeAgent) !== receipt.role
    || (expected.requestedModel && receipt.requestedModel !== expected.requestedModel)
    || (expected.requestedReasoningEffort && receipt.requestedReasoningEffort !== expected.requestedReasoningEffort)) {
    throw new Error('Codex lifecycle task binding does not match the current pending receipt');
  }
}

export {
  appendCodexLifecycleBinding,
  encodeCodexLifecycleBinding,
  parseCodexLifecycleBinding,
  resolveCodexLifecycleStoreRoot,
  verifyCodexLifecycleTaskBinding
};
export type { CodexLifecycleTaskBinding };
