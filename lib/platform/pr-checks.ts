import fs from 'node:fs';

import { parseTypedTaskFrontmatter } from '../task/frontmatter.ts';
import { resolveTaskRef } from '../task/resolve-ref.ts';
import type { PlatformCheckSnapshot } from './adapters.ts';
import { resolvePlatformProviderContext } from './context.ts';
import type { PlatformClient } from './context.ts';
import { inspectPlatformPullRequest } from './pull-requests.ts';
import { platformResult } from './types.ts';
import type { PlatformResult } from './types.ts';
import type { PullRequestSnapshot } from './pull-requests.ts';
import { readPrDeliveryFact } from '../task/pr-delivery-fact.ts';
import {
  providerError,
  providerOperationContext,
  providerStatus,
  resourceIdentity,
  resourceIdentityNumber,
  unsupportedProviderOperation
} from './provider-bridge.ts';

type CheckBucket = 'pass' | 'fail' | 'pending' | 'cancel';
type CheckState = 'passed' | 'failed' | 'pending' | 'timed-out' | 'cancelled' | 'no-required';
type CheckSnapshot = PlatformCheckSnapshot;
type ChecksSnapshot = { state: Exclude<CheckState, 'timed-out'>; required: CheckSnapshot[] };
type ReadinessState = 'ready' | 'conflicting' | 'checks-failed' | 'pending' | 'timed-out' | 'cancelled';
type ReadinessSnapshot = { state: ReadinessState; headSha: string };
type RunCandidate = { id: number; name: string; headSha: string; jobId?: number | null };
type ChecksResult = PlatformResult & {
  pullRequest: PullRequestSnapshot | null;
  checks: { state: CheckState; required: CheckSnapshot[] };
  readiness?: ReadinessSnapshot;
  resolution?: { status: 'resolved' | 'missing' | 'ambiguous'; runId: number | null; jobId: number | null };
  logs?: { runId: number; jobId?: number; text: string };
};
type GitHubClient = PlatformClient;
type InspectionOptions = { cwd?: string; client?: PlatformClient; runtimeVersion?: string };
type SharedOptions = { cwd?: string; client?: PlatformClient };

function classifyRequiredChecks(required: CheckSnapshot[]): ChecksSnapshot {
  if (required.length === 0) return { state: 'no-required', required };
  if (required.some((check) => check.bucket === 'fail')) return { state: 'failed', required };
  if (required.some((check) => check.bucket === 'cancel')) return { state: 'cancelled', required };
  if (required.some((check) => check.bucket === 'pending')) return { state: 'pending', required };
  return { state: 'passed', required };
}

function classifyPullRequestReadiness(input: {
  headSha: string;
  mergeability: 'mergeable' | 'conflicting' | 'unknown';
  checks: ChecksSnapshot;
}): ReadinessSnapshot {
  if (input.mergeability === 'conflicting') return { state: 'conflicting', headSha: input.headSha };
  if (input.checks.state === 'failed' || input.checks.state === 'cancelled') return { state: 'checks-failed', headSha: input.headSha };
  if (input.mergeability === 'unknown' || input.checks.state === 'pending') return { state: 'pending', headSha: input.headSha };
  return { state: 'ready', headSha: input.headSha };
}

function parseRunJobIdentity(detailsUrl: string): { runId: number; jobId: number | null } | null {
  try {
    const url = new URL(detailsUrl);
    if (url.hostname !== 'github.com') return null;
    const match = url.pathname.match(/\/actions\/runs\/(\d+)(?:\/job\/(\d+))?/);
    if (!match) return null;
    return { runId: Number(match[1]), jobId: match[2] ? Number(match[2]) : null };
  } catch {
    return null;
  }
}

function resolveRunCandidate(candidates: RunCandidate[], headSha: string, checkName: string):
  | { status: 'resolved'; runId: number; jobId: number | null }
  | { status: 'missing' | 'ambiguous'; runId: null; jobId: null } {
  const matches = candidates.filter((candidate) => candidate.headSha === headSha && candidate.name === checkName);
  if (matches.length === 1) return { status: 'resolved', runId: matches[0]!.id, jobId: matches[0]!.jobId || null };
  return { status: matches.length === 0 ? 'missing' : 'ambiguous', runId: null, jobId: null };
}

function checksResult(status: PlatformResult['status'], overrides: Partial<ChecksResult> = {}): ChecksResult {
  return {
    ...platformResult(status),
    pullRequest: null,
    checks: { state: 'pending', required: [] },
    ...overrides
  };
}

