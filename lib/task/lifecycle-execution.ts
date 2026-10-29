import { locateActivityLog, openLifecycleRows, pairEntries, startedBackedRows } from './activity-log.ts';
import { parseTypedTaskFrontmatter } from './frontmatter.ts';

const labels = {
  'Analyze Task': 'analyze', 'Review Analysis': 'review-analysis', 'Plan Task': 'plan',
  'Review Plan': 'review-plan', 'Code Task': 'code', 'Review Code': 'review-code',
  'Run Manual Validation': 'validation-run'
} as const;
export type ExecutionFamily = typeof labels[keyof typeof labels] | 'manual-validation' | 'other';
export type LifecycleExecution = {
  family: ExecutionFamily; agent: string; startedAt: string; round?: number;
  fixFor?: string; implementationInput?: string; transactionId?: string; legacyAction?: string;
};

export function lifecycleExecutions(content: string, taskDir: string): LifecycleExecution[] {
  const value = parseTypedTaskFrontmatter(content).lifecycle_execution;
  if (value !== undefined) {
    if (typeof value !== 'string') throw new Error('invalid lifecycle execution state');
    const state: unknown = JSON.parse(value);
    if (!state || typeof state !== 'object' || !('version' in state) || state.version !== 1 || !('open' in state) || !Array.isArray(state.open)) throw new Error('invalid lifecycle execution state');
    return state.open.map((item: unknown) => {
      if (!item || typeof item !== 'object' || !('family' in item) || typeof item.family !== 'string' || ![...Object.values(labels), 'manual-validation', 'other'].includes(item.family as ExecutionFamily) || !('agent' in item) || typeof item.agent !== 'string' || !('startedAt' in item) || typeof item.startedAt !== 'string') throw new Error('invalid lifecycle execution identity');
      return item as LifecycleExecution;
    });
  }
  // TODO(compat): Remove legacy open-start handoff once all pre-upgrade active tasks have been converted or closed.
  const log = locateActivityLog(content);
  if (!log) return [];
  const paired = pairEntries(log.entries);
  const manualRound = startedBackedRows(paired).filter((row) => row.step === 'Complete Manual Validation' && row.done).length + 1;
  return startedBackedRows(openLifecycleRows(content, taskDir, paired))
    .filter((row) => row.started && !row.done).map((row) => {
      if (row.step === 'Complete Manual Validation') return { family: 'manual-validation' as const, agent: row.agent, startedAt: row.started, round: manualRound, transactionId: /(?:^|;\s*)transaction=([A-Za-z0-9][A-Za-z0-9._-]{0,127})(?:;|$)/u.exec(row.note)?.[1] };
      const match = /^(Analyze Task|Review Analysis|Plan Task|Review Plan|Code Task|Review Code|Run Manual Validation) \(Round ([1-9]\d*)(?:(?:, fix for (review-code(?:-r\d+)?\.md))|(?:, decision (II-[1-9]\d*)))?\)$/u.exec(row.step);
      if (!match) return { family: 'other' as const, agent: row.agent, startedAt: row.started, legacyAction: row.step };
      return { family: labels[match[1] as keyof typeof labels], agent: row.agent, startedAt: row.started, round: Number(match[2]), fixFor: match[3], implementationInput: match[4] };
    });
}

export function serializeLifecycleExecution(open: readonly LifecycleExecution[]): string {
  return JSON.stringify({ version: 1, open });
}
