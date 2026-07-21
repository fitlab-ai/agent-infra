import type { PlatformCapabilities, PlatformOperation } from './types.ts';

type Requirement = { text: string; checked: boolean };
type IssueMetadataSnapshot = {
  labels: string[];
  assignees: string[];
  milestone: string | null;
  state: 'open' | 'closed';
  body: string;
};
type IssueDesiredState = {
  status?: string | 'none';
  assignees?: 'current' | 'none';
  milestone?: 'initial' | 'specific' | 'none';
  requirements?: Requirement[];
  state?: 'open' | 'closed';
};
type PlannedOperation = PlatformOperation & { value?: unknown };

const TYPE_MAP: Record<string, string> = {
  bug: 'Bug', bugfix: 'Bug', feature: 'Feature', enhancement: 'Feature'
};

function desiredIssueType(taskType: string): string {
  return TYPE_MAP[taskType] || 'Task';
}

function normalizeOption(value: string): string {
  return ({ '紧急': 'Urgent', '高': 'High', '中': 'Medium', '低': 'Low' } as Record<string, string>)[value] || value;
}

function computeInLabels(
  changedFiles: string[],
  mapping: Record<string, unknown>,
  repositoryLabels: Set<string>
): string[] {
  return Object.entries(mapping).flatMap(([name, rawPrefixes]) => {
    if (!Array.isArray(rawPrefixes)) return [];
    const matches = rawPrefixes.some((prefix) => typeof prefix === 'string' && prefix.length > 0
      && changedFiles.some((file) => file === prefix.replace(/\/$/, '') || file.startsWith(prefix)));
    const label = `in: ${name}`;
    return matches && repositoryLabels.has(label) ? [label] : [];
  }).sort();
}

function versionParts(value: string): [number, number, number | null] | null {
  const match = /^(\d+)\.(\d+)\.(x|\d+)$/.exec(value);
  return match ? [Number(match[1]), Number(match[2]), match[3] === 'x' ? null : Number(match[3])] : null;
}

function chooseMilestone(
  mode: 'initial' | 'specific' | 'none',
  milestones: string[],
  current: string | null = null
): string | null {
  if (mode === 'none') return null;
  const parsed = milestones.map((title) => ({ title, parts: versionParts(title) })).filter((item) => item.parts);
  if (mode === 'initial') {
    const lines = parsed.filter((item) => item.parts![2] === null).sort((a, b) =>
      a.parts![0] - b.parts![0] || a.parts![1] - b.parts![1]
    );
    return lines[0]?.title || (milestones.includes('General Backlog') ? 'General Backlog' : current);
  }
  const currentParts = current ? versionParts(current) : null;
  const line = currentParts?.[2] === null ? currentParts.slice(0, 2) : null;
  const versions = parsed.filter((item) => item.parts![2] !== null && (!line || (
    item.parts![0] === line[0] && item.parts![1] === line[1]
  ))).sort((a, b) =>
    b.parts![0] - a.parts![0] || b.parts![1] - a.parts![1] || b.parts![2]! - a.parts![2]!
  );
  return versions[0]?.title || current;
}

function checkboxPattern(text: string): RegExp {
  const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^(\\s*[-*+]\\s+\\[)([ xX])(\\]\\s+${escaped}\\s*)$`, 'gm');
}

function syncRequirementCheckboxes(
  body: string,
  requirements: Requirement[]
): { ok: true; changed: boolean; body: string } | { ok: false; code: 'REQUIREMENT_IDENTITY_AMBIGUOUS' } {
  let next = body;
  for (const requirement of requirements) {
    const pattern = checkboxPattern(requirement.text);
    const matches = [...next.matchAll(pattern)];
    if (matches.length > 1) return { ok: false, code: 'REQUIREMENT_IDENTITY_AMBIGUOUS' };
    if (matches.length === 1) {
      next = next.replace(pattern, `$1${requirement.checked ? 'x' : ' '}$3`);
    }
  }
  return { ok: true, changed: next !== body, body: next };
}

function planIssueMetadata(input: {
  snapshot: IssueMetadataSnapshot;
  desired: IssueDesiredState;
  repositoryLabels?: Set<string>;
  milestones?: string[];
  currentUser?: string | null;
  capabilities: PlatformCapabilities;
}): { operations: PlannedOperation[] } {
  const operations: PlannedOperation[] = [];
  const { snapshot, desired, capabilities } = input;
  if (desired.status !== undefined || desired.state === 'closed') {
    if (!capabilities.triage) operations.push({ name: 'labels:status', status: 'skipped', reasonCode: 'TRIAGE_REQUIRED' });
    else {
      const retained = snapshot.labels.filter((label) => !label.startsWith('status:'));
      const target = desired.state === 'closed' || desired.status === 'none' || desired.status === undefined
        ? null
        : `status: ${desired.status}`;
      if (target && !input.repositoryLabels?.has(target)) {
        operations.push({ name: 'labels:status', status: 'skipped', reasonCode: 'LABEL_UNAVAILABLE' });
      } else if (target) retained.push(target);
      const value = [...new Set(retained)].sort();
      const current = [...snapshot.labels].sort();
      if (!target || input.repositoryLabels?.has(target)) {
        operations.push(current.join('\0') === value.join('\0')
          ? { name: 'labels:status', status: 'no-op', reasonCode: null }
          : { name: 'labels:status', status: 'planned', reasonCode: null, value });
      }
    }
  }
  if (desired.assignees !== undefined) {
    const value = desired.assignees === 'none' ? [] : input.currentUser ? [input.currentUser] : [];
    operations.push([...snapshot.assignees].sort().join('\0') === value.join('\0')
      ? { name: 'assignees', status: 'no-op', reasonCode: null }
      : { name: 'assignees', status: 'planned', reasonCode: null, value });
  }
  if (desired.milestone !== undefined) {
    if (!capabilities.triage) operations.push({ name: 'milestone', status: 'skipped', reasonCode: 'TRIAGE_REQUIRED' });
    else {
      const value = chooseMilestone(desired.milestone, input.milestones || [], snapshot.milestone);
      operations.push(value === snapshot.milestone
        ? { name: 'milestone', status: 'no-op', reasonCode: null }
        : { name: 'milestone', status: 'planned', reasonCode: null, value });
    }
  }
  if (desired.requirements !== undefined) {
    const synced = syncRequirementCheckboxes(snapshot.body, desired.requirements);
    operations.push(!synced.ok
      ? { name: 'requirements', status: 'failed', reasonCode: synced.code }
      : synced.changed
        ? { name: 'requirements', status: 'planned', reasonCode: null, value: synced.body }
        : { name: 'requirements', status: 'no-op', reasonCode: null });
  }
  if (desired.state !== undefined) {
    operations.push(desired.state === snapshot.state
      ? { name: 'state', status: 'no-op', reasonCode: null }
      : { name: 'state', status: 'planned', reasonCode: null, value: desired.state });
  }
  return { operations };
}

export {
  chooseMilestone,
  computeInLabels,
  desiredIssueType,
  normalizeOption,
  planIssueMetadata,
  syncRequirementCheckboxes
};
export type { IssueDesiredState, IssueMetadataSnapshot, PlannedOperation, Requirement };
