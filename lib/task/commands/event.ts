import { applyTaskEvent, eventCatalog } from '../events.ts';
import type { TaskEventRequest, Verdict } from '../events.ts';

const USAGE = `Usage: ai task event <N | #N | TASK-id> <event> --agent <agent> [event options] [--dry-run]

Apply one closed-set task lifecycle event and print a structured JSON result.
Events: ${eventCatalog.join(', ')}
`;

const FLAGS: Record<string, keyof TaskEventRequest> = {
  '--agent': 'agent', '--round': 'round', '--question': 'question', '--artifact': 'artifact',
  '--fix-for': 'fixFor', '--verdict': 'verdict', '--blockers': 'blockers', '--major': 'major',
  '--minor': 'minor', '--manual-validation': 'manualValidation', '--files-modified': 'filesModified',
  '--tests-passed': 'testsPassed'
};
const NUMERIC = new Set(['round', 'question', 'blockers', 'major', 'minor', 'manualValidation', 'filesModified', 'testsPassed']);

function usageFailure(message: string): void {
  process.stdout.write(`${JSON.stringify({ status: 'failed', changed: false, error: { code: 'EVENT_PAYLOAD_INVALID', message } })}\n`);
  process.stderr.write(USAGE);
  process.exitCode = 1;
}

function event(args: string[] = []): void {
  if (args[0] === '--help' || args[0] === '-h') { process.stdout.write(USAGE); return; }
  if (args.length < 2) { usageFailure('task ref and event are required'); return; }
  const request: TaskEventRequest = { taskRef: args[0]!, event: args[1]!, agent: '' };
  const seen = new Set<string>();
  for (let index = 2; index < args.length; index += 1) {
    const flag = args[index]!;
    if (flag === '--dry-run') {
      if (seen.has(flag)) { usageFailure(`duplicate option '${flag}'`); return; }
      seen.add(flag); request.dryRun = true; continue;
    }
    const key = FLAGS[flag];
    if (!key) { usageFailure(`unknown option '${flag}'`); return; }
    if (seen.has(flag)) { usageFailure(`duplicate option '${flag}'`); return; }
    const value = args[++index];
    if (value === undefined || value.startsWith('--')) { usageFailure(`option '${flag}' requires a value`); return; }
    seen.add(flag);
    if (NUMERIC.has(key)) (request as Record<string, unknown>)[key] = Number(value);
    else if (key === 'verdict') request.verdict = value as Verdict;
    else (request as Record<string, unknown>)[key] = value;
  }
  const result = applyTaskEvent(request);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.status === 'failed') process.exitCode = 1;
}

export { event };
