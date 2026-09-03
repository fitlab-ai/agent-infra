import fs from 'node:fs';
import path from 'node:path';

import { normalizeAgentToken, AGENT_USAGE_HINT } from '../agent-clients/tokens.ts';
import {
  checkPlatformCommentOwner,
  listPlatformComments,
  syncPlatformComment
} from '../platform/issue-comments.ts';
import type { CommentKind } from '../platform/issue-comments.ts';
import type { PlatformResult } from '../platform/types.ts';
import { backfillCompletionComments } from '../platform/completion-backfill.ts';

const USAGE = `Usage: agent-infra-internal platform-comment list --issue <token> [--cwd <path>]
       agent-infra-internal platform-comment owner <task-ref> [--cwd <path>]
       agent-infra-internal platform-comment backfill <task-ref> --agent <agent> [--cwd <path>]
       agent-infra-internal platform-comment sync <task-ref> --kind <kind> --agent <agent> [--artifact <file>] [--body-file <path|->] [--status-label <label>] [--backfill] [--cwd <path>]
`;

function fail(message: string): void {
  process.stdout.write(`${JSON.stringify({ status: 'failed', changed: false, error: { code: 'COMMENT_PAYLOAD_INVALID', message } })}\n`);
  process.stderr.write(USAGE);
  process.exitCode = 1;
}

function finish(result: PlatformResult): void {
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.status === 'failed') process.exitCode = 1;
  if (result.status === 'blocked') process.exitCode = 2;
}

function parseFlags(args: string[], start: number): { values: Record<string, string | boolean>; error?: string } {
  const values: Record<string, string | boolean> = {};
  const seen = new Set<string>();
  for (let index = start; index < args.length; index += 1) {
    const flag = args[index]!;
    if (!['--issue', '--cwd', '--kind', '--agent', '--artifact', '--body-file', '--status-label', '--backfill'].includes(flag)) {
      return { values, error: `unknown option '${flag}'` };
    }
    if (seen.has(flag)) return { values, error: `duplicate option '${flag}'` };
    seen.add(flag);
    if (flag === '--backfill') { values.backfill = true; continue; }
    const value = args[++index];
    if (value === undefined || value.startsWith('--')) return { values, error: `option '${flag}' requires a value` };
    values[flag.slice(2).replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase())] = value;
  }
  return { values };
}

function readBodyFile(value: string, cwd: string): string {
  if (value === '-') return fs.readFileSync(0, 'utf8');
  return fs.readFileSync(path.resolve(cwd, value), 'utf8');
}

async function platformComment(args: string[] = []): Promise<void> {
  if (args[0] === '--help' || args[0] === '-h') { process.stdout.write(USAGE); return; }
  const operation = args[0];
  if (!operation || !['list', 'owner', 'backfill', 'sync'].includes(operation)) { fail('a valid operation is required'); return; }
  const hasTaskRef = operation !== 'list';
  const taskRef = hasTaskRef ? args[1] : undefined;
  if (hasTaskRef && (!taskRef || taskRef.startsWith('--'))) { fail(`${operation} requires a task ref`); return; }
  const parsed = parseFlags(args, hasTaskRef ? 2 : 1);
  if (parsed.error) { fail(parsed.error); return; }
  const cwd = path.resolve(typeof parsed.values.cwd === 'string' ? parsed.values.cwd : process.cwd());
  if (operation === 'list') {
    const issue = parsed.values.issue;
    if (typeof issue !== 'string' || !issue) { fail('list requires --issue <token>'); return; }
    const unexpected = Object.keys(parsed.values).find((key) => !['issue', 'cwd'].includes(key));
    if (unexpected) { fail(`list does not accept '--${unexpected}'`); return; }
    finish(await listPlatformComments(issue, cwd));
    return;
  }
  if (operation === 'owner') {
    const unexpected = Object.keys(parsed.values).find((key) => key !== 'cwd');
    if (unexpected) { fail(`owner does not accept '--${unexpected}'`); return; }
    finish(await checkPlatformCommentOwner(taskRef!, { cwd }));
    return;
  }
  if (operation === 'backfill') {
    const unexpected = Object.keys(parsed.values).find((key) => !['cwd', 'agent'].includes(key));
    if (unexpected) { fail(`backfill does not accept '--${unexpected}'`); return; }
    const agent = parsed.values.agent;
    if (typeof agent !== 'string' || !agent) { fail('backfill requires --agent'); return; }
    const normalizedAgent = normalizeAgentToken(agent);
    if (!normalizedAgent) { fail(`invalid --agent '${agent}': ${AGENT_USAGE_HINT}`); return; }
    finish(await backfillCompletionComments(taskRef!, { cwd, agent: normalizedAgent }));
    return;
  }
  const kind = parsed.values.kind;
  const agent = parsed.values.agent;
  if (!['task', 'artifact', 'summary', 'cancel'].includes(String(kind))) { fail('sync requires a valid --kind'); return; }
  if (typeof agent !== 'string' || !agent) { fail('sync requires --agent'); return; }
  const normalizedAgent = normalizeAgentToken(agent);
  if (!normalizedAgent) { fail(`invalid --agent '${agent}': ${AGENT_USAGE_HINT}`); return; }
  if (kind === 'artifact' && typeof parsed.values.artifact !== 'string') { fail('artifact sync requires --artifact'); return; }
  if ((kind === 'summary' || kind === 'cancel') && typeof parsed.values.bodyFile !== 'string') { fail(`${kind} sync requires --body-file`); return; }
  let body: string | undefined;
  try {
    if (typeof parsed.values.bodyFile === 'string') body = readBodyFile(parsed.values.bodyFile, cwd);
  } catch (error) {
    fail(`unable to read body file: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  finish(await syncPlatformComment(taskRef!, {
    kind: kind as CommentKind,
    agent: normalizedAgent,
    artifact: typeof parsed.values.artifact === 'string' ? parsed.values.artifact : undefined,
    body,
    backfill: parsed.values.backfill === true,
    cwd
  }));
}

export { platformComment };
