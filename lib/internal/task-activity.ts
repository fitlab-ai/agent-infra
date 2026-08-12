import {
  applyPrReviewActivityIntent,
  inspectPrReviewActivity
} from '../task/activity-intent.ts';
import type {
  PrReviewActivityIntent,
  PrReviewInspectIntent
} from '../task/activity-intent.ts';

const USAGE = `Usage: agent-infra-internal task-activity <task-ref> pr-review-inspect
       agent-infra-internal task-activity <task-ref> pr-review-start --agent <agent> --artifact <canonical.md> --head <40hex> [--dry-run]
       agent-infra-internal task-activity <task-ref> pr-review-complete --agent <agent> --artifact <canonical.md> --head <40hex> --verdict <approved|changes-requested|commented> --blockers <N> --major <N> --minor <N> [--dry-run]
       agent-infra-internal task-activity <task-ref> pr-review-terminate --agent <agent> --artifact <canonical.md> --head <40hex> --outcome <aborted|superseded> --reason <single-line> [--dry-run]
`;

const OPERATIONS = new Set(['pr-review-inspect', 'pr-review-start', 'pr-review-complete', 'pr-review-terminate']);
const FLAGS: Record<string, string> = {
  '--agent': 'agent',
  '--artifact': 'artifact',
  '--head': 'head',
  '--verdict': 'verdict',
  '--blockers': 'blockers',
  '--major': 'major',
  '--minor': 'minor',
  '--outcome': 'outcome',
  '--reason': 'reason'
};
const COMMON = ['agent', 'artifact', 'head'] as const;
const ALLOWED: Record<string, ReadonlySet<string>> = {
  'pr-review-inspect': new Set(['kind', 'taskRef']),
  'pr-review-start': new Set(['kind', 'taskRef', 'agent', 'artifact', 'head', 'dryRun']),
  'pr-review-complete': new Set(['kind', 'taskRef', 'agent', 'artifact', 'head', 'verdict', 'blockers', 'major', 'minor', 'dryRun']),
  'pr-review-terminate': new Set(['kind', 'taskRef', 'agent', 'artifact', 'head', 'outcome', 'reason', 'dryRun'])
};

function usageFailure(message: string): void {
  process.stdout.write(`${JSON.stringify({ status: 'failed', changed: false, error: { code: 'ACTIVITY_PAYLOAD_INVALID', message } })}\n`);
  process.stderr.write(USAGE);
  process.exitCode = 1;
}

function taskActivity(args: string[] = []): void {
  if (args[0] === '--help' || args[0] === '-h') { process.stdout.write(USAGE); return; }
  const [taskRef, kind] = args;
  if (!taskRef || taskRef.startsWith('--') || !kind || !OPERATIONS.has(kind)) {
    usageFailure('task ref and a supported PR review intent are required');
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
    values[key] = ['blockers', 'major', 'minor'].includes(key) ? Number(value) : value;
  }

  const allowed = ALLOWED[kind]!;
  const unexpected = Object.keys(values).find((key) => !allowed.has(key));
  if (unexpected) { usageFailure(`${kind} does not accept '${unexpected}'`); return; }
  if (kind === 'pr-review-inspect') {
    const result = inspectPrReviewActivity(values as PrReviewInspectIntent);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.status === 'failed') process.exitCode = 1;
    return;
  }
  for (const key of COMMON) {
    if (values[key] === undefined) { usageFailure(`${kind} requires '${key}'`); return; }
  }
  const operationRequired = kind === 'pr-review-complete'
    ? ['verdict', 'blockers', 'major', 'minor']
    : kind === 'pr-review-terminate' ? ['outcome', 'reason'] : [];
  for (const key of operationRequired) {
    if (values[key] === undefined) { usageFailure(`${kind} requires '${key}'`); return; }
  }
  const result = applyPrReviewActivityIntent(values as PrReviewActivityIntent);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.status === 'failed') process.exitCode = 1;
}

export { taskActivity };
