import fs from 'node:fs';
import path from 'node:path';

import { inspectPlatformPullRequestByNumber } from '../platform/pull-requests.ts';
import { listPrReviews, publishPrReview } from '../platform/pr-review.ts';
import type { PrReviewEvent } from '../platform/pr-review.ts';
import type { PlatformResult } from '../platform/types.ts';

const USAGE = `Usage: agent-infra-internal platform-pr-review inspect --pr <N> [--cwd <path>]
       agent-infra-internal platform-pr-review list --pr <N> [--cwd <path>]
       agent-infra-internal platform-pr-review publish --pr <N> --scope <taskId|pr{N}> --round <N> --commit <sha> --event <COMMENT|APPROVE|REQUEST_CHANGES> --body-file <path|-> [--dry-run] [--cwd <path>]
`;

const BOOLEAN_FLAGS = new Set(['--dry-run']);
const VALUE_FLAGS = new Set(['--cwd', '--pr', '--scope', '--round', '--commit', '--event', '--body-file']);

function key(flag: string): string {
  return flag.slice(2).replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

function fail(message: string): void {
  process.stdout.write(`${JSON.stringify({ status: 'failed', changed: false, error: { code: 'PR_REVIEW_PAYLOAD_INVALID', message } })}\n`);
  process.stderr.write(USAGE);
  process.exitCode = 1;
}

function finish(output: PlatformResult): void {
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

function readBodyFile(value: string, cwd: string): string {
  return value === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(path.resolve(cwd, value), 'utf8');
}

function platformPrReview(args: string[] = []): void {
  if (args[0] === '--help' || args[0] === '-h') { process.stdout.write(USAGE); return; }
  const operation = args[0];
  if (!operation || !['inspect', 'list', 'publish'].includes(operation)) { fail('a valid operation is required'); return; }
  const parsed = parse(args, 1);
  if (parsed.error) { fail(parsed.error); return; }
  const values = parsed.values;
  const cwd = path.resolve(typeof values.cwd === 'string' ? values.cwd : process.cwd());
  const allowed: Record<string, string[]> = {
    inspect: ['cwd', 'pr'],
    list: ['cwd', 'pr'],
    publish: ['cwd', 'pr', 'scope', 'round', 'commit', 'event', 'bodyFile', 'dryRun']
  };
  const unexpected = Object.keys(values).find((name) => !allowed[operation]!.includes(name));
  if (unexpected) { fail(`${operation} does not accept --${unexpected}`); return; }
  const pr = Number(values.pr);
  if (!Number.isInteger(pr) || pr <= 0) { fail(`${operation} requires a positive --pr`); return; }
  if (operation === 'inspect') {
    finish(inspectPlatformPullRequestByNumber(pr, { cwd }));
    return;
  }
  if (operation === 'list') {
    finish(listPrReviews(pr, { cwd }));
    return;
  }
  const scope = typeof values.scope === 'string' ? values.scope : '';
  const round = Number(values.round);
  const commit = typeof values.commit === 'string' ? values.commit : '';
  const event = values.event as string;
  if (!scope || !/^(?:pr\d+|TASK-\d{8}-\d{6})$/.test(scope)) { fail('publish requires --scope <taskId|pr{N}>'); return; }
  if (!Number.isInteger(round) || round <= 0) { fail('publish requires a positive --round'); return; }
  if (!/^[0-9a-f]{7,40}$/i.test(commit)) { fail('publish requires --commit <sha>'); return; }
  if (!['COMMENT', 'APPROVE', 'REQUEST_CHANGES'].includes(event)) { fail('publish requires --event <COMMENT|APPROVE|REQUEST_CHANGES>'); return; }
  if (typeof values.bodyFile !== 'string') { fail('publish requires --body-file'); return; }
  let body: string;
  try {
    body = readBodyFile(values.bodyFile, cwd);
  } catch (error) {
    fail(`unable to read body file: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  finish(publishPrReview({
    cwd,
    prNumber: pr,
    identity: { scope, round, commitSha: commit },
    event: event as PrReviewEvent,
    body,
    dryRun: values.dryRun === true
  }));
}

export { platformPrReview };
