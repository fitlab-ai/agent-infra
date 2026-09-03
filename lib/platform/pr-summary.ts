import fs from 'node:fs';
import path from 'node:path';

import { enumerateArtifacts } from '../task/artifacts.ts';
import { parseTypedTaskFrontmatter } from '../task/frontmatter.ts';
import { renderHumanOverrideAudit } from '../task/human-override.ts';
import { resolveTaskRef } from '../task/resolve-ref.ts';
import { TaskExecutionLockError, withTaskExecutionLock } from '../task/task-execution-lock.ts';
import { readPrDeliveryFact } from '../task/pr-delivery-fact.ts';
import type { PrDeliveryFact } from '../task/pr-delivery-fact.ts';
import { resolvePlatformProviderContext } from './context.ts';
import type { LoadedContext, PlatformClient } from './context.ts';
import { normalizeCommentContent } from './issue-comments.ts';
import { platformResult } from './types.ts';
import type { PlatformResult } from './types.ts';
import type { OperationWarning } from '../task/operation-outcome.ts';
import { providerError, providerOperationContext, providerStatus, providerResourceToken, resourceIdentityNumber, unsupportedProviderOperation } from './provider-bridge.ts';
import type { PlatformChangeRequestSnapshot } from './adapters.ts';
import type { ChangeRequestSnapshot } from './provider-contract.ts';
import {
  buildPrChangeReport,
  readPrChangeReport,
  replaceCanonicalReportPlaceholder,
  runMechanicalChangeReport,
  taskIntentDigest,
  validateMechanicalReport,
  validatePrecheckCandidate,
  writePrChangeReportAtomic
} from './pr-change-report.ts';
import type {
  MechanicalChangeReport,
  PrChangeReport
} from './pr-change-report.ts';

type SummaryComment = { id: number | string; body: string };
type ChangeReportState = 'ready' | 'missing' | 'stale' | 'invalid';
type SummaryContextResult = PlatformResult & {
  task: { id: string | null; prNumber: number | null };
  pullRequest: PlatformChangeRequestSnapshot | null;
  changeReport: { status: ChangeReportState; path: string; taskIntentSha256: string | null; reason?: string };
  artifacts: Array<{ family: string; name: string; path: string }>;
};
type PullRequestSummaryResult = PlatformResult & {
  result: 'pr_created_with_warnings' | 'pr_reused_with_warnings' | 'no_op_with_warnings' | null;
  warnings: readonly OperationWarning[];
  precheckVerdict?: 'clear' | 'needs-review';
  nextAction?: 'watch-pr' | 'review-code';
};
type PullRequestPrimaryResult = 'pr_created' | 'pr_reused' | 'no_op';
type SummaryOptions = { cwd?: string; client?: PlatformClient; runtimeVersion?: string };
type ReportWriteResult = PlatformResult & {
  report: { path: string; status: 'written' | 'no-op' | 'planned'; precheckVerdict: 'clear' | 'needs-review'; nextAction: 'watch-pr' | 'review-code' } | null;
};

function summaryMarker(taskId: string): string {
  return `<!-- sync-pr:${taskId}:summary -->`;
}

function escapeSummaryAuditText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\r\n?/g, '\n');
}

