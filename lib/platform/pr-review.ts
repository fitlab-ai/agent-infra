import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { coordinatePlatformWrite } from './operation-coordinator.ts';
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
import { isResourceIdentity, resourceIdentityEquals, resourceIdentityNumber, reviewMarker as resourceReviewMarker } from './resource-identity.ts';
import type { ResourceIdentity } from './resource-identity.ts';
import type { PlatformPullRequestReviewIntent } from '../task/platform-operation-journal.ts';
import { resolveTaskRef } from '../task/resolve-ref.ts';

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

function canonicalReviewBody(body: string): string {
  return normalizeBody(body).replace(/\n$/u, '');
}

function reviewArtifactName(round: number, artifactFile: string): boolean {
  return path.basename(artifactFile) === artifactFile
    && (artifactFile === 'pr-review.md' && round === 1 || artifactFile === `pr-review-r${round}.md`);
}

export function readReviewBodyFile(taskRef: string, round: number, artifactFile: string, bodyDigest: string, cwd?: string): string {
  if (!/^TASK-\d{8}-\d{6}$/u.test(taskRef) || path.basename(artifactFile) !== artifactFile
    || !reviewArtifactName(round, artifactFile)) {
    throw Object.assign(new Error('Pull-request review artifact identity is invalid'), { code: 'PLATFORM_OPERATION_PAYLOAD_INVALID' });
  }
  const task = resolveTaskRef(taskRef, cwd ? { repoRoot: cwd } : {});
  if (!task.ok) throw Object.assign(new Error(task.message), { code: 'PLATFORM_OPERATION_PAYLOAD_INVALID' });
  const bodyFile = artifactFile.replace(/^pr-review/u, 'pr-review-body');
  const report = fs.readFileSync(path.join(task.taskDir, artifactFile), 'utf8');
  const bodyReferences = [...report.matchAll(/^\*\*(?:正文文件|Body file)\*\*(?:：|:)\s*`([^`]+)`[^\r\n]*$/gmu)]
    .map((match) => match[1]);
  if (bodyReferences.length !== 1 || bodyReferences[0] !== bodyFile) {
    throw Object.assign(new Error('Pull-request review artifact does not reference its canonical body file'), { code: 'PLATFORM_OPERATION_PAYLOAD_INVALID' });
  }
  const body = canonicalReviewBody(fs.readFileSync(path.join(task.taskDir, bodyFile), 'utf8'));
  if (!body || createHash('sha256').update(body).digest('hex') !== bodyDigest) {
    throw Object.assign(new Error('Canonical pull-request review body does not match its persisted digest'), { code: 'PLATFORM_OPERATION_PAYLOAD_INVALID' });
  }
  return body;
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
  agent?: string;
  skipQueue?: boolean;
  expectedResource?: ResourceIdentity;
  expectedProviderScopeId?: string;
  recoveryArtifact?: string;
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
  const providerScopeId = loaded.ok ? loaded.value.snapshot.scope.id : null;
  if (options.expectedProviderScopeId && providerScopeId !== options.expectedProviderScopeId) {
    return platformResult('failed', {
      platform: context.platform, capabilities: context.capabilities,
      error: { code: 'PLATFORM_OPERATION_IDENTITY_MISMATCH', message: 'Current provider scope differs from the persisted operation target', retryable: false }
    });
  }
  const identity = loaded.ok ? (() => { try { return providerResourceToken(loaded.value.provider, 'pull-request', String(options.prNumber)); } catch { return null; } })() : null;
  if (!identity) {
    return platformResult('failed', {
      platform: context.platform, capabilities: context.capabilities,
      error: { code: 'PLATFORM_IDENTITY_TOKEN_INVALID', message: 'Pull request token is invalid', retryable: false }
    });
  }
  const identityNumber = resourceIdentityNumber(identity);
  if (options.expectedResource && !resourceIdentityEquals(identity, options.expectedResource)) {
    return platformResult('failed', {
      platform: context.platform, capabilities: context.capabilities,
      resource: { kind: 'pull-request', number: identityNumber, identity },
      error: { code: 'PLATFORM_OPERATION_IDENTITY_MISMATCH', message: 'Current pull request identity differs from the persisted operation target', retryable: false }
    });
  }
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

  if (/^TASK-\d{8}-\d{6}$/u.test(options.identity.scope) && !options.skipQueue && !options.dryRun) {
    if (!options.agent) return platformResult('failed', {
      platform: context.platform, capabilities: context.capabilities,
      resource: { kind: 'pull-request', number: identityNumber, identity },
      error: { code: 'PR_REVIEW_AGENT_REQUIRED', message: 'task-scoped review publication requires an agent token', retryable: false }
    });
    if (!options.recoveryArtifact || !reviewArtifactName(options.identity.round, options.recoveryArtifact)) return platformResult('failed', {
      platform: context.platform, capabilities: context.capabilities,
      resource: { kind: 'pull-request', number: identityNumber, identity },
      error: { code: 'PR_REVIEW_ARTIFACT_REQUIRED', message: 'task-scoped review publication requires its canonical review artifact', retryable: false }
    });
    const body = canonicalReviewBody(options.body);
    const bodyDigest = createHash('sha256').update(body).digest('hex');
    try {
      if (readReviewBodyFile(options.identity.scope, options.identity.round, options.recoveryArtifact, bodyDigest, options.cwd) !== body) throw new Error('body mismatch');
    } catch {
      return platformResult('failed', {
        platform: context.platform, capabilities: context.capabilities,
        resource: { kind: 'pull-request', number: identityNumber, identity },
        error: { code: 'PR_REVIEW_ARTIFACT_MISMATCH', message: 'Review body must match the canonical review body file', retryable: false }
      });
    }
    const pullRequestReview: PlatformPullRequestReviewIntent = {
      prNumber: String(options.prNumber),
      resource: identity,
      providerScopeId: providerScopeId!,
      scope: options.identity.scope,
      round: options.identity.round,
      commitSha: options.identity.commitSha,
      event: options.event,
      artifactFile: options.recoveryArtifact,
      bodyDigest
    };
    return coordinatePlatformWrite({
      operation: {
        taskRef: options.identity.scope,
        cwd: options.cwd || process.cwd(),
        kind: 'pull-request-review',
        target: JSON.stringify(identity),
        expectedDigest: createHash('sha256').update(JSON.stringify(pullRequestReview)).digest('hex'),
        dependency: 'deferred',
        pullRequestReview
      },
      agent: options.agent,
      execute: () => publishPrReview({ ...options, expectedProviderScopeId: providerScopeId!, skipQueue: true }),
      block: (error) => platformResult('blocked', {
        platform: context.platform, capabilities: context.capabilities,
        resource: { kind: 'pull-request', number: identityNumber, identity }, error
      }),
      persistenceFailure: (error) => platformResult('failed', {
        platform: context.platform, capabilities: context.capabilities,
        resource: { kind: 'pull-request', number: identityNumber, identity }, error
      })
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
