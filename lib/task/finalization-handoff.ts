import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { TaskFinalizationReceipt } from './finalization.ts';

const HANDOFF_VERSION = 1 as const;

type TaskFinalizationHandoff = Readonly<{
  version: typeof HANDOFF_VERSION;
  taskId: string;
  binding: Readonly<{ generation: string; requestId: string }>;
  receipt: TaskFinalizationReceipt;
  receiptSha256: string;
}>;

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function finalizationHandoffPath(directory: string, taskId: string): string {
  return path.join(directory, '.agent-infra', 'task-finalization', `${taskId}.json`);
}

export function publishTaskFinalizationHandoff(
  directory: string,
  receipt: TaskFinalizationReceipt,
  binding: Readonly<{ generation: string; requestId: string }>
): string {
  if (receipt.taskId === '' || receipt.controlBinding?.generation !== binding.generation
    || receipt.controlBinding.requestId !== binding.requestId) {
    throw new Error('TASK_FINALIZATION_HANDOFF_BINDING_INVALID');
  }
  const envelope: TaskFinalizationHandoff = {
    version: HANDOFF_VERSION, taskId: receipt.taskId, binding, receipt, receiptSha256: digest(receipt)
  };
  const target = finalizationHandoffPath(directory, receipt.taskId);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(envelope)}\n`, { mode: 0o600, flag: 'wx' });
  try { fs.renameSync(temporary, target); } catch (error) {
    try { fs.unlinkSync(temporary); } catch { /* preserve the primary error */ }
    throw error;
  }
  return digest(envelope);
}

export function readTaskFinalizationHandoff(
  directory: string,
  taskId: string,
  binding: Readonly<{ generation: string; requestId: string }>,
  handoffSha256: string
): TaskFinalizationReceipt {
  const file = finalizationHandoffPath(directory, taskId);
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('TASK_FINALIZATION_HANDOFF_INVALID');
  const envelope = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<TaskFinalizationHandoff>;
  if (envelope.version !== HANDOFF_VERSION || envelope.taskId !== taskId
    || !envelope.binding || envelope.binding.generation !== binding.generation
    || envelope.binding.requestId !== binding.requestId || !envelope.receipt
    || envelope.receipt.controlBinding?.generation !== binding.generation
    || envelope.receipt.controlBinding.requestId !== binding.requestId
    || typeof envelope.receiptSha256 !== 'string' || envelope.receiptSha256 !== digest(envelope.receipt)
    || digest(envelope) !== handoffSha256) {
    throw new Error('TASK_FINALIZATION_HANDOFF_INVALID');
  }
  return envelope.receipt;
}
