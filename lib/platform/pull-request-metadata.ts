import { taskTypeLabel } from './metadata-labels.ts';
import type { PlatformCapabilities } from './types.ts';

type PullRequestMetadataSnapshot = {
  labels: string[];
  assignees: string[];
  milestone: string | null;
  body: string;
};

type IssueMetadataSource = {
  labels: string[];
  assignees: string[];
  milestone: string | null;
};

type PullRequestMetadataOperation = {
  name: 'labels' | 'assignees' | 'milestone' | 'closing-issue';
  status: 'planned' | 'no-op' | 'skipped';
  reasonCode: string | null;
  value?: unknown;
};

function equalStrings(left: string[], right: string[]): boolean {
  return [...left].sort().join('\0') === [...right].sort().join('\0');
}

function ensureClosingReference(body: string, issueNumber: number): string {
  const pattern = new RegExp(`(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\s+#${issueNumber}\\b`, 'i');
  return pattern.test(body) ? body : `${body.replace(/\s+$/, '')}\n\nCloses #${issueNumber}`;
}

function planPullRequestMetadata(input: {
  pullRequest: PullRequestMetadataSnapshot;
  issue: IssueMetadataSource;
  taskType: string;
  issueNumber: number | null;
  capabilities: PlatformCapabilities;
  inLabels?: string[];
}): { operations: PullRequestMetadataOperation[] } {
  const typeLabel = taskTypeLabel(input.taskType);
  const targetInLabels = input.inLabels || input.pullRequest.labels.filter((label) => label.startsWith('in:'));
  const desiredLabels = [...new Set([
    ...input.pullRequest.labels.filter((label) => !label.startsWith('type:') && !label.startsWith('in:')),
    ...(typeLabel ? [typeLabel] : []),
    ...targetInLabels.filter((label) => label.startsWith('in:'))
  ])].sort();
  const body = input.issueNumber === null ? input.pullRequest.body : ensureClosingReference(input.pullRequest.body, input.issueNumber);
  return { operations: [
    input.capabilities.triage
      ? equalStrings(input.pullRequest.labels, desiredLabels)
        ? { name: 'labels', status: 'no-op', reasonCode: null }
        : { name: 'labels', status: 'planned', reasonCode: null, value: desiredLabels }
      : { name: 'labels', status: 'skipped', reasonCode: 'TRIAGE_REQUIRED' },
    equalStrings(input.pullRequest.assignees, input.issue.assignees)
      ? { name: 'assignees', status: 'no-op', reasonCode: null }
      : { name: 'assignees', status: 'planned', reasonCode: null, value: [...input.issue.assignees].sort() },
    input.capabilities.triage
      ? input.pullRequest.milestone === input.issue.milestone
        ? { name: 'milestone', status: 'no-op', reasonCode: null }
        : { name: 'milestone', status: 'planned', reasonCode: null, value: input.issue.milestone }
      : { name: 'milestone', status: 'skipped', reasonCode: 'TRIAGE_REQUIRED' },
    input.issueNumber === null
      ? { name: 'closing-issue', status: 'skipped', reasonCode: 'ISSUE_REFERENCE_UNSUPPORTED' }
      : body === input.pullRequest.body
        ? { name: 'closing-issue', status: 'no-op', reasonCode: null }
        : { name: 'closing-issue', status: 'planned', reasonCode: null, value: body }
  ] };
}

export { ensureClosingReference, planPullRequestMetadata };
export type { IssueMetadataSource, PullRequestMetadataOperation, PullRequestMetadataSnapshot };
