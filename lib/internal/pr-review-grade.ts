import fs from 'node:fs';
import path from 'node:path';

import {
  collectHostCandidates,
  decide,
  deriveTaskIssueMatches,
  extractClosingIssueNumbers,
  resolveHostFromCandidates
} from '../pr-review/evidence-grading.ts';
import type { DecisionRecord, HostResolution } from '../pr-review/evidence-grading.ts';
import { inspectPlatformPullRequestByNumber } from '../platform/pull-requests.ts';
import { verifyInProcess } from '../task/verification-engine.ts';
import { ensureInternalHandlerRoute, internalHandlerRoute } from './cli-route-inventory.ts';

const USAGE = `Usage: agent-infra-internal pr-review-grade decide --input-file <path|-> [--cwd <path>]
       agent-infra-internal pr-review-grade resolve-host --pr <token> [--cwd <path>]
       agent-infra-internal pr-review-grade verify-artifact --artifact-file <path> [--cwd <path>]
`;

function fail(message: string): void {
  process.stdout.write(`${JSON.stringify({ status: 'failed', changed: false, error: { code: 'PR_REVIEW_GRADE_INVALID', message } })}\n`);
  process.stderr.write(USAGE);
  process.exitCode = 1;
}

function finish(result: unknown, exitCode = 0): void {
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (exitCode !== 0) process.exitCode = exitCode;
}

function parseFlags(args: string[], start: number): { values: Record<string, string | boolean>; error?: string } {
  const values: Record<string, string | boolean> = {};
  const seen = new Set<string>();
  for (let index = start; index < args.length; index += 1) {
    const flag = args[index]!;
    if (!['--input-file', '--artifact-file', '--cwd', '--pr'].includes(flag)) {
      return { values, error: `unknown option '${flag}'` };
    }
    if (seen.has(flag)) return { values, error: `duplicate option '${flag}'` };
    seen.add(flag);
    const value = args[++index];
    if (value === undefined || value.startsWith('--')) return { values, error: `option '${flag}' requires a value` };
    values[flag.slice(2).replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase())] = value;
  }
  return { values };
}

function readInput(value: string, cwd: string): string {
  return value === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(path.resolve(cwd, value), 'utf8');
}

async function prReviewGrade(args: string[] = []): Promise<void> {
  if (!ensureInternalHandlerRoute('pr-review-grade', args)) return;
  if (args[0] === '--help' || args[0] === '-h') { process.stdout.write(USAGE); return; }
  const operation = args[0];
  if (!operation || ![
    internalHandlerRoute('pr-review-grade', 'decide', operation),
    internalHandlerRoute('pr-review-grade', 'resolve-host', operation),
    internalHandlerRoute('pr-review-grade', 'verify-artifact', operation)
  ].some(Boolean)) { fail('a valid operation is required'); return; }
  const parsed = parseFlags(args, 1);
  if (parsed.error) { fail(parsed.error); return; }
  const values = parsed.values;
  const cwd = path.resolve(typeof values.cwd === 'string' ? values.cwd : process.cwd());
  const allowed: Record<string, string[]> = {
    decide: ['cwd', 'inputFile'],
    'resolve-host': ['cwd', 'pr'],
    'verify-artifact': ['cwd', 'artifactFile']
  };
  const unexpected = Object.keys(values).find((key) => !allowed[operation]!.includes(key));
  if (unexpected) { fail(`${operation} does not accept '--${unexpected}'`); return; }

  if (internalHandlerRoute('pr-review-grade', 'decide', operation)) {
    if (typeof values.inputFile !== 'string') { fail('decide requires --input-file'); return; }
    let input: unknown;
    try {
      input = JSON.parse(readInput(values.inputFile, cwd));
    } catch (error) {
      fail(`unable to read decide input: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    try {
      const record: DecisionRecord = decide(input as Parameters<typeof decide>[0]);
      finish(record);
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'DECIDE_FAILED';
      finish({ status: 'failed', changed: false, error: { code, message: error instanceof Error ? error.message : String(error) } }, 1);
    }
    return;
  }

  if (internalHandlerRoute('pr-review-grade', 'resolve-host', operation)) {
    const pr = typeof values.pr === 'string' ? values.pr : '';
    if (!pr) { fail('resolve-host requires --pr <token>'); return; }
    const inspected = await inspectPlatformPullRequestByNumber(pr, { cwd });
    if (!inspected.pullRequest) {
      finish({
        status: 'failed', changed: false, host: null, candidates: [], closingIssues: [],
        error: inspected.error ?? { code: 'PR_INSPECTION_INVALID', message: 'unable to inspect the pull request', retryable: false }
      }, inspected.status === 'blocked' ? 2 : 1);
      return;
    }
    const prNumber = inspected.pullRequest.number;
    const prIdentity = inspected.pullRequest.identity || { kind: 'number' as const, value: prNumber };
    const closingIssues = extractClosingIssueNumbers(inspected.pullRequest.body);
    const candidates = collectHostCandidates({ prNumber, prIdentity, closingIssues, workspaceRoot: cwd });
    const host: HostResolution = resolveHostFromCandidates(candidates);
    finish({
      status: 'ok', changed: false,
      pr: { number: prNumber, identity: prIdentity, baseSha: inspected.pullRequest.base.sha, headSha: inspected.pullRequest.head.sha, state: inspected.pullRequest.state },
      closingIssues, candidates, host,
      taskIssueMatches: deriveTaskIssueMatches(host, closingIssues), error: null
    });
    return;
  }

  if (!internalHandlerRoute('pr-review-grade', 'verify-artifact', operation)) { fail('operation is not registered'); return; }
  if (typeof values.artifactFile !== 'string') { fail('verify-artifact requires --artifact-file'); return; }
  const artifactPath = path.resolve(cwd, values.artifactFile);
  let result: Record<string, unknown>;
  try {
    result = await verifyInProcess({
      mode: 'checks',
      skillName: 'review-pr',
      taskDir: path.dirname(artifactPath),
      artifactFile: path.basename(artifactPath),
      checks: ['artifact'],
      repositoryRoot: cwd
    }) as Record<string, unknown>;
  } catch (error) {
    finish({ status: 'failed', changed: false, error: { code: 'VERIFY_ARTIFACT_INVALID', message: error instanceof Error ? error.message : String(error) } }, 1);
    return;
  }
  const status = result.status as 'pass' | 'fail' | 'blocked';
  finish(result, ({ pass: 0, fail: 1, blocked: 2 } as const)[status]);
}

export { prReviewGrade };
