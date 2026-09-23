import { parseReviewCommand } from '../task/review-command.ts';
import { finalizeReviewSummary, preflightReviewSummary } from '../task/review-finalization.ts';
import { resolveTaskRef } from '../task/resolve-ref.ts';
import { TaskExecutionLockError, withTaskExecutionLock } from '../task/task-execution-lock.ts';
import { ensureInternalHandlerRoute } from './cli-route-inventory.ts';

const USAGE = 'Usage: agent-infra-internal task-review <task-ref> <preflight|finalize-summary> --stage <analysis|plan|code> --artifact <review-*.md> [--orchestrated] [--dry-run] [--override-ticket <ticket> --override-target <target> --override-scope <scope>]\n';

function failUsage(message: string): void {
  process.stdout.write(`${JSON.stringify({
    status: 'failed',
    changed: false,
    intent: 'review-operation',
    error: { code: 'REVIEW_PAYLOAD_INVALID', message }
  })}\n`);
  process.stderr.write(USAGE);
  process.exitCode = 2;
}

async function taskReview(args: string[] = []): Promise<void> {
  if (!ensureInternalHandlerRoute('task-review', args)) return;
  if (args[0] === '--help' || args[0] === '-h') {
    process.stdout.write(USAGE);
    return;
  }
  let request;
  try { request = parseReviewCommand(args); }
  catch (error) { failUsage(error instanceof Error ? error.message : String(error)); return; }
  const { stage, artifact, dryRun, orchestrated } = request;
  const operation = args[1]!;
  const resolved = resolveTaskRef(args[0]!);
  if (!resolved.ok) { failUsage(resolved.message); return; }
  let result;
  try {
    result = await withTaskExecutionLock(resolved.repoRoot, resolved.taskId, `task-review.${operation}`, async () => {
      return operation === 'preflight'
        ? preflightReviewSummary({ taskRef: args[0]!, stage, artifact, orchestrated, dryRun }, { lockAlreadyHeld: true })
        : finalizeReviewSummary({ taskRef: args[0]!, stage, artifact, orchestrated, dryRun }, { lockAlreadyHeld: true });
    });
  } catch (error) {
    if (!(error instanceof TaskExecutionLockError)) throw error;
    process.stdout.write(`${JSON.stringify({ status: 'failed', changed: false, error: { code: error.code, message: error.message } })}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.status === 'failed') process.exitCode = 1;
}

export { taskReview };
