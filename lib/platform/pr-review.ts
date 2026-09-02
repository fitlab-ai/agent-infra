import { createGitHubClient } from './github-client.ts';
import type { GitHubClient } from './github-client.ts';
import { resolvePlatformProviderContext } from './context.ts';
import { platformResult } from './types.ts';
import type { PlatformOperation, PlatformResult } from './types.ts';
import {
  providerError,
  providerOperationContext,
  providerStatus,
  resourceIdentity,
  unsupportedProviderOperation
} from './provider-bridge.ts';

export type PrReviewEvent = 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES';
export type PrReviewIdentity = { scope: string; round: number; commitSha: string };
export type PrReviewListEntry = { id: number | string; commitId: string; body: string; url: string };
export type PrReviewListResult = PlatformResult & { reviews: PrReviewListEntry[] };

type RemoteReview = {
  id?: number;
  node_id?: string;
  commit_id?: string;
  body?: string | null;
  state?: string;
  html_url?: string;
};

const REVIEW_EVENTS: readonly PrReviewEvent[] = ['COMMENT', 'APPROVE', 'REQUEST_CHANGES'];
// Marker-safe scope: a task id (`TASK-YYYYMMDD-HHMMSS`) or a bare PR number
// (`pr{N}`). Any other value (e.g. one containing `\r\n` or `-->`) would break
// the first-line marker idempotency contract of `reviewMarker` (PL-6).
const REVIEW_SCOPE_PATTERN = /^(?:pr\d+|TASK-\d{8}-\d{6})$/;

export function reviewMarker(identity: PrReviewIdentity): string {
  return `<!-- review-pr:${identity.scope}:r${identity.round} -->`;
}

export function reviewedCommitMarker(sha: string): string {
  return `<!-- reviewed-commit: ${sha} -->`;
}

function normalizeBody(body: string): string {
  return String(body || '').replace(/\r\n/g, '\n').replace(/\n+$/, '\n');
}

function firstLine(body: string): string {
  return normalizeBody(String(body || '')).split('\n', 1)[0] || '';
}

function hasUsableContext(context: PlatformResult): boolean {
  return (context.status === 'no-op' || context.status === 'degraded') && context.platform.repository !== null;
}

function invalidPrNumber(prNumber: number): boolean {
  return !Number.isInteger(prNumber) || prNumber <= 0;
}

export async function listPrReviews(prNumber: number, options: { cwd?: string; client?: GitHubClient } = {}): Promise<PrReviewListResult> {
  const client = options.client || createGitHubClient();
  const loaded = await resolvePlatformProviderContext({ cwd: options.cwd || process.cwd(), client });
  const context = loaded.ok ? loaded.value.context : loaded.context;
  if (!hasUsableContext(context)) {
    return { ...platformResult(context.status, { platform: context.platform, capabilities: context.capabilities, error: context.error }), reviews: [] };
  }
  const repository = context.platform.repository!;
  if (invalidPrNumber(prNumber)) {
    return {
      ...platformResult('failed', {
        platform: context.platform, capabilities: context.capabilities,
        error: { code: 'PR_NUMBER_INVALID', message: 'PR number must be positive', retryable: false }
      }),
      reviews: []
    };
  }
  if (loaded.ok) {
    const fetched = loaded.value.provider.reviews?.list
      ? await loaded.value.provider.reviews.list({ context: providerOperationContext(loaded.value), changeRequest: resourceIdentity(prNumber) })
      : unsupportedProviderOperation(loaded.value.provider, 'reviews.list');
    if (!fetched.ok) return {
      ...platformResult(providerStatus(fetched.error), {
        platform: context.platform, capabilities: context.capabilities,
        resource: { kind: 'pull-request', number: prNumber }, error: providerError(fetched.error, 'PLATFORM_PROVIDER_OPERATION_FAILED')
      }), reviews: []
    };
    return {
      ...platformResult('no-op', {
        platform: context.platform, capabilities: context.capabilities,
        resource: { kind: 'pull-request', number: prNumber }, error: null
      }),
      reviews: fetched.value.map((review) => ({ id: review.id, commitId: review.commitSha || '', body: review.body, url: review.displayUrl || '' }))
    };
  }
  const fetched = client.json<RemoteReview[]>(['api', '--paginate', '--slurp', `repos/${repository}/pulls/${prNumber}/reviews?per_page=100`], { cwd: options.cwd || process.cwd() });
  if (!fetched.ok) {
    return {
      ...platformResult(fetched.error.retryable ? 'blocked' : 'failed', {
        platform: context.platform, capabilities: context.capabilities,
        resource: { kind: 'pull-request', number: prNumber }, error: fetched.error
      }),
      reviews: []
    };
  }
  const flat = (fetched.value || []).flatMap((entry) => Array.isArray(entry) ? entry : [entry]);
  const reviews: PrReviewListEntry[] = flat
    .map((review) => ({
      id: review.id ?? 0,
      commitId: review.commit_id ?? '',
      body: review.body ?? '',
      url: review.html_url ?? ''
    }))
    .filter((review) => review.body !== '');
  return {
    ...platformResult('no-op', {
      platform: context.platform, capabilities: context.capabilities,
      resource: { kind: 'pull-request', number: prNumber }, error: null
    }),
    reviews
  };
}

