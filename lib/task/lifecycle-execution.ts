import { parseTypedTaskFrontmatter } from './frontmatter.ts';

const labels = {
  'Analyze Task': 'analyze', 'Review Analysis': 'review-analysis', 'Plan Task': 'plan',
  'Review Plan': 'review-plan', 'Code Task': 'code', 'Review Code': 'review-code',
  'Run Manual Validation': 'validation-run'
} as const;
export type ExecutionFamily = typeof labels[keyof typeof labels] | 'manual-validation' | 'other';
export type LifecycleExecution = {
  family: ExecutionFamily; agent: string; startedAt: string; round?: number;
  fixFor?: string; implementationInput?: string; transactionId?: string;
};

export function lifecycleExecutions(content: string): LifecycleExecution[] {
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
  return [];
}

export type PrReviewExecution = { open: { artifact: string; head: string; agent: string; startedAt: string } | null; terminals: Array<{ artifact: string; head: string; agent: string; note: string }> };
export function prReviewExecution(content: string): PrReviewExecution {
  const value = parseTypedTaskFrontmatter(content).lifecycle_execution;
  if (value === undefined) return { open: null, terminals: [] };
  if (typeof value !== 'string') throw new Error('invalid lifecycle execution state');
  const state = JSON.parse(value);
  if (state.version !== 1 || !Array.isArray(state.open)) throw new Error('invalid lifecycle execution state');
  const pr = state.prReview ?? { open: null, terminals: [] };
  const valid = (item: any) => item && typeof item.artifact === 'string' && typeof item.head === 'string' && typeof item.agent === 'string';
  if (!Array.isArray(pr.terminals) || (pr.open !== null && (!valid(pr.open) || typeof pr.open.startedAt !== 'string')) || !pr.terminals.every((item: any) => valid(item) && typeof item.note === 'string')) throw new Error('invalid PR review execution state');
  return pr;
}
export function serializeLifecycleExecution(open: readonly LifecycleExecution[], content?: string, prReview?: PrReviewExecution): string {
  const pr = prReview ?? (content ? prReviewExecution(content) : { open: null, terminals: [] });
  return JSON.stringify({ version: 1, open, prReview: pr });
}
