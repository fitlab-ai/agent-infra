import path from 'node:path';

import { resolveTaskRuntimeRoot } from '../../../task/runtime-paths.ts';
import { managedDelegationRole } from '../../../task/delegation-receipts.ts';

const MARKER_PREFIX = '__agent_infra_binding_';
const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
const TASK_ID_PATTERN = /^TASK-[0-9]{8}-[0-9]{6}$/u;
const SAFE_LABEL_PATTERN = /^[a-z0-9_]{1,80}$/u;
const SAFE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;

type CodexLifecycleTaskBinding = Readonly<{
  taskId: string;
  runId: string;
  receiptId: string;
}>;

function assertSafeTaskName(taskName: string): void {
  if (Buffer.byteLength(taskName, 'utf8') > 255 || !/^[a-z0-9_]+$/u.test(taskName)) {
    throw new Error('Codex task_name must use lowercase letters, digits, and underscores within 255 bytes');
  }
}

function encodeTaskNamePayload(value: string): string {
  let buffer = 0;
  let bits = 0;
  let encoded = '';
  for (const byte of Buffer.from(value, 'utf8')) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      encoded += BASE32_ALPHABET[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits) encoded += BASE32_ALPHABET[(buffer << (5 - bits)) & 31];
  return encoded;
}

function decodeTaskNamePayload(encoded: string): string | null {
  let buffer = 0;
  let bits = 0;
  const bytes: number[] = [];
  for (const character of encoded) {
    const value = BASE32_ALPHABET.indexOf(character);
    if (value < 0) return null;
    buffer = (buffer << 5) | value;
    bits += 5;
    if (bits >= 8) {
      bytes.push((buffer >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  if (bits && (buffer & ((1 << bits) - 1)) !== 0) return null;
  const decoded = Buffer.from(bytes).toString('utf8');
  return encodeTaskNamePayload(decoded) === encoded ? decoded : null;
}

function encodeCodexLifecycleBinding(binding: CodexLifecycleTaskBinding): string {
  if (!TASK_ID_PATTERN.test(binding.taskId)
    || !SAFE_ID_PATTERN.test(binding.runId)
    || !SAFE_ID_PATTERN.test(binding.receiptId)) {
    throw new Error('Codex lifecycle task binding is invalid');
  }
  return `${MARKER_PREFIX}${encodeTaskNamePayload(JSON.stringify(binding))}`;
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
  if (!SAFE_LABEL_PATTERN.test(label) || !/^[a-z2-7]+$/u.test(encoded)) return null;
  try {
    const decoded = decodeTaskNamePayload(encoded);
    if (!decoded) return null;
    const value = JSON.parse(decoded) as Record<string, unknown>;
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
  return path.join(resolveTaskRuntimeRoot(taskRef, options), 'codex-lifecycle');
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