export async function publishPrReview(options: {
  cwd?: string;
  client?: GitHubClient;
  dryRun?: boolean;
  prNumber: number;
  identity: PrReviewIdentity;
  event: PrReviewEvent;
  body: string;
}): Promise<PlatformResult> {
  const client = options.client || createGitHubClient();
  const loaded = await resolvePlatformProviderContext({ cwd: options.cwd || process.cwd(), client });
  const context = loaded.ok ? loaded.value.context : loaded.context;
  if (!hasUsableContext(context)) {
    return platformResult(context.status, { platform: context.platform, capabilities: context.capabilities, error: context.error });
  }
  const repository = context.platform.repository!;
  if (invalidPrNumber(options.prNumber)) {
    return platformResult('failed', {
      platform: context.platform, capabilities: context.capabilities,
      error: { code: 'PR_NUMBER_INVALID', message: 'PR number must be positive', retryable: false }
    });
  }
  if (!REVIEW_EVENTS.includes(options.event)) {
    return platformResult('failed', {
      platform: context.platform, capabilities: context.capabilities,
      resource: { kind: 'pull-request', number: options.prNumber },
      error: { code: 'REVIEW_EVENT_INVALID', message: `review event must be one of ${REVIEW_EVENTS.join('|')}`, retryable: false }
    });
  }
  if (!REVIEW_SCOPE_PATTERN.test(options.identity.scope) || !/^[0-9a-f]{7,40}$/i.test(options.identity.commitSha)) {
    return platformResult('failed', {
      platform: context.platform, capabilities: context.capabilities,
      resource: { kind: 'pull-request', number: options.prNumber },
      error: { code: 'REVIEW_IDENTITY_INVALID', message: 'review scope must be a task id or pr{N}; commitSha is required', retryable: false }
    });
  }

  const marker = reviewMarker(options.identity);
  const listed = await listPrReviews(options.prNumber, { cwd: options.cwd, client });
  if (listed.status === 'failed' || listed.status === 'blocked') return listed;
  const existing = listed.reviews.find((review) => firstLine(review.body) === marker) ?? null;
  if (existing) {
    if (existing.commitId === options.identity.commitSha) {
      return platformResult('no-op', {
        platform: context.platform, capabilities: context.capabilities,
        resource: { kind: 'pull-request', number: options.prNumber },
        operations: [{ name: 'review:publish', status: 'no-op', reasonCode: null }], error: null
      });
    }
    return platformResult('failed', {
      platform: context.platform, capabilities: context.capabilities,
      resource: { kind: 'pull-request', number: options.prNumber },
      operations: [{ name: 'review:publish', status: 'failed', reasonCode: 'REVIEW_MARKER_CONFLICT' }],
      error: { code: 'REVIEW_MARKER_CONFLICT', message: 'A review with the same marker targets a different commit; start a new round', retryable: false }
    });
  }

  const wrappedBody = [
    marker,
    reviewedCommitMarker(options.identity.commitSha),
    '',
    String(options.body || '').replace(/\r?\n/g, '\n').replace(/\n+$/, ''),
    ''
  ].join('\n');

  if (options.dryRun) {
    return platformResult('planned', {
      platform: context.platform, capabilities: context.capabilities,
      resource: { kind: 'pull-request', number: options.prNumber },
      operations: [{ name: 'review:publish', status: 'planned', reasonCode: null }], error: null
    });
  }

  if (loaded.ok) {
    const published = loaded.value.provider.reviews?.publish
      ? await loaded.value.provider.reviews.publish({
        context: providerOperationContext(loaded.value),
        changeRequest: resourceIdentity(options.prNumber),
        identity: options.identity,
        event: options.event,
        body: wrappedBody,
        mutation: { idempotencyKey: `review:publish:${marker}` }
      })
      : unsupportedProviderOperation(loaded.value.provider, 'reviews.publish');
    if (!published.ok) {
      if (published.error.retryable) {
        const reconciled = await listPrReviews(options.prNumber, { cwd: options.cwd, client });
        const found = reconciled.reviews.find((review) => firstLine(review.body) === marker);
        if (found) return platformResult('applied', {
          changed: true, platform: context.platform, capabilities: context.capabilities,
          resource: { kind: 'pull-request', number: options.prNumber },
          operations: [{ name: 'review:publish', status: 'applied', reasonCode: 'CREATE_RECONCILED' }], error: null
        });
        return platformResult('blocked', {
          platform: context.platform, capabilities: context.capabilities,
          resource: { kind: 'pull-request', number: options.prNumber },
          operations: [{ name: 'review:publish', status: 'failed', reasonCode: 'REVIEW_CREATE_OUTCOME_UNKNOWN' }],
          error: { code: 'REVIEW_CREATE_OUTCOME_UNKNOWN', message: published.error.message, retryable: true }
        });
      }
      return platformResult(providerStatus(published.error), {
        platform: context.platform, capabilities: context.capabilities,
        resource: { kind: 'pull-request', number: options.prNumber },
        operations: [{ name: 'review:publish', status: 'failed', reasonCode: published.error.code }],
        error: providerError(published.error, 'PLATFORM_PROVIDER_OPERATION_FAILED')
      });
    }
    return platformResult('applied', {
      changed: published.value.changed,
      platform: context.platform, capabilities: context.capabilities,
      resource: { kind: 'pull-request', number: options.prNumber },
      operations: [{ name: 'review:publish', status: 'applied', reasonCode: null }], error: null
    });
  }

  const posted = client.json<RemoteReview>(['api', `repos/${repository}/pulls/${options.prNumber}/reviews`, '-X', 'POST', '--input', '-'], {
    cwd: options.cwd || process.cwd(),
    method: 'POST',
    input: JSON.stringify({ commit_id: options.identity.commitSha, body: wrappedBody, event: options.event })
  });
  if (!posted.ok) {
    if (posted.error.retryable) {
      const reconciled = await listPrReviews(options.prNumber, { cwd: options.cwd, client });
      const found = reconciled.reviews.find((review) => firstLine(review.body) === marker);
      if (found) {
        return platformResult('applied', {
          changed: true, platform: context.platform, capabilities: context.capabilities,
          resource: { kind: 'pull-request', number: options.prNumber },
          operations: [{ name: 'review:publish', status: 'applied', reasonCode: 'CREATE_RECONCILED' }], error: null
        });
      }
      return platformResult('blocked', {
        platform: context.platform, capabilities: context.capabilities,
        resource: { kind: 'pull-request', number: options.prNumber },
        operations: [{ name: 'review:publish', status: 'failed', reasonCode: 'REVIEW_CREATE_OUTCOME_UNKNOWN' }],
        error: { code: 'REVIEW_CREATE_OUTCOME_UNKNOWN', message: posted.error.message, retryable: true }
      });
    }
    return platformResult('failed', {
      platform: context.platform, capabilities: context.capabilities,
      resource: { kind: 'pull-request', number: options.prNumber },
      operations: [{ name: 'review:publish', status: 'failed', reasonCode: posted.error.code }], error: posted.error
    });
  }
  return platformResult('applied', {
    changed: true, platform: context.platform, capabilities: context.capabilities,
    resource: { kind: 'pull-request', number: options.prNumber },
    operations: [{ name: 'review:publish', status: 'applied', reasonCode: null }], error: null
  });
}
