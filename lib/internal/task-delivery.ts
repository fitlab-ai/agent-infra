import path from 'node:path';

import { normalizeAgentToken, AGENT_USAGE_HINT } from '../agent-clients/tokens.ts';
import { deliverTaskBranch } from '../task/delivery.ts';
import { ensureInternalHandlerRoute, internalHandlerRoute } from './cli-route-inventory.ts';

const USAGE = `Usage: agent-infra-internal task-delivery <task-ref> deliver --agent <agent> [--remote <name>] [--base <branch>] [--dry-run] [--cwd <path>]\n`;

function taskDelivery(args: string[] = []): void {
  if (!ensureInternalHandlerRoute('task-delivery', args)) return;
  const taskRef = args[0];
  const operation = args[1];
  if (!taskRef || !internalHandlerRoute('task-delivery', 'deliver', operation ?? '')) {
    process.stdout.write(`${JSON.stringify({ status: 'failed', changed: false, error: { code: 'DELIVERY_PAYLOAD_INVALID', message: 'task ref and deliver operation are required' } })}\n`);
    process.stderr.write(USAGE);
    process.exitCode = 1;
    return;
  }
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
      process.stdout.write(`${JSON.stringify({ status: 'failed', changed: false, error: { code: 'DELIVERY_PAYLOAD_INVALID', message: `${flag} requires a value` } })}\n`);
      process.exitCode = 1;
      return;
    }
    if (flag === '--agent') agent = value;
    else if (flag === '--remote') remote = value;
    else if (flag === '--base') baseRef = value;
    else if (flag === '--cwd') cwd = path.resolve(value);
    else {
      process.stdout.write(`${JSON.stringify({ status: 'failed', changed: false, error: { code: 'DELIVERY_PAYLOAD_INVALID', message: `unknown option '${flag}'` } })}\n`);
      process.exitCode = 1;
      return;
    }
  }
  const normalized = normalizeAgentToken(agent);
  if (!normalized) {
    process.stdout.write(`${JSON.stringify({ status: 'failed', changed: false, error: { code: 'DELIVERY_PAYLOAD_INVALID', message: `invalid --agent '${agent}': ${AGENT_USAGE_HINT}` } })}\n`);
    process.exitCode = 1;
    return;
  }
  const result = deliverTaskBranch(taskRef, { repoRoot: cwd, agent: normalized, remote, baseRef, dryRun });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.status === 'failed') process.exitCode = 1;
  if (result.status === 'blocked') process.exitCode = 2;
}

export { taskDelivery };
