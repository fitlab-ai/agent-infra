import { parseReviewCommand } from '../task/review-command.ts';
import { finalizeReviewSummary, preflightReviewSummary } from '../task/review-finalization.ts';
import { resolveTaskRef } from '../task/resolve-ref.ts';
import { ensureInternalHandlerRoute } from './cli-route-inventory.ts';

const USAGE = 'Usage: agent-infra-internal task-review <task-ref> <preflight|finalize-summary> --stage <analysis|plan|code> --artifact <review-*.md> [--dry-run]\n';

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
  const { stage, artifact, dryRun } = request;
  const operation = args[1]!;
  const resolved = resolveTaskRef(args[0]!);
  if (!resolved.ok) { failUsage(resolved.message); return; }
  const result = operation === 'preflight'
    ? preflightReviewSummary({ taskRef: args[0]!, stage, artifact, dryRun })
    : finalizeReviewSummary({ taskRef: args[0]!, stage, artifact, dryRun });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.status === 'failed') process.exitCode = 1;
}

export { taskReview };
