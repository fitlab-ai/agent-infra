import fs from 'node:fs';

import { parseTaskFrontmatter } from '../task/frontmatter.ts';
import { resolveTaskRef } from '../task/resolve-ref.ts';
import { resolvePlatformContext } from './context.ts';
import { createGitHubClient } from './github-client.ts';
import type { GitHubClient } from './github-client.ts';
import { inspectPlatformPullRequest } from './pull-requests.ts';
import { platformResult } from './types.ts';
import type { PlatformResult } from './types.ts';
import type { PullRequestSnapshot } from './pull-requests.ts';

type CheckBucket = 'pass' | 'fail' | 'pending' | 'cancel';
type CheckState = 'passed' | 'failed' | 'pending' | 'timed-out' | 'cancelled' | 'no-required';
type CheckSnapshot = {
  name: string;
  bucket: CheckBucket;
  workflow?: string | null;
  conclusion?: string | null;
  detailsUrl?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
};
type ChecksSnapshot = { state: Exclude<CheckState, 'timed-out'>; required: CheckSnapshot[] };
type RunCandidate = { id: number; name: string; headSha: string; jobId?: number | null };
type ChecksResult = PlatformResult & {
  pullRequest: PullRequestSnapshot | null;
  checks: { state: CheckState; required: CheckSnapshot[] };
  resolution?: { status: 'resolved' | 'missing' | 'ambiguous'; runId: number | null; jobId: number | null };
  logs?: { runId: number; jobId?: number; text: string };
};
type SharedOptions = { cwd?: string; client?: GitHubClient };

function classifyRequiredChecks(required: CheckSnapshot[]): ChecksSnapshot {
  if (required.length === 0) return { state: 'no-required', required };
  if (required.some((check) => check.bucket === 'fail')) return { state: 'failed', required };
  if (required.some((check) => check.bucket === 'cancel')) return { state: 'cancelled', required };
  if (required.some((check) => check.bucket === 'pending')) return { state: 'pending', required };
  return { state: 'passed', required };
}