function normalizeBucket(value: { bucket?: string; status?: string; state?: string; conclusion?: string }): CheckBucket {
  const raw = String(value.bucket || value.status || value.conclusion || value.state || '').toLowerCase();
  if (['pass', 'success', 'successful', 'neutral'].includes(raw)) return 'pass';
  if (['fail', 'failure', 'failed', 'error', 'timed_out', 'action_required'].includes(raw)) return 'fail';
  if (['cancel', 'cancelled', 'canceled', 'skipped', 'stale'].includes(raw)) return 'cancel';
  return 'pending';
}

function normalizeChecks(value: unknown): CheckSnapshot[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw) => {
    const item = raw as Record<string, unknown>;
    const name = String(item.name || item.context || '');
    return name ? [{
      name,
      bucket: normalizeBucket(item as { bucket?: string; state?: string; conclusion?: string }),
      workflow: item.workflow ? String(item.workflow) : null,
      conclusion: item.conclusion ? String(item.conclusion) : item.state ? String(item.state) : null,
      detailsUrl: item.link ? String(item.link) : item.detailsUrl ? String(item.detailsUrl) : null,
      startedAt: item.startedAt ? String(item.startedAt) : null,
      completedAt: item.completedAt ? String(item.completedAt) : null
    }] : [];
  });
}

function inspectGitHubRequiredChecks(client: GitHubClient, repository: string, number: number, cwd: string) {
  const inspected = client.json<unknown>([
    'pr', 'checks', String(number), '--repo', repository,
    '--json', 'name,state,bucket,link,workflow,startedAt,completedAt'
  ], { cwd });
  return inspected.ok
    ? { ok: true as const, value: normalizeChecks(inspected.value) }
    : { ok: false as const, error: inspected.error };
}

async function resolvedTask(taskRef: string, options: InspectionOptions) {
  const resolved = resolveTaskRef(taskRef, options.cwd ? { repoRoot: options.cwd } : {});
  if (!resolved.ok) return { ok: false as const, output: checksResult('failed', { error: { code: resolved.code, message: resolved.message, retryable: false } }) };
  const frontmatter = parseTypedTaskFrontmatter(fs.readFileSync(resolved.taskMdPath, 'utf8'));
  const fact = readPrDeliveryFact(frontmatter, options.runtimeVersion);
  if (fact.status === 'invalid') return { ok: false as const, output: checksResult('failed', { error: { code: fact.error.code, message: fact.error.message, retryable: false } }) };
  const prIdentity = fact.status === 'valid' && fact.fact.state === 'bound' ? fact.fact.identity.resource : null;
  const prNumber = resourceIdentityNumber(prIdentity);
  if (!prIdentity) return { ok: false as const, output: checksResult('failed', { error: { code: fact.status === 'missing' ? 'PR_DELIVERY_FACT_MISSING' : 'PR_NOT_LINKED', message: 'Task has no verified bound pull request', retryable: false } }) };
  const loaded = await resolvePlatformProviderContext({ cwd: resolved.repoRoot, client: options.client });
  const context = loaded.ok ? loaded.value.context : loaded.context;
  if (!context.platform.repository || !['no-op', 'degraded'].includes(context.status)) return { ok: false as const, output: checksResult(context.status, { platform: context.platform, capabilities: context.capabilities, error: context.error }) };
  const inspected = await inspectPlatformPullRequest(taskRef, { cwd: resolved.repoRoot, client: options.client });
  if (!inspected.pullRequest) return { ok: false as const, output: checksResult(inspected.status, { platform: context.platform, capabilities: context.capabilities, error: inspected.error }) };
  if (!loaded.ok) return { ok: false as const, output: checksResult('failed', { platform: context.platform, capabilities: context.capabilities, error: context.error }) };
  return { ok: true as const, resolved, prNumber, prIdentity, client: options.client, context, pullRequest: inspected.pullRequest, provider: loaded.value.provider, loadedContext: loaded.value };
}

async function inspectRequiredChecks(taskRef: string, options: InspectionOptions = {}): Promise<ChecksResult> {
  const base = await resolvedTask(taskRef, options);
  if (!base.ok) return base.output;
  return inspectChecksForResolvedTask(base, options);
}

