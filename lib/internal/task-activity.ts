import {
  applyPrReviewActivityIntent,
  inspectPrReviewActivity
} from '../task/activity-intent.ts';
import type {
  PrReviewActivityIntent,
  PrReviewInspectIntent
} from '../task/activity-intent.ts';
import { resolveTaskRef } from '../task/resolve-ref.ts';
import { ensureInternalHandlerRoute, internalHandlerRoute } from './cli-route-inventory.ts';

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

type ActivityValues = Record<string, unknown> & { kind: string; taskRef: string };
type ActivityArguments = { values: ActivityValues } | { error: string };

function parseActivityOptions(args: string[], values: ActivityValues): string | null {
  const seen = new Set<string>();
  for (let index = 2; index < args.length; index += 1) {
    const flag = args[index]!;
    if (flag === '--dry-run') {
      if (seen.has(flag)) return `duplicate option '${flag}'`;
      seen.add(flag);
      values.dryRun = true;
      continue;
    }
    const key = FLAGS[flag];
    if (!key) return `unknown option '${flag}'`;
    if (seen.has(flag)) return `duplicate option '${flag}'`;
    const value = args[++index];
    if (value === undefined || value.startsWith('--')) return `option '${flag}' requires a value`;
    seen.add(flag);
    values[key] = ['blockers', 'major', 'minor'].includes(key) ? Number(value) : value;
  }
  return null;
}

function validateActivityValues(kind: string, values: ActivityValues): string | null {
  const allowed = ALLOWED[kind]!;
  const unexpected = Object.keys(values).find((key) => !allowed.has(key));
  if (unexpected) return `${kind} does not accept '${unexpected}'`;
  if (kind === 'pr-review-inspect') return null;
  for (const key of COMMON) {
    if (values[key] === undefined) return `${kind} requires '${key}'`;
  }
  const required = kind === 'pr-review-complete'
    ? ['verdict', 'blockers', 'major', 'minor']
    : kind === 'pr-review-terminate' ? ['outcome', 'reason'] : [];
  for (const key of required) {
    if (values[key] === undefined) return `${kind} requires '${key}'`;
  }
  return null;
}

function parseActivityArguments(args: string[]): ActivityArguments {
  const [taskRef, kind] = args;
  if (!taskRef || taskRef.startsWith('--') || !kind || !OPERATIONS.has(kind)
    || ![
      internalHandlerRoute('task-activity', 'pr-review-inspect', kind),
      internalHandlerRoute('task-activity', 'pr-review-start', kind),
      internalHandlerRoute('task-activity', 'pr-review-complete', kind),
      internalHandlerRoute('task-activity', 'pr-review-terminate', kind)
    ].some(Boolean)) return { error: 'task ref and a supported PR review intent are required' };
  const values: ActivityValues = { kind, taskRef };
  const optionError = parseActivityOptions(args, values);
  if (optionError) return { error: optionError };
  const validationError = validateActivityValues(kind, values);
  return validationError ? { error: validationError } : { values };
}

async function taskActivity(args: string[] = []): Promise<void> {
  if (!ensureInternalHandlerRoute('task-activity', args)) return;
  if (args[0] === '--help' || args[0] === '-h') { process.stdout.write(USAGE); return; }
  const parsed = parseActivityArguments(args);
  if ('error' in parsed) { usageFailure(parsed.error); return; }
  const { values } = parsed;
  if (values.kind === 'pr-review-inspect') {
    const result = inspectPrReviewActivity(values as PrReviewInspectIntent);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.status === 'failed') process.exitCode = 1;
    return;
  }
  const resolved = resolveTaskRef(values.taskRef);
  if (!resolved.ok) { usageFailure(resolved.message); return; }
  const result = await applyPrReviewActivityIntent(values as PrReviewActivityIntent);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.status === 'failed') process.exitCode = 1;
}

export { taskActivity };
