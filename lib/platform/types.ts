type PlatformStatus = 'planned' | 'applied' | 'no-op' | 'degraded' | 'failed' | 'blocked';

type PlatformError = {
  code: string;
  message: string;
  retryable: boolean;
};

type PlatformCapabilities = {
  authenticated: boolean;
  comment: boolean;
  triage: boolean;
  push: boolean;
  admin: boolean;
};

type PlatformOperation = {
  name: string;
  status: 'planned' | 'applied' | 'no-op' | 'skipped' | 'failed';
  reasonCode: string | null;
};

type CommentIdentity = {
  kind: 'task' | 'artifact' | 'summary' | 'cancel';
  marker: string;
  ids: Array<number | string>;
  parts: number;
};

import type { ResourceIdentity } from './resource-identity.ts';

type PlatformResult = {
  status: PlatformStatus;
  changed: boolean;
  platform: { type: string | null; repository: string | null; currentUser: string | null };
  resource: { kind: 'repository' | 'issue' | 'pull-request'; number: number | null; identity?: ResourceIdentity };
  capabilities: PlatformCapabilities;
  operations: PlatformOperation[];
  comment: CommentIdentity | null;
  error: PlatformError | null;
};

const EMPTY_CAPABILITIES: PlatformCapabilities = {
  authenticated: false,
  comment: false,
  triage: false,
  push: false,
  admin: false
};

function platformResult(
  status: PlatformStatus,
  overrides: Partial<PlatformResult> = {}
): PlatformResult {
  return {
    status,
    changed: status === 'applied',
    platform: { type: null, repository: null, currentUser: null },
    resource: { kind: 'repository', number: null },
    capabilities: { ...EMPTY_CAPABILITIES },
    operations: [],
    comment: null,
    error: null,
    ...overrides
  };
}

export { EMPTY_CAPABILITIES, platformResult };
export type {
  CommentIdentity,
  PlatformCapabilities,
  PlatformError,
  PlatformOperation,
  PlatformResult,
  PlatformStatus
};
