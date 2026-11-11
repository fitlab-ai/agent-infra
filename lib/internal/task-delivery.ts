import path from 'node:path';

import { normalizeAgentToken, AGENT_USAGE_HINT } from '../agent-clients/tokens.ts';
import { deliverTaskBranch } from '../task/delivery.ts';
import { ensureInternalHandlerRoute, internalHandlerRoute } from './cli-route-inventory.ts';

const USAGE = `Usage: agent-infra-internal task-delivery <task-ref> deliver --agent <agent> [--remote <name>] [--base <branch>] [--dry-run] [--cwd <path>]\n`;

type DeliveryOptions = {
  agent: string;
  remote: string | undefined;
  baseRef: string | undefined;
  cwd: string;
  dryRun: boolean;
};

type ParsedDeliveryOptions =
  | { ok: true; options: DeliveryOptions }
  | { ok: false; message: string };

function writeInvalidPayload(message: string, includeUsage = false): void {
  process.stdout.write(`${JSON.stringify({ status: 'failed', changed: false, error: { code: 'DELIVERY_PAYLOAD_INVALID', message } })}\n`);
  if (includeUsage) process.stderr.write(USAGE);
  process.exitCode = 1;
}

function parseDeliveryOptions(args: string[]): ParsedDeliveryOptions {
  let agent = '';
  let remote: string | undefined;
  let baseRef: string | undefined;
  let cwd = process.cwd();
  let dryRun = false;
  for (let index = 2; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === '--dry-run') { dryRun = true; continue; }
    const value = args[++index];
    if (value === undefined || value.startsWith('--')) {
      return { ok: false, message: `${flag} requires a value` };
    }
    if (flag === '--agent') agent = value;
    else if (flag === '--remote') remote = value;
    else if (flag === '--base') baseRef = value;
    else if (flag === '--cwd') cwd = path.resolve(value);
    else return { ok: false, message: `unknown option '${flag}'` };
  }
  return { ok: true, options: { agent, remote, baseRef, cwd, dryRun } };
}

function taskDelivery(args: string[] = []): void {
  if (!ensureInternalHandlerRoute('task-delivery', args)) return;
  const taskRef = args[0];
  const operation = args[1];
  if (!taskRef || !internalHandlerRoute('task-delivery', 'deliver', operation ?? '')) {
    writeInvalidPayload('task ref and deliver operation are required', true);
    return;
  }
  const parsed = parseDeliveryOptions(args);
  if (!parsed.ok) {
    writeInvalidPayload(parsed.message);
    return;
  }
  const { agent, remote, baseRef, cwd, dryRun } = parsed.options;
  const normalized = normalizeAgentToken(agent);
  if (!normalized) {
    writeInvalidPayload(`invalid --agent '${agent}': ${AGENT_USAGE_HINT}`);
    return;
  }
  const result = deliverTaskBranch(taskRef, { repoRoot: cwd, agent: normalized, remote, baseRef, dryRun });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.status === 'failed') process.exitCode = 1;
  if (result.status === 'blocked') process.exitCode = 2;
}

export { taskDelivery };
