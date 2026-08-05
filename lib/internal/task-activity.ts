import { applyActivityAppendIntent } from '../task/activity-intent.ts';
import type { ActivityAppendIntent } from '../task/activity-intent.ts';

const USAGE = `Usage: agent-infra-internal task-activity <task-ref> append --step <step> --agent <agent> --note <note> [--artifact <canonical.md>] [--dry-run]
`;
const FLAGS: Record<string, string> = {
  '--step': 'step',
  '--agent': 'agent',
  '--note': 'note',
  '--artifact': 'artifact'
};

function usageFailure(message: string): void {
  process.stdout.write(`${JSON.stringify({ status: 'failed', changed: false, error: { code: 'ACTIVITY_PAYLOAD_INVALID', message } })}\n`);
  process.stderr.write(USAGE);
  process.exitCode = 1;
}

function taskActivity(args: string[] = []): void {
  if (args[0] === '--help' || args[0] === '-h') { process.stdout.write(USAGE); return; }
  const [taskRef, kind] = args;
  if (!taskRef || taskRef.startsWith('--') || !kind || kind !== 'append') {
    usageFailure('task ref and the append intent are required');
    return;
  }
  const values: Record<string, unknown> = { kind, taskRef };
  const seen = new Set<string>();
  for (let index = 2; index < args.length; index += 1) {
    const flag = args[index]!;
    if (flag === '--dry-run') {
      if (seen.has(flag)) { usageFailure(`duplicate option '${flag}'`); return; }
      seen.add(flag);
      values.dryRun = true;
      continue;
    }
    const key = FLAGS[flag];
    if (!key) { usageFailure(`unknown option '${flag}'`); return; }
    if (seen.has(flag)) { usageFailure(`duplicate option '${flag}'`); return; }
    const value = args[++index];
    if (value === undefined || value.startsWith('--')) { usageFailure(`option '${flag}' requires a value`); return; }
    seen.add(flag);
    values[key] = value;
  }
  const allowed = new Set(['kind', 'taskRef', 'dryRun', 'step', 'agent', 'note', 'artifact']);
  const unexpected = Object.keys(values).find((key) => !allowed.has(key));
  if (unexpected) { usageFailure(`append does not accept '${unexpected}'`); return; }
  for (const key of ['step', 'agent', 'note']) {
    if (values[key] === undefined) { usageFailure(`append requires '${key}'`); return; }
  }
  const result = applyActivityAppendIntent(values as ActivityAppendIntent);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.status === 'failed') process.exitCode = 1;
}

export { taskActivity };
