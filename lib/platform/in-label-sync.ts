import { computeInLabels } from './metadata-labels.ts';
import type { PlatformError } from './types.ts';

type InLabelPlan = {
  current: string[];
  target: string[];
  labels: string[];
  changed: boolean;
  error: InLabelValidationError | null;
};

type InLabelResource = {
  kind: 'issue' | 'pull-request';
  number: number;
  labels: string[];
};

type InLabelValidationError = {
  code: string;
  message: string;
  retryable: boolean;
};

type LabelPrefix = string | readonly string[];

type LabelDelta = {
  add: string[];
  remove: string[];
};

type LabelDeltaResult = {
  status: 'applied' | 'no-op' | 'failed' | 'blocked';
  changed: boolean;
  error: PlatformError | null;
};

type LabelSyncClient = {
  json<T = unknown>(args: string[], options?: { cwd?: string; method?: string; input?: string }): any;
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

function invalidInLabelInput(code: string, message: string): { ok: false; error: InLabelValidationError } {
  return { ok: false, error: { code, message, retryable: false } };
}

function validateInLabelMapping(value: unknown): { ok: true; value: Record<string, string[]> } | { ok: false; error: InLabelValidationError } {
  if (value === undefined) return { ok: true, value: {} };
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return invalidInLabelInput('IN_LABEL_SYNC_MAPPING_INVALID', 'labels.in must be an object of non-empty string arrays');
  }
  const normalized: Record<string, string[]> = {};
  for (const [name, rawPrefixes] of Object.entries(value)) {
    if (!name.trim() || !Array.isArray(rawPrefixes) || rawPrefixes.length === 0 || rawPrefixes.some((prefix) => typeof prefix !== 'string' || !prefix.trim())) {
      return invalidInLabelInput('IN_LABEL_SYNC_MAPPING_INVALID', `labels.in entry '${name}' must be a non-empty string array`);
    }
    normalized[name] = rawPrefixes.map((prefix) => prefix.trim());
  }
  return { ok: true, value: normalized };
}

function repositoryLabelPages(value: unknown): unknown[][] | null {
  if (!Array.isArray(value)) return null;
  if (value.length === 0) return [];
  if (value.every((page) => Array.isArray(page))) return value as unknown[][];
  if (value.every((entry) => entry && typeof entry === 'object' && !Array.isArray(entry))) return [value];
  return null;
}

function validateRepositoryLabelPayload(value: unknown): { ok: true; value: string[] } | { ok: false; error: InLabelValidationError } {
  const pages = repositoryLabelPages(value);
  if (!pages) return invalidInLabelInput('IN_LABEL_SYNC_LABELS_INVALID', 'Repository labels response must be an array of pages');
  const names: string[] = [];
  for (const page of pages) {
    for (const entry of page) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry) || typeof (entry as { name?: unknown }).name !== 'string' || !(entry as { name: string }).name.trim()) {
        return invalidInLabelInput('IN_LABEL_SYNC_LABELS_INVALID', 'Repository labels response contains an entry without a valid name');
      }
      names.push((entry as { name: string }).name);
    }
  }
  return { ok: true, value: [...new Set(names)].sort() };
}

function validateRepositoryLabelSet(value: unknown): { ok: true; value: Set<string> } | { ok: false; error: InLabelValidationError } {
  if (!(value instanceof Set) || [...value].some((label) => typeof label !== 'string' || !label.trim())) {
    return invalidInLabelInput('IN_LABEL_SYNC_LABELS_INVALID', 'Repository labels must be a set of non-empty names');
  }
  return { ok: true, value: new Set([...value] as string[]) };
}

function planInLabelUpdate(input: {
  changedFiles: readonly string[];
  currentLabels: readonly string[];
  mapping: Record<string, unknown>;
  repositoryLabels: Set<string>;
}): InLabelPlan {
  const current = inLabels(input.currentLabels);
  const mapping = validateInLabelMapping(input.mapping);
  const repositoryLabels = validateRepositoryLabelSet(input.repositoryLabels);
  if (!mapping.ok) return { current, target: [...current], labels: [...input.currentLabels].sort(), changed: false, error: mapping.error };
  if (!repositoryLabels.ok) return { current, target: [...current], labels: [...input.currentLabels].sort(), changed: false, error: repositoryLabels.error };
  const target = computeInLabels([...input.changedFiles], mapping.value, repositoryLabels.value);
  const labels = mergeInLabels(input.currentLabels, target);
  return { current, target, labels, changed: labels.join('\0') !== [...input.currentLabels].sort().join('\0'), error: null };
}

function startsWithPrefix(label: string, prefix: LabelPrefix): boolean {
  return (Array.isArray(prefix) ? prefix : [prefix]).some((value) => label.startsWith(value));
}

function labelDelta(current: readonly string[], target: readonly string[], prefix: LabelPrefix = 'in:'): LabelDelta {
  const currentLabels = [...new Set(current)].sort();
  const targetLabels = [...new Set(target.filter((label) => startsWithPrefix(label, prefix)))].sort();
  return {
    add: targetLabels.filter((label) => !currentLabels.includes(label)),
    remove: currentLabels.filter((label) => startsWithPrefix(label, prefix) && !targetLabels.includes(label))
  };
}

function syncLabelDelta(
  client: LabelSyncClient,
  repository: string,
  number: number,
  cwd: string,
  current: readonly string[],
  target: readonly string[],
  prefix: LabelPrefix = 'in:'
): LabelDeltaResult {
  const delta = labelDelta(current, target, prefix);
  let changed = false;
  const failure = (error: PlatformError): LabelDeltaResult => {
    if (changed || error.retryable) {
      return {
        status: 'blocked',
        changed,
        error: { ...error, code: 'IN_LABEL_SYNC_PARTIAL', message: `In-label synchronization is partial or unknown: ${error.message}` }
      };
    }
    return { status: 'failed', changed: false, error };
  };
  for (const label of delta.remove) {
    const removed = client.json<unknown>([
      'api', `repos/${repository}/issues/${number}/labels/${encodeURIComponent(label)}`, '-X', 'DELETE'
    ], { cwd, method: 'DELETE' });
    if (!removed.ok) return failure(removed.error);
    changed = true;
  }
  for (const label of delta.add) {
    const added = client.json<unknown>([
      'api', `repos/${repository}/issues/${number}/labels`, '-X', 'POST', '--input', '-'
    ], { cwd, method: 'POST', input: JSON.stringify({ labels: [label] }) });
    if (!added.ok) return failure(added.error);
    changed = true;
  }
  return { status: changed ? 'applied' : 'no-op', changed, error: null };
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
  labelDelta,
  mergeInLabels,
  planInLabelUpdate,
  resourceSnapshot,
  syncLabelDelta,
  validateInLabelMapping,
  validateRepositoryLabelPayload
};
export type { InLabelPlan, InLabelResource, InLabelValidationError, LabelDelta, LabelDeltaResult, LabelPrefix };