async function watchRequiredChecks(options: {
  inspect: () => Promise<ChecksSnapshot>;
  intervalMs: number;
  deadlineMs: number;
  now?: () => number;
  sleep?: (delayMs: number) => Promise<void>;
  signal?: AbortSignal;
}): Promise<{ state: CheckState; required: CheckSnapshot[] }> {
  const now = options.now || (() => performance.now());
  const sleep = options.sleep || ((delay) => new Promise<void>((resolve) => setTimeout(resolve, delay)));
  const started = now();
  while (true) {
    if (options.signal?.aborted) return { state: 'cancelled', required: [] };
    const snapshot = await options.inspect();
    if (snapshot.state !== 'pending') return snapshot;
    const elapsed = now() - started;
    if (elapsed >= options.deadlineMs) return { state: 'timed-out', required: snapshot.required };
    await sleep(Math.min(options.intervalMs, options.deadlineMs - elapsed));
  }
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

function normalizeBucket(value: { bucket?: string; state?: string; conclusion?: string }): CheckBucket {
  const raw = String(value.bucket || value.conclusion || value.state || '').toLowerCase();
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

function resolvedTask(taskRef: string, options: SharedOptions) {
  const resolved = resolveTaskRef(taskRef, options.cwd ? { repoRoot: options.cwd } : {});
  if (!resolved.ok) return { ok: false as const, output: checksResult('failed', { error: { code: resolved.code, message: resolved.message, retryable: false } }) };
  const frontmatter = parseTaskFrontmatter(fs.readFileSync(resolved.taskMdPath, 'utf8'));
  const pr = Number(frontmatter.pr_number);
  const prNumber = Number.isInteger(pr) && pr > 0 ? pr : null;
  if (!prNumber) return { ok: false as const, output: checksResult('failed', { error: { code: 'PR_NOT_LINKED', message: 'Task has no valid pr_number', retryable: false } }) };
  const client = options.client || createGitHubClient();
  const context = resolvePlatformContext({ cwd: resolved.repoRoot, client });
  if (!context.platform.repository || !['no-op', 'degraded'].includes(context.status)) return { ok: false as const, output: checksResult(context.status, { platform: context.platform, capabilities: context.capabilities, error: context.error }) };
  const inspected = inspectPlatformPullRequest(taskRef, { cwd: resolved.repoRoot, client });
  if (!inspected.pullRequest) return { ok: false as const, output: checksResult(inspected.status, { platform: context.platform, capabilities: context.capabilities, error: inspected.error }) };
  return { ok: true as const, resolved, prNumber, client, context, pullRequest: inspected.pullRequest };
}

function inspectRequiredChecks(taskRef: string, options: SharedOptions = {}): ChecksResult {
  const base = resolvedTask(taskRef, options);
  if (!base.ok) return base.output;
  const repository = base.context.platform.repository!;
  const inspected = base.client.json<unknown>([
    'pr', 'checks', String(base.prNumber), '--repo', repository, '--required',
    '--json', 'name,state,bucket,link,workflow,startedAt,completedAt'
  ], { cwd: base.resolved.repoRoot });
  if (!inspected.ok) {
    return checksResult(inspected.error.retryable ? 'blocked' : 'failed', {
      platform: base.context.platform, capabilities: base.context.capabilities,
      resource: { kind: 'pull-request', number: base.prNumber },
      pullRequest: base.pullRequest, error: inspected.error
    });
  }
  const classified = classifyRequiredChecks(normalizeChecks(inspected.value));
  const status = classified.state === 'passed' || classified.state === 'no-required'
    ? 'no-op'
    : classified.state === 'failed' || classified.state === 'cancelled' ? 'failed' : 'blocked';
  return checksResult(status, {
    platform: base.context.platform, capabilities: base.context.capabilities,
    resource: { kind: 'pull-request', number: base.prNumber },
    pullRequest: base.pullRequest, checks: classified,
    error: status === 'no-op' ? null : {
      code: classified.state === 'pending' ? 'REQUIRED_CHECKS_PENDING' : `REQUIRED_CHECKS_${classified.state.toUpperCase()}`,
      message: `Required checks are ${classified.state}`,
      retryable: classified.state === 'pending'
    }
  });
}

async function watchPlatformChecks(taskRef: string, options: SharedOptions & {
  intervalSeconds: number;
  deadlineSeconds: number;
  signal?: AbortSignal;
  now?: () => number;
  sleep?: (delayMs: number) => Promise<void>;
}): Promise<ChecksResult> {
  let last: ChecksResult | null = null;
  const watched = await watchRequiredChecks({
    intervalMs: options.intervalSeconds * 1000,
    deadlineMs: options.deadlineSeconds * 1000,
    signal: options.signal,
    now: options.now,
    sleep: options.sleep,
    inspect: async () => {
      last = inspectRequiredChecks(taskRef, options);
      if (last.checks.state === 'pending' && last.error?.code === 'REQUIRED_CHECKS_PENDING') return last.checks as ChecksSnapshot;
      return last.checks as ChecksSnapshot;
    }
  });
  if (!last) return checksResult('blocked', { checks: watched, error: { code: 'REQUIRED_CHECKS_UNAVAILABLE', message: 'No checks snapshot was produced', retryable: true } });
  const snapshot = last as ChecksResult;
  if (watched.state === 'timed-out' || watched.state === 'cancelled') return checksResult('blocked', {
    ...snapshot,
    status: 'blocked',
    changed: false,
    checks: watched,
    error: { code: watched.state === 'timed-out' ? 'REQUIRED_CHECKS_TIMEOUT' : 'REQUIRED_CHECKS_CANCELLED', message: `Required checks ${watched.state}`, retryable: watched.state === 'timed-out' }
  });
  return { ...snapshot, checks: watched };
}

function resolvePlatformCheckRun(taskRef: string, options: SharedOptions & { checkName: string; detailsUrl?: string }): ChecksResult {
  const base = resolvedTask(taskRef, options);
  if (!base.ok) return base.output;
  const direct = options.detailsUrl ? parseRunJobIdentity(options.detailsUrl) : null;
  if (direct) {
    const run = base.client.json<{ id?: number; head_sha?: string }>(['api', `repos/${base.context.platform.repository}/actions/runs/${direct.runId}`], { cwd: base.resolved.repoRoot });
    if (!run.ok) return checksResult(run.error.retryable ? 'blocked' : 'failed', { platform: base.context.platform, capabilities: base.context.capabilities, pullRequest: base.pullRequest, error: run.error });
    if (run.value.head_sha !== base.pullRequest.head.sha) return checksResult('failed', { error: { code: 'CHECK_RUN_HEAD_MISMATCH', message: 'Resolved run does not belong to the PR head SHA', retryable: false } });
    return checksResult('no-op', { platform: base.context.platform, capabilities: base.context.capabilities, resource: { kind: 'pull-request', number: base.prNumber }, pullRequest: base.pullRequest, resolution: { status: 'resolved', ...direct }, error: null });
  }
  const listed = base.client.json<{ check_runs?: Array<{ name?: string; details_url?: string }> }>(['api', `repos/${base.context.platform.repository}/commits/${base.pullRequest.head.sha}/check-runs`], { cwd: base.resolved.repoRoot });
  if (!listed.ok) return checksResult(listed.error.retryable ? 'blocked' : 'failed', { error: listed.error });
  const candidates = (listed.value.check_runs || []).flatMap((check) => {
    if (check.name !== options.checkName || !check.details_url) return [];
    const identity = parseRunJobIdentity(check.details_url);
    return identity ? [{ id: identity.runId, jobId: identity.jobId, name: check.name, headSha: base.pullRequest.head.sha }] : [];
  });
  const resolution = resolveRunCandidate(candidates, base.pullRequest.head.sha, options.checkName);
  return checksResult(resolution.status === 'resolved' ? 'no-op' : 'failed', {
    platform: base.context.platform, capabilities: base.context.capabilities,
    resource: { kind: 'pull-request', number: base.prNumber }, pullRequest: base.pullRequest,
    resolution,
    error: resolution.status === 'resolved' ? null : { code: resolution.status === 'ambiguous' ? 'CHECK_RUN_AMBIGUOUS' : 'CHECK_RUN_NOT_FOUND', message: `Check run is ${resolution.status}`, retryable: false }
  });
}

function fetchPlatformCheckLogs(taskRef: string, options: SharedOptions & { run: number; job?: number }): ChecksResult {
  const base = resolvedTask(taskRef, options);
  if (!base.ok) return base.output;
  const args = options.job
    ? ['api', `repos/${base.context.platform.repository}/actions/jobs/${options.job}/logs`]
    : ['run', 'view', String(options.run), '--repo', base.context.platform.repository!, '--log-failed'];
  const fetched = base.client.text(args, { cwd: base.resolved.repoRoot });
  if (!fetched.ok) return checksResult(fetched.error.retryable ? 'blocked' : 'failed', { platform: base.context.platform, capabilities: base.context.capabilities, error: fetched.error });
  if (!fetched.value) return checksResult('failed', { error: { code: 'CHECK_LOGS_MISSING', message: 'No failed logs are available', retryable: false } });
  return checksResult('no-op', {
    platform: base.context.platform, capabilities: base.context.capabilities,
    resource: { kind: 'pull-request', number: base.prNumber }, pullRequest: base.pullRequest,
    logs: { runId: options.run, ...(options.job ? { jobId: options.job } : {}), text: fetched.value }, error: null
  });
}

export {
  classifyRequiredChecks,
  fetchPlatformCheckLogs,
  inspectRequiredChecks,
  parseRunJobIdentity,
  resolvePlatformCheckRun,
  resolveRunCandidate,
  watchPlatformChecks,
  watchRequiredChecks
};
export type { CheckBucket, CheckSnapshot, ChecksResult, ChecksSnapshot, CheckState, RunCandidate };
