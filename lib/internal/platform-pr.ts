import fs from 'node:fs';
import path from 'node:path';

import { normalizeAgentToken, AGENT_USAGE_HINT } from '../agent-clients/tokens.ts';
import {
  bindPlatformPullRequest,
  createPlatformPullRequest,
  inspectPlatformPullRequest,
  resolveExternalPullRequest,
  skipPlatformPullRequestFact,
  syncPlatformPullRequest,
  syncPlatformPullRequestInLabels
} from '../platform/pull-requests.ts';
import type { PullRequestResult } from '../platform/pull-requests.ts';
import { summaryContext, syncPullRequestSummary } from '../platform/pr-summary.ts';
import type { PlatformResult } from '../platform/types.ts';

const USAGE = `Usage: agent-infra-internal platform-pr inspect <task-ref> [--cwd <path>]
       agent-infra-internal platform-pr resolve-external <task-ref> --agent <agent> [--pr <token>] [--dry-run] [--cwd <path>]
       agent-infra-internal platform-pr create <task-ref> --agent <agent> --base <branch> --head <branch> --title-file <path|-> --body-file <path|-> [--draft] [--dry-run] [--cwd <path>]
       agent-infra-internal platform-pr bind <task-ref> --pr <token> --agent <agent> [--dry-run] [--cwd <path>]
       agent-infra-internal platform-pr skip <task-ref> --agent <agent> [--dry-run] [--cwd <path>]
       agent-infra-internal platform-pr sync <task-ref> --agent <agent> [--metadata] [--closing-issue] --result <pr_created|pr_reused|no_op> [--dry-run] [--cwd <path>]
       agent-infra-internal platform-pr sync-in-labels --pr <N> [--dry-run] [--cwd <path>]
       agent-infra-internal platform-pr summary-context <task-ref> [--cwd <path>]
       agent-infra-internal platform-pr summary-sync <task-ref> --agent <agent> --body-file <path|-> --result <pr_created|pr_reused|no_op> [--dry-run] [--cwd <path>]
`;

const BOOLEAN_FLAGS = new Set(['--draft', '--dry-run', '--metadata', '--closing-issue']);
const VALUE_FLAGS = new Set(['--cwd', '--agent', '--base', '--head', '--title-file', '--body-file', '--pr', '--result']);

