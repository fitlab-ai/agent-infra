import { resolvePlatformProviderContext } from './context.ts';
import type { PlatformClient } from './context.ts';
import { platformResult } from './types.ts';
import type { PlatformOperation, PlatformResult } from './types.ts';
import {
  providerError,
  providerOperationContext,
  providerStatus,
  providerResourceToken,
  unsupportedProviderOperation
} from './provider-bridge.ts';
import { isResourceIdentity, resourceIdentityNumber, reviewMarker as resourceReviewMarker } from './resource-identity.ts';
import type { ResourceIdentity } from './resource-identity.ts';

export type PrReviewEvent = 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES';
export type PrReviewIdentity = { scope: string; round: number; commitSha: string; resource?: ResourceIdentity };
export type PrReviewListEntry = { id: number | string; commitId: string; body: string; url: string };
export type PrReviewListResult = PlatformResult & { reviews: PrReviewListEntry[] };

const REVIEW_EVENTS: readonly PrReviewEvent[] = ['COMMENT', 'APPROVE', 'REQUEST_CHANGES'];
// Marker-safe scope: a task id (`TASK-YYYYMMDD-HHMMSS`) or a bare PR number
// (`pr{N}`). Any other value (e.g. one containing `\r\n` or `-->`) would break
// the first-line marker idempotency contract of `reviewMarker` (PL-6).
const REVIEW_SCOPE_PATTERN = /^(?:pr\d+|TASK-\d{8}-\d{6})$/;