async function inspectChecksForResolvedTask(
  base: Extract<Awaited<ReturnType<typeof resolvedTask>>, { ok: true }>,
  options: InspectionOptions
): Promise<ChecksResult> {
  const repository = base.context.platform.repository!;
  {
    const inspected = base.provider.checks?.inspectRequired
      ? await base.provider.checks.inspectRequired({
        context: providerOperationContext(base.loadedContext),
        changeRequest: base.prIdentity,
        headSha: base.pullRequest.head.sha
      })
      : unsupportedProviderOperation(base.provider, 'checks.inspectRequired');
    if (!inspected.ok) return checksResult(providerStatus(inspected.error), {
      platform: base.context.platform,
      capabilities: base.context.capabilities,
      resource: { kind: 'pull-request', number: base.prNumber },
      pullRequest: base.pullRequest,
      error: providerError(inspected.error, 'PLATFORM_PROVIDER_OPERATION_FAILED')
    });
    const required = normalizeChecks(inspected.value);
    const classified = classifyRequiredChecks(required);
    const status = classified.state === 'passed' || classified.state === 'no-required'
      ? 'no-op'
      : classified.state === 'failed' || classified.state === 'cancelled' ? 'failed' : 'blocked';
    return checksResult(status, {
      platform: base.context.platform, capabilities: base.context.capabilities,
      resource: { kind: 'pull-request', number: base.prNumber }, pullRequest: base.pullRequest,
      checks: classified,
      error: status === 'no-op' ? null : {
        code: classified.state === 'pending' ? 'REQUIRED_CHECKS_PENDING' : `REQUIRED_CHECKS_${classified.state.toUpperCase()}`,
        message: `Required checks are ${classified.state}`, retryable: classified.state === 'pending'
      }
    });
  }
}

async function inspectPullRequestReadiness(taskRef: string, options: InspectionOptions = {}): Promise<ChecksResult> {
  const base = await resolvedTask(taskRef, options);
  if (!base.ok) return base.output;
  const checked = await inspectChecksForResolvedTask(base, options);
  const classifiedCodes = new Set(['REQUIRED_CHECKS_PENDING', 'REQUIRED_CHECKS_FAILED', 'REQUIRED_CHECKS_CANCELLED']);
  if (checked.error && !classifiedCodes.has(checked.error.code)) return checked;
  const readiness = classifyPullRequestReadiness({
    headSha: base.pullRequest.head.sha,
    mergeability: base.pullRequest.mergeability?.state ?? 'unknown',
    checks: checked.checks as ChecksSnapshot
  });
  const status = readiness.state === 'ready' ? 'no-op'
    : readiness.state === 'conflicting' || readiness.state === 'checks-failed' ? 'failed' : 'blocked';
  return checksResult(status, {
    ...checked,
    status,
    changed: false,
    readiness,
    error: status === 'no-op' ? null : {
      code: readiness.state === 'conflicting' ? 'PR_MERGE_CONFLICT'
        : readiness.state === 'checks-failed' ? 'REQUIRED_CHECKS_FAILED' : 'PR_READINESS_PENDING',
      message: `Pull request readiness is ${readiness.state}`,
      retryable: readiness.state === 'pending'
    }
  });
}

async function watchPullRequestReadiness(taskRef: string, options: InspectionOptions & {
  intervalSeconds: number;
  deadlineSeconds: number;
  signal?: AbortSignal;
  now?: () => number;
  sleep?: (delayMs: number) => Promise<void>;
}): Promise<ChecksResult> {
  const now = options.now || (() => performance.now());
  const sleep = options.sleep || ((delay: number) => new Promise<void>((resolve) => setTimeout(resolve, delay)));
  const started = now();
  let last: ChecksResult | null = null;
  while (true) {
    if (options.signal?.aborted) return checksResult('blocked', {
      ...last,
      status: 'blocked', changed: false,
      readiness: { state: 'cancelled', headSha: last?.pullRequest?.head.sha ?? '' },
      error: { code: 'PR_READINESS_CANCELLED', message: 'Pull request readiness watch was cancelled', retryable: false }
    });
    last = await inspectPullRequestReadiness(taskRef, options);
    if (last.readiness?.state !== 'pending' || last.error?.code !== 'PR_READINESS_PENDING') return last;
    const elapsed = now() - started;
    if (elapsed >= options.deadlineSeconds * 1000) return checksResult('blocked', {
      ...last,
      status: 'blocked', changed: false,
      readiness: { state: 'timed-out', headSha: last.pullRequest?.head.sha ?? '' },
      error: { code: 'PR_READINESS_TIMEOUT', message: 'Pull request readiness watch timed out', retryable: true }
    });
    await sleep(Math.min(options.intervalSeconds * 1000, options.deadlineSeconds * 1000 - elapsed));
  }
}