function key(flag: string): string {
  return flag.slice(2).replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

function fail(message: string): void {
  process.stdout.write(`${JSON.stringify({ status: 'failed', changed: false, error: { code: 'PR_PAYLOAD_INVALID', message } })}\n`);
  process.stderr.write(USAGE);
  process.exitCode = 1;
}

function finish(output: PlatformResult | PullRequestResult): void {
  process.stdout.write(`${JSON.stringify(output)}\n`);
  if (output.status === 'failed') process.exitCode = 1;
  if (output.status === 'blocked') process.exitCode = 2;
}

function parse(args: string[], start: number) {
  const values: Record<string, string | boolean> = {};
  const seen = new Set<string>();
  for (let index = start; index < args.length; index += 1) {
    const flag = args[index]!;
    if (!BOOLEAN_FLAGS.has(flag) && !VALUE_FLAGS.has(flag)) return { values, error: `unknown option '${flag}'` };
    if (seen.has(flag)) return { values, error: `duplicate option '${flag}'` };
    seen.add(flag);
    if (BOOLEAN_FLAGS.has(flag)) { values[key(flag)] = true; continue; }
    const value = args[++index];
    if (value === undefined || value.startsWith('--')) return { values, error: `option '${flag}' requires a value` };
    values[key(flag)] = value;
  }
  return { values };
}

function readFile(value: string, cwd: string): string {
  return value === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(path.resolve(cwd, value), 'utf8');
}

async function platformPr(args: string[] = []): Promise<void> {
  if (args[0] === '--help' || args[0] === '-h') { process.stdout.write(USAGE); return; }
  const operation = args[0];
  if (!operation || !['inspect', 'resolve-external', 'create', 'bind', 'skip', 'sync', 'sync-in-labels', 'summary-context', 'summary-sync'].includes(operation)) { fail('a valid operation is required'); return; }
  if (operation === 'sync-in-labels') {
    const parsed = parse(args, 1);
    if (parsed.error) { fail(parsed.error); return; }
    const values = parsed.values;
    const unexpected = Object.keys(values).find((name) => !['cwd', 'pr', 'dryRun'].includes(name));
    if (unexpected) { fail(`sync-in-labels does not accept --${unexpected}`); return; }
    const pr = Number(values.pr);
    if (!Number.isInteger(pr) || pr <= 0) { fail('sync-in-labels requires a positive --pr'); return; }
    const cwd = path.resolve(typeof values.cwd === 'string' ? values.cwd : process.cwd());
    finish(await syncPlatformPullRequestInLabels(pr, { cwd, dryRun: values.dryRun === true }));
    return;
  }
  const taskRef = args[1];
  if (!taskRef || taskRef.startsWith('--')) { fail(`${operation} requires a task ref`); return; }
  const parsed = parse(args, 2);
  if (parsed.error) { fail(parsed.error); return; }
  const values = parsed.values;
  const cwd = path.resolve(typeof values.cwd === 'string' ? values.cwd : process.cwd());
  const allowed: Record<string, string[]> = {
    inspect: ['cwd'],
    'resolve-external': ['cwd', 'agent', 'pr', 'dryRun'],
    create: ['cwd', 'agent', 'base', 'head', 'titleFile', 'bodyFile', 'draft', 'dryRun'],
    bind: ['cwd', 'agent', 'pr', 'dryRun'],
    skip: ['cwd', 'agent', 'dryRun'],
    sync: ['cwd', 'agent', 'metadata', 'closingIssue', 'result', 'dryRun'],
    'sync-in-labels': ['cwd', 'pr', 'dryRun'],
    'summary-context': ['cwd'],
    'summary-sync': ['cwd', 'agent', 'bodyFile', 'result', 'dryRun']
  };
  const unexpected = Object.keys(values).find((name) => !allowed[operation]!.includes(name));
  if (unexpected) { fail(`${operation} does not accept --${unexpected}`); return; }
  if (operation === 'inspect') { finish(await inspectPlatformPullRequest(taskRef, { cwd })); return; }
  if (operation === 'summary-context') { finish(summaryContext(taskRef, { cwd })); return; }
  if (typeof values.agent !== 'string' || !values.agent) { fail(`${operation} requires --agent`); return; }
  const agent = normalizeAgentToken(values.agent);
  if (!agent) { fail(`invalid --agent '${values.agent}': ${AGENT_USAGE_HINT}`); return; }
  values.agent = agent;
  if (operation === 'skip') {
    finish(await skipPlatformPullRequestFact(taskRef, { cwd, agent, dryRun: values.dryRun === true }));
    return;
  }
  const primaryResult = values.result === undefined ? undefined : values.result;
  if (primaryResult !== undefined && !['pr_created', 'pr_reused', 'no_op'].includes(primaryResult as string)) {
    fail('--result must be pr_created, pr_reused, or no_op');
    return;
  }
  if (operation === 'resolve-external') {
    const pr = values.pr === undefined ? undefined : values.pr;
    if (pr !== undefined && (typeof pr !== 'string' || !pr)) { fail('resolve-external requires --pr <token>'); return; }
    finish(await resolveExternalPullRequest(taskRef, { cwd, agent: values.agent, pr, dryRun: values.dryRun === true }));
    return;
  }
  if (operation === 'bind') {
    const pr = values.pr;
    if (typeof pr !== 'string' || !pr) { fail('bind requires --pr <token>'); return; }
    finish(await bindPlatformPullRequest(taskRef, { cwd, agent: values.agent, pr, dryRun: values.dryRun === true }));
    return;
  }
  if (operation === 'sync') {
    if (values.metadata !== true && values.closingIssue !== true) { fail('sync requires --metadata or --closing-issue'); return; }
    if (!primaryResult) { fail('sync requires --result pr_created, pr_reused, or no_op'); return; }
    finish(await syncPlatformPullRequest(taskRef, { cwd, agent: values.agent, metadata: values.metadata === true, closingIssue: values.closingIssue === true, primaryResult: primaryResult as 'pr_created' | 'pr_reused' | 'no_op', dryRun: values.dryRun === true }));
    return;
  }
  if (operation === 'summary-sync') {
    if (typeof values.bodyFile !== 'string') { fail('summary-sync requires --body-file'); return; }
    if (!primaryResult) { fail('summary-sync requires --result pr_created, pr_reused, or no_op'); return; }
    try {
      finish(await syncPullRequestSummary(taskRef, { cwd, agent: values.agent, body: readFile(values.bodyFile, cwd), primaryResult: primaryResult as 'pr_created' | 'pr_reused' | 'no_op', dryRun: values.dryRun === true }));
    } catch (error) {
      fail(`unable to read body file: ${error instanceof Error ? error.message : String(error)}`);
    }
    return;
  }
  if (typeof values.base !== 'string' || typeof values.head !== 'string' || typeof values.titleFile !== 'string' || typeof values.bodyFile !== 'string') {
    fail('create requires --base, --head, --title-file and --body-file');
    return;
  }
  try {
    finish(await createPlatformPullRequest(taskRef, {
      cwd, agent: values.agent, base: values.base, head: values.head,
      title: readFile(values.titleFile, cwd), body: readFile(values.bodyFile, cwd),
      draft: values.draft === true, dryRun: values.dryRun === true
    }));
  } catch (error) {
    fail(`unable to read PR payload file: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export { platformPr };