export function reviewMarker(identity: PrReviewIdentity): string {
  const scope = identity.resource && isResourceIdentity(identity.resource) && identity.resource.kind !== 'number'
    ? resourceReviewMarker(identity.resource)
    : identity.scope;
  return `<!-- review-pr:${scope}:r${identity.round} -->`;
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

type PrToken = string | number;

export async function listPrReviews(prNumber: PrToken, options: { cwd?: string; client?: PlatformClient } = {}): Promise<PrReviewListResult> {
  const loaded = await resolvePlatformProviderContext({ cwd: options.cwd || process.cwd(), client: options.client });
  const context = loaded.ok ? loaded.value.context : loaded.context;
  if (!hasUsableContext(context)) {
    return { ...platformResult(context.status, { platform: context.platform, capabilities: context.capabilities, error: context.error }), reviews: [] };
  }
  const identity = loaded.ok ? (() => { try { return providerResourceToken(loaded.value.provider, 'pull-request', String(prNumber)); } catch { return null; } })() : null;
  if (!identity) {
    return {
      ...platformResult('failed', {
        platform: context.platform, capabilities: context.capabilities,
        error: { code: 'PLATFORM_IDENTITY_TOKEN_INVALID', message: 'Pull request token is invalid', retryable: false }
      }),
      reviews: []
    };
  }
  const identityNumber = resourceIdentityNumber(identity);
  if (loaded.ok) {
    const fetched = loaded.value.provider.reviews?.list
      ? await loaded.value.provider.reviews.list({ context: providerOperationContext(loaded.value), changeRequest: identity })
      : unsupportedProviderOperation(loaded.value.provider, 'reviews.list');
    if (!fetched.ok) return {
      ...platformResult(providerStatus(fetched.error), {
        platform: context.platform, capabilities: context.capabilities,
        resource: { kind: 'pull-request', number: identityNumber, identity }, error: providerError(fetched.error, 'PLATFORM_PROVIDER_OPERATION_FAILED')
      }), reviews: []
    };
    return {
      ...platformResult('no-op', {
        platform: context.platform, capabilities: context.capabilities,
        resource: { kind: 'pull-request', number: identityNumber, identity }, error: null
      }),
      reviews: fetched.value.map((review) => ({ id: review.id, commitId: review.commitSha || '', body: review.body, url: review.displayUrl || '' }))
    };
  }
  return { ...platformResult('failed', { platform: context.platform, capabilities: context.capabilities, error: context.error }), reviews: [] };
}

export async function publishPrReview(options: {
  cwd?: string;
  client?: PlatformClient;
  dryRun?: boolean;
  prNumber: PrToken;
  identity: PrReviewIdentity;
  event: PrReviewEvent;
  body: string;
}): Promise<PlatformResult> {
  const loaded = await resolvePlatformProviderContext({ cwd: options.cwd || process.cwd(), client: options.client });
  const context = loaded.ok ? loaded.value.context : loaded.context;
  if (!hasUsableContext(context)) {
    return platformResult(context.status, { platform: context.platform, capabilities: context.capabilities, error: context.error });
  }
  const identity = loaded.ok ? (() => { try { return providerResourceToken(loaded.value.provider, 'pull-request', String(options.prNumber)); } catch { return null; } })() : null;
  if (!identity) {
    return platformResult('failed', {
      platform: context.platform, capabilities: context.capabilities,
      error: { code: 'PLATFORM_IDENTITY_TOKEN_INVALID', message: 'Pull request token is invalid', retryable: false }
    });
  }
  const identityNumber = resourceIdentityNumber(identity);
  if (!REVIEW_EVENTS.includes(options.event)) {
    return platformResult('failed', {
      platform: context.platform, capabilities: context.capabilities,
      resource: { kind: 'pull-request', number: identityNumber, identity },
      error: { code: 'REVIEW_EVENT_INVALID', message: `review event must be one of ${REVIEW_EVENTS.join('|')}`, retryable: false }
    });
  }
  if (!REVIEW_SCOPE_PATTERN.test(options.identity.scope) || !/^[0-9a-f]{7,40}$/i.test(options.identity.commitSha)) {
    return platformResult('failed', {
      platform: context.platform, capabilities: context.capabilities,
      resource: { kind: 'pull-request', number: identityNumber, identity },
      error: { code: 'REVIEW_IDENTITY_INVALID', message: 'review scope must be a task id or pr{N}; commitSha is required', retryable: false }
    });
  }

  const marker = reviewMarker({ ...options.identity, resource: identity });
  const listed = await listPrReviews(options.prNumber, { cwd: options.cwd, client: options.client });
  if (listed.status === 'failed' || listed.status === 'blocked') return listed;
  const existing = listed.reviews.find((review) => firstLine(review.body) === marker) ?? null;
  if (existing) {
    if (existing.commitId === options.identity.commitSha) {
      return platformResult('no-op', {
        platform: context.platform, capabilities: context.capabilities,
        resource: { kind: 'pull-request', number: identityNumber, identity },
        operations: [{ name: 'review:publish', status: 'no-op', reasonCode: null }], error: null
      });
    }
    return platformResult('failed', {
      platform: context.platform, capabilities: context.capabilities,
      resource: { kind: 'pull-request', number: identityNumber, identity },
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
      resource: { kind: 'pull-request', number: identityNumber, identity },
      operations: [{ name: 'review:publish', status: 'planned', reasonCode: null }], error: null
    });
  }

  if (loaded.ok) {
    const published = loaded.value.provider.reviews?.publish
      ? await loaded.value.provider.reviews.publish({
        context: providerOperationContext(loaded.value),
        changeRequest: identity,
        identity: options.identity,
        event: options.event,
        body: wrappedBody,
        mutation: { idempotencyKey: `review:publish:${marker}` }
      })
      : unsupportedProviderOperation(loaded.value.provider, 'reviews.publish');
    if (!published.ok) {
      if (published.error.retryable) {
        const reconciled = await listPrReviews(options.prNumber, { cwd: options.cwd, client: options.client });
        const found = reconciled.reviews.find((review) => firstLine(review.body) === marker);
        if (found) return platformResult('applied', {
          changed: true, platform: context.platform, capabilities: context.capabilities,
          resource: { kind: 'pull-request', number: identityNumber, identity },
          operations: [{ name: 'review:publish', status: 'applied', reasonCode: 'CREATE_RECONCILED' }], error: null
        });
        return platformResult('blocked', {
          platform: context.platform, capabilities: context.capabilities,
          resource: { kind: 'pull-request', number: identityNumber, identity },
          operations: [{ name: 'review:publish', status: 'failed', reasonCode: 'REVIEW_CREATE_OUTCOME_UNKNOWN' }],
          error: { code: 'REVIEW_CREATE_OUTCOME_UNKNOWN', message: published.error.message, retryable: true }
        });
      }
      return platformResult(providerStatus(published.error), {
        platform: context.platform, capabilities: context.capabilities,
        resource: { kind: 'pull-request', number: identityNumber, identity },
        operations: [{ name: 'review:publish', status: 'failed', reasonCode: published.error.code }],
        error: providerError(published.error, 'PLATFORM_PROVIDER_OPERATION_FAILED')
      });
    }
    return platformResult('applied', {
      changed: published.value.changed,
      platform: context.platform, capabilities: context.capabilities,
      resource: { kind: 'pull-request', number: identityNumber, identity },
      operations: [{ name: 'review:publish', status: 'applied', reasonCode: null }], error: null
    });
  }
  return platformResult('failed', { platform: context.platform, capabilities: context.capabilities, error: context.error });
}