async function resolvePlatformCheckRun(taskRef: string, options: SharedOptions & { checkName: string; detailsUrl?: string }): Promise<ChecksResult> {
  const base = await resolvedTask(taskRef, options);
  if (!base.ok) return base.output;
  {
    const resolved = base.provider.checks?.resolveRun
      ? await base.provider.checks.resolveRun({
        context: providerOperationContext(base.loadedContext),
        changeRequest: base.prIdentity,
        checkName: options.checkName,
        ...(options.detailsUrl ? { detailsUrl: options.detailsUrl } : {})
      })
      : unsupportedProviderOperation(base.provider, 'checks.resolveRun');
    if (!resolved.ok) return checksResult(providerStatus(resolved.error), {
      platform: base.context.platform, capabilities: base.context.capabilities,
      resource: { kind: 'pull-request', number: base.prNumber }, pullRequest: base.pullRequest,
      error: providerError(resolved.error, 'PLATFORM_PROVIDER_OPERATION_FAILED')
    });
    const runId = Number(resolved.value.runId);
    if (!Number.isSafeInteger(runId) || runId <= 0) return checksResult('failed', {
      platform: base.context.platform, capabilities: base.context.capabilities,
      resource: { kind: 'pull-request', number: base.prNumber }, pullRequest: base.pullRequest,
      error: { code: 'CHECK_RUN_IDENTITY_INVALID', message: 'Provider returned an invalid check run identity', retryable: false }
    });
    const jobId = resolved.value.jobId ? Number(resolved.value.jobId) : null;
    return checksResult('no-op', {
      platform: base.context.platform, capabilities: base.context.capabilities,
      resource: { kind: 'pull-request', number: base.prNumber }, pullRequest: base.pullRequest,
      resolution: { status: 'resolved', runId, jobId: jobId !== null && Number.isSafeInteger(jobId) && jobId > 0 ? jobId : null }, error: null
    });
  }
}

function fetchCheckLogText(client: GitHubClient, args: string[], cwd: string) {
  if (!client.text) return { ok: false as const, error: { code: 'PLATFORM_CLIENT_TEXT_UNAVAILABLE', message: 'Platform client does not support text responses', retryable: false } };
  const fetched = client.text(args, { cwd });
  if (fetched.ok || args[0] !== 'api' || !/response contains terminal escape sequences/i.test(fetched.error.message)) {
    return fetched;
  }
  return client.text([...args, '--allow-escape-sequences'], { cwd });
}

async function fetchPlatformCheckLogs(taskRef: string, options: SharedOptions & { run: number; job?: number }): Promise<ChecksResult> {
  const base = await resolvedTask(taskRef, options);
  if (!base.ok) return base.output;
  {
    const fetched = base.provider.checks?.fetchLogs
      ? await base.provider.checks.fetchLogs({
        context: providerOperationContext(base.loadedContext),
        runId: String(options.run),
        ...(options.job ? { jobId: String(options.job) } : {})
      })
      : unsupportedProviderOperation(base.provider, 'checks.fetchLogs');
    if (!fetched.ok) return checksResult(providerStatus(fetched.error), {
      platform: base.context.platform, capabilities: base.context.capabilities,
      resource: { kind: 'pull-request', number: base.prNumber }, pullRequest: base.pullRequest,
      error: providerError(fetched.error, 'PLATFORM_PROVIDER_OPERATION_FAILED')
    });
    if (!fetched.value.text) return checksResult('failed', {
      platform: base.context.platform, capabilities: base.context.capabilities,
      error: { code: 'CHECK_LOGS_MISSING', message: 'No failed logs are available', retryable: false }
    });
    return checksResult('no-op', {
      platform: base.context.platform, capabilities: base.context.capabilities,
      resource: { kind: 'pull-request', number: base.prNumber }, pullRequest: base.pullRequest,
      logs: { runId: options.run, ...(options.job ? { jobId: options.job } : {}), text: fetched.value.text }, error: null
    });
  }
}

export {
  classifyPullRequestReadiness,
  classifyRequiredChecks,
  fetchCheckLogText,
  fetchPlatformCheckLogs,
  inspectGitHubRequiredChecks,
  inspectRequiredChecks,
  inspectPullRequestReadiness,
  parseRunJobIdentity,
  resolvePlatformCheckRun,
  resolveRunCandidate,
  watchPullRequestReadiness
};
export type { CheckBucket, CheckSnapshot, ChecksResult, ChecksSnapshot, CheckState, ReadinessSnapshot, ReadinessState, RunCandidate };
