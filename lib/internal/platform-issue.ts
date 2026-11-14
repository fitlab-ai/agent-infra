import path from 'node:path';

import { normalizeAgentToken, AGENT_USAGE_HINT } from '../agent-clients/tokens.ts';
import {
  bindPlatformIssue,
  createPlatformIssue,
  inspectPlatformIssue,
  syncPlatformIssue
} from '../platform/issues.ts';
import type { IssueResult } from '../platform/issues.ts';
import { ensureInternalHandlerRoute, internalHandlerRoute } from './cli-route-inventory.ts';

const USAGE = `Usage: agent-infra-internal platform-issue inspect <task-ref> [--cwd <path>]
       agent-infra-internal platform-issue create <task-ref> --agent <agent> [--dry-run] [--cwd <path>]
       agent-infra-internal platform-issue bind <task-ref> --issue <token> --agent <agent> [--dry-run] [--cwd <path>]
       agent-infra-internal platform-issue sync <task-ref> --agent <agent> [--status <suffix|none>] [--assignees current|none] [--milestone initial|specific|none] [--issue-type] [--fields] [--requirements] [--in-labels from-diff|none] [--base <branch>] [--state open|closed] [--close-reason completed|not_planned] [--dry-run] [--cwd <path>]
`;

const BOOLEAN_FLAGS = new Set(['--dry-run', '--issue-type', '--fields', '--requirements']);
const VALUE_FLAGS = new Set([
  '--cwd', '--agent', '--issue', '--status', '--assignees', '--milestone', '--in-labels', '--base', '--state', '--close-reason'
]);

function key(flag: string): string {
  return flag.slice(2).replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

function fail(message: string): void {
  process.stdout.write(`${JSON.stringify({ status: 'failed', changed: false, error: { code: 'ISSUE_PAYLOAD_INVALID', message } })}\n`);
  process.stderr.write(USAGE);
  process.exitCode = 1;
}

function finish(output: IssueResult): void {
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
    if (!value || value.startsWith('--')) return { values, error: `option '${flag}' requires a value` };
    values[key(flag)] = value;
  }
  return { values };
}

function oneOf(values: Record<string, string | boolean>, name: string, allowed: string[]): string | undefined {
  const value = values[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !allowed.includes(value)) throw new Error(`--${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)} must be one of ${allowed.join('|')}`);
  return value;
}

async function syncIssue(taskRef: string, values: Record<string, string | boolean>, cwd: string): Promise<void> {
  try {
    const assignees = oneOf(values, 'assignees', ['current', 'none']);
    const milestone = oneOf(values, 'milestone', ['initial', 'specific', 'none']);
    const inLabels = oneOf(values, 'inLabels', ['from-diff', 'none']);
    const state = oneOf(values, 'state', ['open', 'closed']);
    const closeReason = oneOf(values, 'closeReason', ['completed', 'not_planned']);
    if (inLabels === 'from-diff' && typeof values.base !== 'string') throw new Error('--in-labels from-diff requires --base');
    if (inLabels !== 'from-diff' && values.base !== undefined) throw new Error('--base requires --in-labels from-diff');
    if (closeReason && state !== 'closed') throw new Error('--close-reason requires --state closed');
    const desiredKeys = ['status', 'assignees', 'milestone', 'issueType', 'fields', 'requirements', 'inLabels', 'state'];
    if (!desiredKeys.some((name) => values[name] !== undefined)) throw new Error('sync requires at least one desired-state option');
    finish(await syncPlatformIssue(taskRef, {
      cwd, agent: values.agent as string, dryRun: values.dryRun === true,
      status: typeof values.status === 'string' ? values.status : undefined,
      assignees: assignees as 'current' | 'none' | undefined,
      milestone: milestone as 'initial' | 'specific' | 'none' | undefined,
      issueType: values.issueType === true,
      fields: values.fields === true,
      requirements: values.requirements === true,
      inLabels: inLabels as 'from-diff' | 'none' | undefined,
      base: typeof values.base === 'string' ? values.base : undefined,
      state: state as 'open' | 'closed' | undefined,
      closeReason: closeReason as 'completed' | 'not_planned' | undefined
    }));
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

async function writeIssueOperation(
  operation: string, taskRef: string, values: Record<string, string | boolean>, cwd: string, agent: string
): Promise<boolean> {
  if (internalHandlerRoute('platform-issue', 'create', operation)) {
    finish(await createPlatformIssue(taskRef, { cwd, agent, dryRun: values.dryRun === true }));
    return true;
  }
  if (internalHandlerRoute('platform-issue', 'bind', operation)) {
    if (typeof values.issue !== 'string' || !values.issue) { fail('bind requires --issue <token>'); return true; }
    finish(await bindPlatformIssue(taskRef, { cwd, agent, issue: values.issue, dryRun: values.dryRun === true }));
    return true;
  }
  return false;
}

function validIssueOperation(operation: string | undefined): operation is string {
  return Boolean(operation && [
    internalHandlerRoute('platform-issue', 'inspect', operation),
    internalHandlerRoute('platform-issue', 'create', operation),
    internalHandlerRoute('platform-issue', 'bind', operation),
    internalHandlerRoute('platform-issue', 'sync', operation)
  ].some(Boolean));
}

function validateIssueOptions(operation: string, values: Record<string, string | boolean>): boolean {
  const allowed: Record<string, string[]> = {
    inspect: ['cwd'], create: ['cwd', 'agent', 'dryRun'], bind: ['cwd', 'agent', 'dryRun', 'issue'],
    sync: ['cwd', 'agent', 'dryRun', 'status', 'assignees', 'milestone', 'issueType', 'fields', 'requirements', 'inLabels', 'base', 'state', 'closeReason']
  };
  const unexpected = Object.keys(values).find((name) => !allowed[operation]!.includes(name));
  if (!unexpected) return true;
  fail(`${operation} does not accept --${unexpected}`);
  return false;
}

async function handleReadOnlyOperation(operation: string, taskRef: string, cwd: string): Promise<boolean> {
  if (!internalHandlerRoute('platform-issue', 'inspect', operation)) return false;
  finish(await inspectPlatformIssue(taskRef, { cwd }));
  return true;
}

function readTaskRef(operation: string, args: string[]): string | undefined {
  const taskRef = args[1];
  if (taskRef && !taskRef.startsWith('--')) return taskRef;
  fail(`${operation} requires a task ref`);
  return undefined;
}

async function platformIssue(args: string[] = []): Promise<void> {
  if (!ensureInternalHandlerRoute('platform-issue', args)) return;
  if (args[0] === '--help' || args[0] === '-h') { process.stdout.write(USAGE); return; }
  const operation = args[0];
  if (!validIssueOperation(operation)) { fail('a valid operation is required'); return; }
  const taskRef = readTaskRef(operation, args);
  if (!taskRef) return;
  const parsed = parse(args, 2);
  if (parsed.error) { fail(parsed.error); return; }
  const values = parsed.values;
  const cwd = path.resolve(typeof values.cwd === 'string' ? values.cwd : process.cwd());
  if (!validateIssueOptions(operation, values)) return;
  if (await handleReadOnlyOperation(operation, taskRef, cwd)) return;
  if (typeof values.agent !== 'string' || !values.agent) { fail(`${operation} requires --agent`); return; }
  const agent = normalizeAgentToken(values.agent);
  if (!agent) { fail(`invalid --agent '${values.agent}': ${AGENT_USAGE_HINT}`); return; }
  if (await writeIssueOperation(operation, taskRef, values, cwd, agent)) return;
  values.agent = agent;
  await syncIssue(taskRef, values, cwd);
}

export { platformIssue };
