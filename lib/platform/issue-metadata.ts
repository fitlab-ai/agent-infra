import type { PlatformCapabilities, PlatformOperation } from './types.ts';
import { computeInLabels } from './metadata-labels.ts';

type Requirement = { text: string; checked: boolean };
type RequirementSectionAnchor = { level: 2 | 3; heading: string };
type RequirementSectionResolution =
  | { status: 'found'; bodyStart: number; bodyEnd: number }
  | { status: 'missing'; code: 'NO_REQUIREMENTS_ANCHOR' }
  | { status: 'ambiguous'; code: 'REQUIREMENTS_ANCHOR_AMBIGUOUS' };
type RequirementSyncResult =
  | { status: 'synced'; changed: boolean; body: string }
  | { status: 'skipped'; changed: false; body: string; code: 'NO_REQUIREMENTS_ANCHOR' }
  | { status: 'failed'; code: 'REQUIREMENTS_ANCHOR_AMBIGUOUS' | 'REQUIREMENT_IDENTITY_AMBIGUOUS' };
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

const DEFAULT_REQUIREMENT_SECTION_ANCHORS: RequirementSectionAnchor[] = [
  { level: 2, heading: '需求' },
  { level: 2, heading: 'Requirements' }
];

const TYPE_MAP: Record<string, string> = {
  bug: 'Bug', bugfix: 'Bug', feature: 'Feature', enhancement: 'Feature'
};

function desiredIssueType(taskType: string): string {
  return TYPE_MAP[taskType] || 'Task';
}

function normalizeOption(value: string): string {
  return ({ '紧急': 'Urgent', '高': 'High', '中': 'Medium', '低': 'Low' } as Record<string, string>)[value] || value;
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

function hasCheckedRequirement(body: string, text: string): boolean {
  return [...body.matchAll(checkboxPattern(text))].some((match) => match[2]?.toLowerCase() === 'x');
}

function visibleHeadings(body: string): Array<{ level: number; heading: string; start: number; end: number }> {
  const headings: Array<{ level: number; heading: string; start: number; end: number }> = [];
  let fence: { marker: '`' | '~'; length: number } | null = null;
  for (const match of body.matchAll(/[^\r\n]*(?:\r\n|\n|$)/g)) {
    const raw = match[0];
    if (!raw) break;
    const line = raw.replace(/\r?\n$/, '');
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1]![0] as '`' | '~';
      const length = fenceMatch[1]!.length;
      if (!fence) fence = { marker, length };
      else if (fence.marker === marker && length >= fence.length) fence = null;
      continue;
    }
    if (fence) continue;
    const headingMatch = /^(#{1,6})[ \t]+(.+?)[ \t]*$/.exec(line);
    if (!headingMatch) continue;
    const heading = headingMatch[2]!.replace(/[ \t]+#+[ \t]*$/, '').trim();
    headings.push({
      level: headingMatch[1]!.length,
      heading,
      start: match.index!,
      end: match.index! + raw.length
    });
  }
  return headings;
}

function resolveRequirementSection(
  body: string,
  anchors: RequirementSectionAnchor[] = DEFAULT_REQUIREMENT_SECTION_ANCHORS
): RequirementSectionResolution {
  const allowed = new Set(anchors.map((anchor) => `${anchor.level}\0${anchor.heading}`));
  const headings = visibleHeadings(body);
  const candidates = headings.flatMap((heading, index) => {
    if (!allowed.has(`${heading.level}\0${heading.heading}`)) return [];
    const next = headings.slice(index + 1).find((item) => item.level <= heading.level);
    return [{ bodyStart: heading.end, bodyEnd: next?.start ?? body.length }];
  });
  if (candidates.length === 0) return { status: 'missing', code: 'NO_REQUIREMENTS_ANCHOR' };
  if (candidates.length > 1) return { status: 'ambiguous', code: 'REQUIREMENTS_ANCHOR_AMBIGUOUS' };
  return { status: 'found', ...candidates[0]! };
}

function syncRequirementCheckboxes(
  body: string,
  requirements: Requirement[],
  anchors: RequirementSectionAnchor[] = DEFAULT_REQUIREMENT_SECTION_ANCHORS
): RequirementSyncResult {
  if (new Set(requirements.map((requirement) => requirement.text)).size !== requirements.length) {
    return { status: 'failed', code: 'REQUIREMENT_IDENTITY_AMBIGUOUS' };
  }
  const resolution = resolveRequirementSection(body, anchors);
  if (resolution.status === 'missing') return { status: 'skipped', changed: false, body, code: resolution.code };
  if (resolution.status === 'ambiguous') return { status: 'failed', code: resolution.code };

  const section = body.slice(resolution.bodyStart, resolution.bodyEnd);
  const matches = requirements.map((requirement) => ({
    requirement,
    count: [...section.matchAll(checkboxPattern(requirement.text))].length
  }));
  if (matches.some((match) => match.count > 1)) {
    return { status: 'failed', code: 'REQUIREMENT_IDENTITY_AMBIGUOUS' };
  }

  let nextSection = section;
  const missing: Requirement[] = [];
  for (const { requirement, count } of matches) {
    const pattern = checkboxPattern(requirement.text);
    if (count === 1) nextSection = nextSection.replace(pattern, `$1${requirement.checked ? 'x' : ' '}$3`);
    else missing.push(requirement);
  }
  if (missing.length > 0) {
    const newline = body.includes('\r\n') ? '\r\n' : '\n';
    const separator = nextSection.length === 0 || nextSection.endsWith('\n') ? '' : newline;
    const suffix = resolution.bodyEnd < body.length ? newline : '';
    nextSection += `${separator}${missing.map((item) => `- [${item.checked ? 'x' : ' '}] ${item.text}`).join(newline)}${suffix}`;
  }
  const next = body.slice(0, resolution.bodyStart) + nextSection + body.slice(resolution.bodyEnd);
  return { status: 'synced', changed: next !== body, body: next };
}

function planIssueMetadata(input: {
  snapshot: IssueMetadataSnapshot;
  desired: IssueDesiredState;
  repositoryLabels?: Set<string>;
  milestones?: string[];
  currentUser?: string | null;
  requirementAnchors?: RequirementSectionAnchor[];
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
    const synced = syncRequirementCheckboxes(snapshot.body, desired.requirements, input.requirementAnchors);
    operations.push(synced.status === 'failed'
      ? { name: 'requirements', status: 'failed', reasonCode: synced.code }
      : synced.status === 'skipped'
        ? { name: 'requirements', status: 'skipped', reasonCode: synced.code }
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
  DEFAULT_REQUIREMENT_SECTION_ANCHORS,
  chooseMilestone,
  computeInLabels,
  desiredIssueType,
  hasCheckedRequirement,
  normalizeOption,
  planIssueMetadata,
  resolveRequirementSection,
  syncRequirementCheckboxes
};
export type {
  IssueDesiredState,
  IssueMetadataSnapshot,
  PlannedOperation,
  Requirement,
  RequirementSectionAnchor,
  RequirementSectionResolution,
  RequirementSyncResult
};