function renderSummaryAuditLine(value: string): string {
  const safe = escapeSummaryAuditText(value);
  const longestRun = Math.max(0, ...(safe.match(/`+/g) || []).map((run) => run.length));
  const delimiter = '`'.repeat(longestRun + 1);
  return `${delimiter} ${safe} ${delimiter}`;
}

function renderSafeHumanOverrideAudit(value: string): string {
  const normalized = value.trim().replace(/\r\n?/g, '\n');
  if (!normalized) return '';
  const [heading, ...rows] = normalized.split('\n');
  const safeHeading = heading === '## Human Override Audit' ? heading : renderSummaryAuditLine(heading || '');
  return [safeHeading, ...rows.map((row) => row ? renderSummaryAuditLine(row) : '')].join('\n');
}

function isSafeSummaryEnvelope(value: string, taskId: string): boolean {
  return value.includes(summaryMarker(taskId))
    && (value.match(/<!--\s*sync-pr:/gi) || []).length === 1
    && (value.match(/<!--\s*last-commit:/gi) || []).length === 1
    && !/<!--\s*canonical-pr-change-report\b/i.test(value);
}

function taskReportPath(taskDir: string): string {
  return path.join(taskDir, 'pr-change-report.json');
}

function readBoundTaskSnapshot(taskMdPath: string): { taskContent: string; boundFact: Extract<PrDeliveryFact, { state: 'bound' }> | null } {
  const taskContent = fs.readFileSync(taskMdPath, 'utf8');
  const frontmatter = parseTypedTaskFrontmatter(taskContent);
  const fact = readPrDeliveryFact(frontmatter);
  const boundFact = fact.status === 'valid' && fact.fact.state === 'bound' ? fact.fact : null;
  return { taskContent, boundFact };
}

function boundPrNumberForWarning(taskMdPath: string): number | null {
  try {
    const { boundFact } = readBoundTaskSnapshot(taskMdPath);
    return boundFact ? resourceIdentityNumber(boundFact.identity.resource) : null;
  } catch {
    return null;
  }
}

function warningResultForPrimary(primaryResult: PullRequestPrimaryResult): NonNullable<PullRequestSummaryResult['result']> {
  if (primaryResult === 'pr_created') return 'pr_created_with_warnings';
  if (primaryResult === 'pr_reused') return 'pr_reused_with_warnings';
  return 'no_op_with_warnings';
}

function platformError(error: { code: string; message: string; retryable?: boolean }): NonNullable<PlatformResult['error']> {
  return { code: error.code, message: error.message, retryable: error.retryable ?? false };
}

function buildPullRequestSummary(taskId: string, body: string, headSha: string, humanOverrideAudit = ''): string {
  const sections = [body.replace(/\s+$/, ''), renderSafeHumanOverrideAudit(humanOverrideAudit)].filter(Boolean).join('\n\n');
  return normalizeCommentContent(`${summaryMarker(taskId)}\n<!-- last-commit: ${headSha} -->\n\n${sections}\n`);
}

function reconcileSummaryComment(comments: SummaryComment[], taskId: string, desired: string):
  { action: 'create' | 'update' | 'no-op' | 'conflict'; commentId: number | string | null } {
  const marker = summaryMarker(taskId);
  const matches = comments.filter((comment) => comment.body.includes(marker));
  if (matches.length > 1) return { action: 'conflict', commentId: null };
  if (matches.length === 0) return { action: 'create', commentId: null };
  return normalizeCommentContent(matches[0]!.body) === normalizeCommentContent(desired)
    ? { action: 'no-op', commentId: matches[0]!.id }
    : { action: 'update', commentId: matches[0]!.id };
}

function canonicalArtifacts(taskDir: string) {
  const allowed = /^(plan|review-plan|code|review-code|manual-validation)(?:-r\d+)?\.md$/;
  const byFamily = new Map<string, { family: string; name: string; path: string; round: number }>();
  for (const artifact of enumerateArtifacts(taskDir)) {
    if (!allowed.test(artifact.name)) continue;
    const match = artifact.name.match(/^(plan|review-plan|code|review-code|manual-validation)(?:-r(\d+))?\.md$/)!;
    const family = match[1]!;
    const round = match[2] ? Number(match[2]) : 1;
    const current = byFamily.get(family);
    if (!current || round > current.round) byFamily.set(family, { family, name: artifact.name, path: artifact.path, round });
  }
  return [...byFamily.values()].map(({ family, name, path: artifactPath }) => ({ family, name, path: artifactPath }));
}

function basePlatformResult(
  status: PlatformResult['status'],
  context: PlatformResult,
  taskId: string | null,
  prNumber: number | null,
  error: PlatformResult['error'] = null
): PlatformResult {
  return platformResult(status, {
    platform: context.platform,
    capabilities: context.capabilities,
    operations: context.operations,
    resource: { kind: 'pull-request', number: prNumber },
    error,
    ...(taskId ? { task: { id: taskId, prNumber } } : {})
  });
}

function isHardSummaryFailure(error: PlatformResult['error']): boolean {
  return error?.code === 'PR_SUMMARY_HEAD_RACE'
    || error?.code === 'PR_SUMMARY_POSTWRITE_VERIFY_FAILED'
    || error?.code === 'PR_SUMMARY_RACE_COMPENSATION_FAILED';
}

function inspectionError(error: { code: string; message: string; retryable: boolean }): PlatformResult['status'] {
  return error.retryable ? 'blocked' : 'failed';
}

async function inspectBoundPullRequest(
  context: PlatformResult,
  repoRoot: string,
  prNumber: number,
  loadedContext?: LoadedContext
): Promise<{ ok: true; value: PlatformChangeRequestSnapshot } | { ok: false; error: PlatformResult['error']; status: PlatformResult['status'] }> {
  if (!context.platform.repository) {
    return { ok: false, status: context.status, error: context.error };
  }
  const loaded = loadedContext
    ? { ok: true as const, value: loadedContext }
    : await resolvePlatformProviderContext({ cwd: repoRoot });
  if (!loaded.ok) return { ok: false, status: loaded.context.status, error: loaded.context.error };
  const target = providerResourceToken(loaded.value.provider, 'pull-request', String(prNumber));
  const inspected = loaded.value.provider.changeRequests?.inspect
    ? await loaded.value.provider.changeRequests.inspect({ context: providerOperationContext(loaded.value), target })
    : unsupportedProviderOperation(loaded.value.provider, 'changeRequests.inspect');
  if (!inspected.ok) {
    const error = providerError(inspected.error, 'PLATFORM_PROVIDER_OPERATION_FAILED');
    return { ok: false, status: inspectionError(error), error };
  }
  const remote: ChangeRequestSnapshot = inspected.value;
  const number = remote.number ?? resourceIdentityNumber(remote.identity) ?? prNumber;
  const head = remote.head || { repository: context.platform.repository, ref: '', sha: remote.headSha || '' };
  const base = remote.base || { repository: context.platform.repository, ref: '', sha: remote.baseSha || '' };
  return {
    ok: true,
    value: {
      repository: context.platform.repository,
      number,
      nodeId: remote.id,
      url: remote.displayUrl || '',
      state: remote.state === 'closed' ? 'closed' : 'open',
      title: remote.title,
      body: remote.body,
      draft: remote.draft ?? false,
      head: { ...head, sha: remote.headSha || head.sha },
      base: { ...base, sha: remote.baseSha || base.sha },
      mergedAt: remote.mergedAt ?? null,
      mergeCommitSha: remote.mergeCommitSha ?? null,
      labels: [...(remote.labels || [])].sort(),
      assignees: [...(remote.assignees || [])].sort(),
      milestone: remote.milestone ?? null,
      mergeability: remote.mergeability || { state: 'unknown', detail: null }
    }
  };
}

function sameIdentity(left: PlatformChangeRequestSnapshot, right: PlatformChangeRequestSnapshot): boolean {
  return JSON.stringify({
    repository: left.repository,
    number: left.number,
    base: left.base,
    head: left.head
  }) === JSON.stringify({
    repository: right.repository,
    number: right.number,
    base: right.base,
    head: right.head
  });
}

function identityFromSnapshot(snapshot: PlatformChangeRequestSnapshot) {
  return {
    repository: snapshot.repository,
    number: snapshot.number,
    base: { ...snapshot.base },
    head: { ...snapshot.head }
  };
}

function readJsonInput(file: string): { ok: true; value: unknown } | { ok: false; error: { code: string; message: string; retryable: boolean } } {
  try {
    return { ok: true, value: JSON.parse(fs.readFileSync(file, 'utf8')) as unknown };
  } catch (error) {
    const errno = (error as NodeJS.ErrnoException).code;
    return {
      ok: false,
      error: {
        code: errno === 'ENOENT' ? 'PR_CHANGE_REPORT_INPUT_MISSING' : 'PR_CHANGE_REPORT_INPUT_INVALID',
        message: error instanceof Error ? error.message : String(error),
        retryable: false
      }
    };
  }
}

function sameMechanical(left: MechanicalChangeReport, right: MechanicalChangeReport): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function currentReportCheck(
  report: PrChangeReport,
  snapshot: PlatformChangeRequestSnapshot,
  taskContent: string,
  repoRoot: string
): { ok: true; digest: string; mechanical: MechanicalChangeReport } | { ok: false; error: { code: string; message: string; retryable: boolean } } {
  const digest = taskIntentDigest(taskContent);
  if (!digest.ok) return { ok: false, error: platformError(digest.error) };
  const reportIdentity = report.identity;
  if (reportIdentity.repository !== snapshot.repository || reportIdentity.number !== snapshot.number ||
      JSON.stringify(reportIdentity.base) !== JSON.stringify(snapshot.base) || JSON.stringify(reportIdentity.head) !== JSON.stringify(snapshot.head)) return {
    ok: false,
    error: { code: 'PR_CHANGE_REPORT_STALE', message: 'Change report identity does not match the authoritative pull request snapshot', retryable: false }
  };
  if (report.inputs.taskIntentSha256 !== digest.value.sha256) return {
    ok: false,
    error: { code: 'PR_CHANGE_REPORT_STALE', message: 'Change report task intent digest is stale', retryable: false }
  };
  let mechanical: MechanicalChangeReport;
  try {
    mechanical = runMechanicalChangeReport(repoRoot, snapshot.base.sha, snapshot.head.sha);
  } catch (error) {
    return { ok: false, error: { code: 'PR_CHANGE_REPORT_GIT_FAILED', message: error instanceof Error ? error.message : String(error), retryable: false } };
  }
  const reportMechanical: MechanicalChangeReport = {
    version: 1,
    base: snapshot.base.sha,
    head: snapshot.head.sha,
    mergeBase: report.diff.mergeBase,
    patchSha256: report.diff.patchSha256,
    files: report.diff.files,
    totals: report.diff.totals
  };
  if (!sameMechanical(reportMechanical, mechanical)) return {
    ok: false,
    error: { code: 'PR_CHANGE_REPORT_STALE', message: 'Change report patch or mechanical statistics are stale', retryable: false }
  };
  return { ok: true, digest: digest.value.sha256, mechanical };
}

function summaryReportStatus(
  reportPath: string,
  snapshot: PlatformChangeRequestSnapshot | null,
  taskContent: string,
  repoRoot: string
): { status: ChangeReportState; taskIntentSha256: string | null; reason?: string } {
  const digest = taskIntentDigest(taskContent);
  if (!digest.ok) return { status: 'invalid', taskIntentSha256: null, reason: digest.error.message };
  const report = readPrChangeReport(reportPath);
  if (!report.ok) return { status: report.error.code === 'PR_CHANGE_REPORT_MISSING' ? 'missing' : 'invalid', taskIntentSha256: digest.value.sha256, reason: report.error.message };
  if (!snapshot) return { status: 'stale', taskIntentSha256: digest.value.sha256, reason: 'No bound pull request snapshot is available' };
  const checked = currentReportCheck(report.value, snapshot, taskContent, repoRoot);
  return checked.ok
    ? { status: 'ready', taskIntentSha256: checked.digest }
    : { status: checked.error.code === 'PR_CHANGE_REPORT_STALE' ? 'stale' : 'invalid', taskIntentSha256: digest.value.sha256, reason: checked.error.message };
}

async function summaryContext(taskRef: string, options: SummaryOptions = {}): Promise<SummaryContextResult> {
  const resolved = resolveTaskRef(taskRef, options.cwd ? { repoRoot: options.cwd } : {});
  if (!resolved.ok) return {
    ...platformResult('failed', { error: { code: resolved.code, message: resolved.message, retryable: false } }),
    task: { id: resolved.taskId, prNumber: null }, pullRequest: null,
    changeReport: { status: 'invalid', path: '', taskIntentSha256: null, reason: resolved.message }, artifacts: []
  };
  const taskContent = fs.readFileSync(resolved.taskMdPath, 'utf8');
  const frontmatter = parseTypedTaskFrontmatter(taskContent);
  const fact = readPrDeliveryFact(frontmatter, options.runtimeVersion);
  const prNumber = fact.status === 'valid' && fact.fact.state === 'bound' ? resourceIdentityNumber(fact.fact.identity.resource) : null;
  const reportPath = taskReportPath(resolved.taskDir);
  const loaded = await resolvePlatformProviderContext({ cwd: resolved.repoRoot, client: options.client });
  const context = loaded.ok ? loaded.value.context : loaded.context;
  let pullRequest: PlatformChangeRequestSnapshot | null = null;
  if (loaded.ok && prNumber && context.platform.repository && ['no-op', 'degraded'].includes(context.status)) {
    const inspected = await inspectBoundPullRequest(context, resolved.repoRoot, prNumber, loaded.value);
    if (inspected.ok) pullRequest = inspected.value;
  }
  const report = summaryReportStatus(reportPath, pullRequest, taskContent, resolved.repoRoot);
  return {
    ...platformResult(context.status, {
      platform: context.platform,
      capabilities: context.capabilities,
      operations: context.operations,
      error: context.error
    }),
    task: { id: resolved.taskId, prNumber },
    pullRequest,
    changeReport: { status: report.status, path: reportPath, taskIntentSha256: report.taskIntentSha256, ...(report.reason ? { reason: report.reason } : {}) },
    artifacts: canonicalArtifacts(resolved.taskDir)
  };
}

type ReportWriteOptions = {
  agent: string;
  mechanicalFile: string;
  precheckFile: string;
  cwd?: string;
  client?: PlatformClient;
  dryRun?: boolean;
};

async function reportWrite(taskRef: string, options: ReportWriteOptions): Promise<ReportWriteResult> {
  const resolved = resolveTaskRef(taskRef, options.cwd ? { repoRoot: options.cwd } : {});
  if (!resolved.ok) return { ...platformResult('failed', { error: { code: resolved.code, message: resolved.message, retryable: false } }), report: null };
  const loaded = await resolvePlatformProviderContext({ cwd: resolved.repoRoot, client: options.client });
  const context = loaded.ok ? loaded.value.context : loaded.context;
  if (!loaded.ok || !context.platform.repository || !['no-op', 'degraded'].includes(context.status)) return { ...context, report: null };
  let knownPrNumber: number | null = null;
  try {
    return await withTaskExecutionLock(resolved.repoRoot, resolved.taskId, options.agent, async () => {
      const { taskContent, boundFact } = readBoundTaskSnapshot(resolved.taskMdPath);
      if (!boundFact) return {
        ...basePlatformResult('failed', context, resolved.taskId, null, { code: 'PR_NOT_LINKED', message: 'Task has no verified bound pull request', retryable: false }),
        report: null
      };
      const boundPrNumber = resourceIdentityNumber(boundFact.identity.resource);
      if (!boundPrNumber) return {
        ...basePlatformResult('failed', context, resolved.taskId, null, { code: 'PR_NUMBER_INVALID', message: 'Bound pull request has no numeric identifier', retryable: false }),
        report: null
      };
      knownPrNumber = boundPrNumber;
      const initial = await inspectBoundPullRequest(context, resolved.repoRoot, boundPrNumber, loaded.value);
      if (!initial.ok) return { ...basePlatformResult(initial.status, context, resolved.taskId, boundPrNumber, initial.error), report: null };
      const digest = taskIntentDigest(taskContent);
      if (!digest.ok) return { ...basePlatformResult('failed', context, resolved.taskId, boundPrNumber, platformError(digest.error)), report: null };
      const mechanicalInput = readJsonInput(path.resolve(resolved.repoRoot, options.mechanicalFile));
      if (!mechanicalInput.ok) return { ...basePlatformResult('failed', context, resolved.taskId, boundPrNumber, mechanicalInput.error), report: null };
      const mechanical = validateMechanicalReport(mechanicalInput.value);
      if (!mechanical.ok) return { ...basePlatformResult('failed', context, resolved.taskId, boundPrNumber, platformError(mechanical.error)), report: null };
      const candidateInput = readJsonInput(path.resolve(resolved.repoRoot, options.precheckFile));
      if (!candidateInput.ok) return { ...basePlatformResult('failed', context, resolved.taskId, boundPrNumber, candidateInput.error), report: null };
      const candidate = validatePrecheckCandidate(candidateInput.value);
      if (!candidate.ok) return { ...basePlatformResult('failed', context, resolved.taskId, boundPrNumber, platformError(candidate.error)), report: null };
      let recomputed: MechanicalChangeReport;
      try {
        recomputed = runMechanicalChangeReport(resolved.repoRoot, initial.value.base.sha, initial.value.head.sha);
      } catch (error) {
        return { ...basePlatformResult('failed', context, resolved.taskId, boundPrNumber, { code: 'PR_CHANGE_REPORT_GIT_FAILED', message: error instanceof Error ? error.message : String(error), retryable: false }), report: null };
      }
      if (!sameMechanical(mechanical.value, recomputed)) return {
        ...basePlatformResult('failed', context, resolved.taskId, boundPrNumber, { code: 'PR_CHANGE_REPORT_MECHANICAL_MISMATCH', message: 'Mechanical report input does not match the current complete diff', retryable: false }),
        report: null
      };
      const built = buildPrChangeReport(identityFromSnapshot(initial.value), digest.value.sha256, mechanical.value, candidate.value);
      if (!built.ok) return { ...basePlatformResult('failed', context, resolved.taskId, boundPrNumber, platformError(built.error)), report: null };
      const final = await inspectBoundPullRequest(context, resolved.repoRoot, boundPrNumber, loaded.value);
      if (!final.ok) return { ...basePlatformResult(final.status, context, resolved.taskId, boundPrNumber, final.error), report: null };
      if (!sameIdentity(initial.value, final.value)) return {
        ...basePlatformResult('blocked', context, resolved.taskId, boundPrNumber, { code: 'PR_CHANGE_REPORT_HEAD_RACE', message: 'Pull request identity changed while generating the change report', retryable: true }),
        report: null
      };
      const target = taskReportPath(resolved.taskDir);
      const existing = readPrChangeReport(target);
      const reportInfo = {
        path: target,
        precheckVerdict: built.value.precheck.verdict,
        nextAction: built.value.precheck.route
      } as const;
      if (existing.ok && JSON.stringify(existing.value) === JSON.stringify(built.value)) return {
        ...basePlatformResult('no-op', context, resolved.taskId, boundPrNumber),
        report: { ...reportInfo, status: 'no-op' }
      };
      if (options.dryRun) return {
        ...basePlatformResult('planned', context, resolved.taskId, boundPrNumber),
        operations: [{ name: 'change-report:write', status: 'planned', reasonCode: null }],
        report: { ...reportInfo, status: 'planned' }
      };
      try {
        writePrChangeReportAtomic(target, built.value);
      } catch (error) {
        return { ...basePlatformResult('failed', context, resolved.taskId, boundPrNumber, { code: 'PR_CHANGE_REPORT_WRITE_FAILED', message: error instanceof Error ? error.message : String(error), retryable: false }), report: null };
      }
      return {
        ...basePlatformResult('applied', context, resolved.taskId, boundPrNumber),
        operations: [{ name: 'change-report:write', status: 'applied', reasonCode: null }],
        report: { ...reportInfo, status: 'written' }
      };
    });
  } catch (error) {
    const lockError = error instanceof TaskExecutionLockError
      ? { code: error.code, message: error.message, retryable: error.code === 'ORCHESTRATION_LOCK_BUSY' }
      : { code: 'PR_CHANGE_REPORT_FAILED', message: error instanceof Error ? error.message : String(error), retryable: false };
    return { ...basePlatformResult(lockError.retryable ? 'blocked' : 'failed', context, resolved.taskId, knownPrNumber, lockError), report: null };
  }
}

async function syncPullRequestSummary(
  taskRef: string,
  options: { agent: string; body: string; changeReportFile?: string; cwd?: string; client?: PlatformClient; dryRun?: boolean; primaryResult: PullRequestPrimaryResult; runtimeVersion?: string }
): Promise<PullRequestSummaryResult> {
  const warningResult = warningResultForPrimary(options.primaryResult);
  let knownPrNumber: number | null = null;
  const softenFailure = (output: PlatformResult): PullRequestSummaryResult => {
    const prNumber = output.resource.kind === 'pull-request' && output.resource.number
      ? output.resource.number
      : knownPrNumber;
    const warning = output.error && prNumber && output.error.code !== 'PR_NOT_LINKED'
      ? {
        code: output.error.code,
        message: output.error.message,
        retryable: output.error.retryable,
        step: 'pr-summary',
        target: `pull-request:${prNumber}`,
        severity: 'ACTION_REQUIRED' as const
      }
      : null;
    return warning
      ? {
        ...output,
        status: 'applied',
        changed: false,
        resource: { kind: 'pull-request', number: prNumber },
        error: null,
        result: warningResult,
        warnings: [warning]
      }
      : { ...output, result: null, warnings: [] };
  };
  const resolved = resolveTaskRef(taskRef, options.cwd ? { repoRoot: options.cwd } : {});
  if (!resolved.ok) return softenFailure(platformResult('failed', { error: { code: resolved.code, message: resolved.message, retryable: false } }));
  const fail = (status: PlatformResult['status'], context: PlatformResult, error: PlatformResult['error'], prNumber = knownPrNumber): PullRequestSummaryResult => {
    const output = basePlatformResult(status, context, resolved.taskId, prNumber, error);
    return isHardSummaryFailure(error)
      ? { ...output, result: null, warnings: [] }
      : { ...softenFailure(output) };
  };
  if (!options.changeReportFile) return softenFailure(platformResult('failed', { error: { code: 'PR_CHANGE_REPORT_MISSING', message: 'summary-sync requires --change-report-file', retryable: false } }));
  const loaded = await resolvePlatformProviderContext({ cwd: resolved.repoRoot, client: options.client });
  const context = loaded.ok ? loaded.value.context : loaded.context;
  if (!loaded.ok || !context.platform.repository || !['no-op', 'degraded'].includes(context.status)) {
    // This diagnostic-only read preserves the known PR target when context resolution fails before the execution lock.
    knownPrNumber = boundPrNumberForWarning(resolved.taskMdPath);
    return softenFailure(context);
  }
  try {
    return await withTaskExecutionLock(resolved.repoRoot, resolved.taskId, options.agent, async () => {
      const { taskContent, boundFact } = readBoundTaskSnapshot(resolved.taskMdPath);
      if (!boundFact) return {
        ...platformResult('failed', { resource: { kind: 'pull-request', number: null }, error: { code: 'PR_NOT_LINKED', message: 'Task has no verified bound pull request', retryable: false } }),
        result: null, warnings: []
      };
      const prIdentity = boundFact.identity.resource;
      const boundPrNumber = resourceIdentityNumber(prIdentity);
      if (!boundPrNumber) return {
        ...platformResult('failed', { resource: { kind: 'pull-request', number: null }, error: { code: 'PR_NUMBER_INVALID', message: 'Bound pull request has no numeric identifier', retryable: false } }),
        result: null, warnings: []
      };
      knownPrNumber = boundPrNumber;
      const prNumber = boundPrNumber;
      const initial = await inspectBoundPullRequest(context, resolved.repoRoot, boundPrNumber, loaded.value);
      if (!initial.ok) return fail(initial.status, context, initial.error);
      const expectedReportPath = taskReportPath(resolved.taskDir);
      const suppliedReportPath = path.resolve(resolved.repoRoot, options.changeReportFile!);
      if (suppliedReportPath !== expectedReportPath) return fail('failed', context, { code: 'PR_CHANGE_REPORT_PATH_INVALID', message: 'summary-sync must consume the task-bound pr-change-report.json', retryable: false });
      const report = readPrChangeReport(suppliedReportPath);
      if (!report.ok) return fail('failed', context, platformError(report.error));
      const checked = currentReportCheck(report.value, initial.value, taskContent, resolved.repoRoot);
      if (!checked.ok) return fail('failed', context, checked.error);
      const replaced = replaceCanonicalReportPlaceholder(options.body, report.value);
      if (!replaced.ok) return fail('failed', context, platformError(replaced.error));
      const desired = buildPullRequestSummary(resolved.taskId, replaced.value, initial.value.head.sha, renderHumanOverrideAudit(taskContent));
      if (!isSafeSummaryEnvelope(desired, resolved.taskId)) return fail('failed', context, {
        code: 'PR_SUMMARY_RENDER_INVALID',
        message: 'Summary contains an invalid or duplicated reserved control marker',
        retryable: false
      });
      const listed = loaded.value.provider.comments?.list
        ? await loaded.value.provider.comments.list({ context: providerOperationContext(loaded.value), parent: prIdentity }).then((response) => response.ok
          ? { ok: true as const, value: response.value.map((comment) => ({ id: /^\d+$/.test(comment.id) ? Number(comment.id) : comment.id, body: comment.body })) }
          : response)
        : unsupportedProviderOperation(loaded.value.provider, 'comments.list');
      if (!listed.ok) return fail(providerStatus(listed.error) === 'blocked' ? 'blocked' : 'failed', context, providerError(listed.error, 'PLATFORM_PROVIDER_OPERATION_FAILED'));
      const reconciliation = reconcileSummaryComment(listed.value, resolved.taskId, desired);
      if (reconciliation.action === 'conflict') return fail('failed', context, { code: 'PR_SUMMARY_MARKER_AMBIGUOUS', message: 'Multiple PR comments contain the summary marker', retryable: false });
      const previousBody = reconciliation.action === 'update'
        ? listed.value.find((comment) => comment.id === reconciliation.commentId)?.body ?? null
        : null;
      const info = { precheckVerdict: report.value.precheck.verdict, nextAction: report.value.precheck.route } as const;
      const beforeWrite = await inspectBoundPullRequest(context, resolved.repoRoot, boundPrNumber, loaded.value);
      if (!beforeWrite.ok) return fail(beforeWrite.status, context, beforeWrite.error, prNumber);
      if (!sameIdentity(initial.value, beforeWrite.value)) return fail('blocked', context, {
        code: 'PR_SUMMARY_HEAD_RACE',
        message: 'Pull request head changed before publishing the summary',
        retryable: true
      }, prNumber);
      if (reconciliation.action === 'no-op') return {
        ...basePlatformResult('no-op', context, resolved.taskId, prNumber),
        comment: { kind: 'summary', marker: summaryMarker(resolved.taskId), ids: [reconciliation.commentId!], parts: 1 },
        result: null, warnings: [], ...info
      };
      if (options.dryRun) return {
        ...basePlatformResult('planned', context, resolved.taskId, prNumber),
        operations: [{ name: `summary:${reconciliation.action}`, status: 'planned', reasonCode: null }],
        result: null, warnings: [], ...info
      };
      const existingComment = reconciliation.commentId === null
        ? undefined
        : providerResourceToken(loaded.value.provider, 'comment', String(reconciliation.commentId));
      const written = loaded.value.provider.comments?.write
        ? await loaded.value.provider.comments.write({
          context: providerOperationContext(loaded.value),
          parent: prIdentity,
          body: desired,
          ...(existingComment ? { existingComment } : {}),
          mutation: { idempotencyKey: `pr-summary:${resolved.taskId}` }
        })
        : unsupportedProviderOperation(loaded.value.provider, 'comments.write');
      if (!written.ok) return fail(providerStatus(written.error) === 'blocked' ? 'blocked' : 'failed', context, providerError(written.error, 'PLATFORM_PROVIDER_OPERATION_FAILED'), prNumber);
      const after = await inspectBoundPullRequest(context, resolved.repoRoot, prNumber, loaded.value);
      const id = /^\d+$/.test(written.value.remoteId) ? Number(written.value.remoteId) : written.value.remoteId;
      const compensateWrittenSummary = async () => reconciliation.action === 'create'
        ? written.value.remoteId && loaded.value.provider.comments?.delete
          ? await loaded.value.provider.comments.delete({
            context: providerOperationContext(loaded.value),
            parent: prIdentity,
            comment: providerResourceToken(loaded.value.provider, 'comment', written.value.remoteId),
            mutation: { idempotencyKey: `pr-summary-delete:${resolved.taskId}:${written.value.remoteId}` }
          })
          : { ok: false as const, error: { code: 'PR_SUMMARY_RACE_COMPENSATION_FAILED', message: 'Created summary comment has no valid id', retryable: true } }
        : reconciliation.commentId && previousBody !== null && loaded.value.provider.comments?.write
          ? await loaded.value.provider.comments.write({
            context: providerOperationContext(loaded.value),
            parent: prIdentity,
            body: previousBody,
            existingComment: providerResourceToken(loaded.value.provider, 'comment', String(reconciliation.commentId)),
            mutation: { idempotencyKey: `pr-summary-restore:${resolved.taskId}` }
          })
          : { ok: false as const, error: { code: 'PR_SUMMARY_RACE_COMPENSATION_FAILED', message: 'Previous summary body is unavailable for restoration', retryable: true } };
      if (!after.ok) {
        const compensated = await compensateWrittenSummary();
        if (!compensated.ok) return fail('blocked', context, {
          code: 'PR_SUMMARY_RACE_COMPENSATION_FAILED',
          message: `Summary post-write verification failed and compensation failed: ${compensated.error.message}`,
          retryable: true
        }, prNumber);
        return fail('blocked', context, {
          code: 'PR_SUMMARY_POSTWRITE_VERIFY_FAILED',
          message: `Summary was written but pull-request verification failed: ${after.error?.message || 'unknown verification error'}; the previous summary was restored or the new comment was deleted`,
          retryable: true
        }, prNumber);
      }
      if (!sameIdentity(initial.value, after.value)) {
        const compensated = await compensateWrittenSummary();
        if (!compensated.ok) return fail('blocked', context, {
          code: 'PR_SUMMARY_RACE_COMPENSATION_FAILED',
          message: `Pull-request head changed and summary compensation failed: ${compensated.error.message}`,
          retryable: true
        }, prNumber);
        return fail('blocked', context, {
          code: 'PR_SUMMARY_HEAD_RACE',
          message: 'Pull-request head changed while publishing; the previous summary was restored or the new comment was deleted; rerun report and summary sync',
          retryable: true
        }, prNumber);
      }
      return {
        ...basePlatformResult('applied', context, resolved.taskId, prNumber),
        comment: { kind: 'summary', marker: summaryMarker(resolved.taskId), ids: Number.isInteger(id) ? [id] : [], parts: 1 },
        operations: [{ name: `summary:${reconciliation.action}`, status: 'applied', reasonCode: null }],
        result: null, warnings: [], ...info
      };
    });
  } catch (error) {
    const lockError = error instanceof TaskExecutionLockError
      ? { code: error.code, message: error.message, retryable: error.code === 'ORCHESTRATION_LOCK_BUSY' }
      : { code: 'PR_SUMMARY_FAILED', message: error instanceof Error ? error.message : String(error), retryable: false };
    return fail(lockError.retryable ? 'blocked' : 'failed', context, lockError);
  }
}

export {
  buildPullRequestSummary,
  reconcileSummaryComment,
  reportWrite,
  summaryContext,
  summaryMarker,
  syncPullRequestSummary,
  warningResultForPrimary
};
export type { PullRequestSummaryResult, ReportWriteOptions, ReportWriteResult, SummaryContextResult };
