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
type ReadHandoff = Readonly<{ receipt: TaskFinalizationReceipt; cleanup: () => void }>;
const MAX_HANDOFF_BYTES = 1024 * 1024;

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
): ReadHandoff {
  const file = finalizationHandoffPath(directory, taskId);
  const initial = fs.lstatSync(file);
  if (!initial.isFile() || initial.isSymbolicLink() || initial.size > MAX_HANDOFF_BYTES) {
    throw new Error('TASK_FINALIZATION_HANDOFF_INVALID');
  }
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  let content: string;
  try {
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || opened.dev !== initial.dev || opened.ino !== initial.ino
      || opened.size > MAX_HANDOFF_BYTES) throw new Error('TASK_FINALIZATION_HANDOFF_INVALID');
    const bytes = Buffer.alloc(MAX_HANDOFF_BYTES + 1);
    const length = fs.readSync(descriptor, bytes, 0, bytes.length, 0);
    if (length !== opened.size || length > MAX_HANDOFF_BYTES) throw new Error('TASK_FINALIZATION_HANDOFF_INVALID');
    content = bytes.toString('utf8', 0, length);
    const after = fs.fstatSync(descriptor);
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size) {
      throw new Error('TASK_FINALIZATION_HANDOFF_INVALID');
    }
  } finally {
    fs.closeSync(descriptor);
  }
  const envelope = JSON.parse(content) as Partial<TaskFinalizationHandoff>;
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)
    || Object.keys(envelope).sort().join('\0') !== ['binding', 'receipt', 'receiptSha256', 'taskId', 'version'].join('\0')
    || envelope.version !== HANDOFF_VERSION || envelope.taskId !== taskId
    || !envelope.binding || typeof envelope.binding !== 'object' || Array.isArray(envelope.binding)
    || Object.keys(envelope.binding).sort().join('\0') !== ['generation', 'requestId'].join('\0')
    || envelope.binding.generation !== binding.generation
    || envelope.binding.requestId !== binding.requestId || !envelope.receipt
    || envelope.receipt.controlBinding?.generation !== binding.generation
    || envelope.receipt.controlBinding.requestId !== binding.requestId
    || typeof envelope.receiptSha256 !== 'string' || envelope.receiptSha256 !== digest(envelope.receipt)
    || digest(envelope) !== handoffSha256) {
    throw new Error('TASK_FINALIZATION_HANDOFF_INVALID');
  }
  return {
    receipt: envelope.receipt,
    cleanup: () => {
      try {
        const current = fs.lstatSync(file);
        if (current.isFile() && !current.isSymbolicLink()
          && current.dev === initial.dev && current.ino === initial.ino) fs.unlinkSync(file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  };
}
