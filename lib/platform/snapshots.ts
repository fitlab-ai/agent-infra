import type { ResourceIdentity } from './resource-identity.ts';

export type PlatformIssueSnapshot = {
  repository: string;
  number: number;
  identity?: ResourceIdentity;
  databaseId: number | null;
  nodeId: string;
  url: string;
  state: 'open' | 'closed';
  title: string;
  body: string;
  labels: string[];
  assignees: string[];
  milestone: string | null;
  issueType: string | null;
  fields: Record<string, string | number | null>;
};

export type PlatformMergeability = {
  state: 'mergeable' | 'conflicting' | 'unknown';
  detail: string | null;
};

export type PlatformChangeRequestSnapshot = {
  repository: string;
  number: number;
  nodeId: string;
  url: string;
  state: 'open' | 'closed';
  title: string;
  body: string;
  draft: boolean;
  head: { repository: string; ref: string; sha: string };
  base: { repository: string; ref: string; sha: string };
  mergedAt: string | null;
  mergeCommitSha: string | null;
  labels: string[];
  assignees: string[];
  milestone: string | null;
  mergeability?: PlatformMergeability;
  identity?: ResourceIdentity;
};

export type PlatformCheckSnapshot = {
  name: string;
  bucket: 'pass' | 'fail' | 'pending' | 'cancel';
  workflow?: string | null;
  conclusion?: string | null;
  detailsUrl?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
};
