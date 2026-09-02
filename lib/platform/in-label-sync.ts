import { computeInLabels } from './metadata-labels.ts';

type InLabelPlan = {
  current: string[];
  target: string[];
  labels: string[];
  changed: boolean;
};

type InLabelResource = {
  kind: 'issue' | 'pull-request';
  number: number;
  labels: string[];
};

function inLabels(labels: readonly string[]): string[] {
  return [...new Set(labels.filter((label) => label.startsWith('in:')))].sort();
}

function mergeInLabels(labels: readonly string[], target: readonly string[]): string[] {
  return [...new Set([
    ...labels.filter((label) => !label.startsWith('in:')),
    ...target
  ])].sort();
}

function planInLabelUpdate(input: {
  changedFiles: readonly string[];
  currentLabels: readonly string[];
  mapping: Record<string, unknown>;
  repositoryLabels: Set<string>;
}): InLabelPlan {
  const current = inLabels(input.currentLabels);
  const target = computeInLabels([...input.changedFiles], input.mapping, input.repositoryLabels);
  const labels = mergeInLabels(input.currentLabels, target);
  return { current, target, labels, changed: labels.join('\0') !== [...input.currentLabels].sort().join('\0') };
}

function flattenPages(value: unknown): unknown[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((page) => Array.isArray(page) ? page : [page]);
}

function extractRepositoryLabelNames(value: unknown): string[] {
  return flattenPages(value).flatMap((entry) => {
    if (typeof entry === 'string') return [entry];
    if (entry && typeof entry === 'object' && typeof (entry as { name?: unknown }).name === 'string') {
      return [(entry as { name: string }).name];
    }
    return [];
  }).filter(Boolean).sort();
}

function extractPullRequestFileNames(value: unknown): string[] | null {
  const entries = flattenPages(value);
  if (!Array.isArray(value) || entries.some((entry) => !entry || typeof entry !== 'object')) return null;
  const names = entries.map((entry) => (entry as { filename?: unknown }).filename);
  if (names.some((name) => typeof name !== 'string' || !name.trim())) return null;
  return [...new Set(names as string[])].sort();
}

function resourceSnapshot(kind: InLabelResource['kind'], number: number, labels: readonly string[]): InLabelResource {
  return { kind, number, labels: [...labels].sort() };
}

export {
  extractPullRequestFileNames,
  extractRepositoryLabelNames,
  flattenPages,
  inLabels,
  mergeInLabels,
  planInLabelUpdate,
  resourceSnapshot
};
export type { InLabelPlan, InLabelResource };
