import type { TaskFinalizationReceipt } from './finalization.ts';

export type TaskControlBinding = NonNullable<TaskFinalizationReceipt['controlBinding']>;
export type TaskControlBindingEvidence = (taskId: string, binding: TaskControlBinding) => 'terminal' | 'pending' | 'mismatch';

export function taskFinalizationReceiptState(receipt: TaskFinalizationReceipt): 'pending' | 'unresolved' | 'complete' {
  if (receipt.lifecycle !== 'done' || receipt.taskComment === 'pending'
    || receipt.verification === 'pending' || receipt.warningProjection !== 'done') return 'pending';
  if (receipt.lastError !== null || receipt.warnings.some((warning) => warning.status === 'open')) return 'unresolved';
  return 'complete';
}
