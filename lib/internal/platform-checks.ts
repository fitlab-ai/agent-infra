import path from 'node:path';

import {
  fetchPlatformCheckLogs,
  inspectPullRequestReadiness,
  resolvePlatformCheckRun,
  watchPullRequestReadiness
} from '../platform/pr-checks.ts';
import type { ChecksResult } from '../platform/pr-checks.ts';
import { ensureInternalHandlerRoute } from './cli-route-inventory.ts';

const USAGE = `Usage: agent-infra-internal platform-checks inspect <task-ref> [--cwd <path>]
       agent-infra-internal platform-checks watch <task-ref> --interval-seconds <N> --deadline-seconds <N> [--cwd <path>]
       agent-infra-internal platform-checks resolve-run <task-ref> --check-name <name> [--details-url <url>] [--cwd <path>]
       agent-infra-internal platform-checks logs <task-ref> --run <id> [--job <id>] [--cwd <path>]
`;

const VALUE_FLAGS = new Set(['--cwd', '--interval-seconds', '--deadline-seconds', '--check-name', '--details-url', '--run', '--job']);

function key(flag: string): string {
  return flag.slice(2).replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

function fail(message: string): void {
  process.stdout.write(`${JSON.stringify({ status: 'failed', changed: false, error: { code: 'CHECKS_PAYLOAD_INVALID', message } })}\n`);
  process.stderr.write(USAGE);
  process.exitCode = 1;
}

function finish(output: ChecksResult): void {
  process.stdout.write(`${JSON.stringify(output)}\n`);
  if (output.status === 'failed') process.exitCode = 1;
  if (output.status === 'blocked') process.exitCode = 2;
}

function parse(args: string[], start: number) {
  const values: Record<string, string> = {};
  const seen = new Set<string>();
  for (let index = start; index < args.length; index += 1) {
    const flag = args[index]!;
    if (!VALUE_FLAGS.has(flag)) return { values, error: `unknown option '${flag}'` };
    if (seen.has(flag)) return { values, error: `duplicate option '${flag}'` };
    seen.add(flag);
    const value = args[++index];
    if (value === undefined || value.startsWith('--')) return { values, error: `option '${flag}' requires a value` };
    values[key(flag)] = value;
  }
  return { values };
}

function positive(value: string | undefined): number | null {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

async function platformChecks(args: string[] = []): Promise<void> {
  if (!ensureInternalHandlerRoute('platform-checks', args)) return;
  if (args[0] === '--help' || args[0] === '-h') { process.stdout.write(USAGE); return; }
  const operation = args[0];
  if (!operation || !['inspect', 'watch', 'resolve-run', 'logs'].includes(operation)) { fail('a valid operation is required'); return; }
  const taskRef = args[1];
  if (!taskRef || taskRef.startsWith('--')) { fail(`${operation} requires a task ref`); return; }
  const parsed = parse(args, 2);
  if (parsed.error) { fail(parsed.error); return; }
  const values = parsed.values;
  const cwd = path.resolve(values.cwd || process.cwd());
  const allowed: Record<string, string[]> = {
    inspect: ['cwd'],
    watch: ['cwd', 'intervalSeconds', 'deadlineSeconds'],
    'resolve-run': ['cwd', 'checkName', 'detailsUrl'],
    logs: ['cwd', 'run', 'job']
  };
  const unexpected = Object.keys(values).find((name) => !allowed[operation]!.includes(name));
  if (unexpected) { fail(`${operation} does not accept --${unexpected}`); return; }
  if (operation === 'inspect') { finish(await inspectPullRequestReadiness(taskRef, { cwd })); return; }
  if (operation === 'resolve-run') {
    if (!values.checkName) { fail('resolve-run requires --check-name'); return; }
    finish(await resolvePlatformCheckRun(taskRef, { cwd, checkName: values.checkName, detailsUrl: values.detailsUrl }));
    return;
  }
  if (operation === 'logs') {
    const run = positive(values.run);
    const job = values.job === undefined ? undefined : positive(values.job);
    if (!run || values.job !== undefined && !job) { fail('logs requires a positive --run and optional positive --job'); return; }
    finish(await fetchPlatformCheckLogs(taskRef, { cwd, run, job: job || undefined }));
    return;
  }
  const intervalSeconds = positive(values.intervalSeconds);
  const deadlineSeconds = positive(values.deadlineSeconds);
  if (!intervalSeconds || !deadlineSeconds) { fail('watch requires positive --interval-seconds and --deadline-seconds'); return; }
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  try {
    finish(await watchPullRequestReadiness(taskRef, { cwd, intervalSeconds, deadlineSeconds, signal: controller.signal }));
  } finally {
    process.removeListener('SIGINT', abort);
    process.removeListener('SIGTERM', abort);
  }
}

export { platformChecks };
