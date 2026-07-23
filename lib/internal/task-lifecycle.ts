import { applyTaskLifecycle, lifecycleIntentCatalog } from '../task/lifecycle.ts';
import type { TaskLifecycleRequest } from '../task/lifecycle.ts';

const USAGE = `Usage: agent-infra-internal task-lifecycle <N | TASK-id> <intent> --agent <agent> [intent flags] [--dry-run]\n\nIntents: ${lifecycleIntentCatalog.join(', ')}\n`;
const FLAGS: Record<string, string> = {
  '--agent': 'agent', '--reason': 'reason', '--unblock-condition': 'unblockCondition',
  '--note': 'note', '--alert-number': 'alertNumber', '--staging-dir': 'stagingDir',
  '--issue-number': 'issueNumber'
};

function usageFailure(message: string): void {
  process.stdout.write(`${JSON.stringify({ status: 'failed', changed: false, error: { code: 'LIFECYCLE_PAYLOAD_INVALID', message } })}\n`);
  process.stderr.write(USAGE);
  process.exitCode = 1;
}

function taskLifecycle(args: string[] = []): void {
  if (args[0] === '--help' || args[0] === '-h') { process.stdout.write(USAGE); return; }
  if (args.length < 2) { usageFailure('task ref and intent are required'); return; }
  const values: Record<string, unknown> = { taskRef: args[0], intent: args[1], agent: '' };
  const seen = new Set<string>();
  for (let index = 2; index < args.length; index += 1) {
    const flag = args[index]!;
    if (flag === '--dry-run') {
      if (seen.has(flag)) { usageFailure(`duplicate option '${flag}'`); return; }
      seen.add(flag); values.dryRun = true; continue;
    }
    const key = FLAGS[flag];
    if (!key) { usageFailure(`unknown option '${flag}'`); return; }
    if (seen.has(flag)) { usageFailure(`duplicate option '${flag}'`); return; }
    const value = args[++index];
    if (value === undefined || value.startsWith('--')) { usageFailure(`option '${flag}' requires a value`); return; }
    seen.add(flag);
    values[key] = key === 'alertNumber' || key === 'issueNumber' ? Number(value) : value;
  }
  const result = applyTaskLifecycle(values as TaskLifecycleRequest);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.status === 'failed') process.exitCode = 1;
}

export { taskLifecycle };
