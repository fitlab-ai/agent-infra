import { finalizeReviewSummary } from '../task/review-finalization.ts';
import { consumeHumanOverride, failureId, overrideDryRunConflict } from '../task/human-override.ts';
import { resolveTaskRef } from '../task/resolve-ref.ts';
import { TaskExecutionLockError, withTaskExecutionLock } from '../task/task-execution-lock.ts';

const USAGE = 'Usage: agent-infra-internal task-review <task-ref> finalize-summary --stage <analysis|plan|code> --artifact <review-*.md> [--orchestrated] [--dry-run] [--override-ticket <ticket> --override-target <target> --override-scope <scope>]\n';

function failUsage(message: string): void {
  process.stdout.write(`${JSON.stringify({
    status: 'failed',
    changed: false,
    intent: 'finalize-summary',
    error: { code: 'REVIEW_PAYLOAD_INVALID', message }
  })}\n`);
  process.stderr.write(USAGE);
  process.exitCode = 2;
}

function taskReview(args: string[] = []): void {
  if (args[0] === '--help' || args[0] === '-h') {
    process.stdout.write(USAGE);
    return;
  }
  if (args.length < 2) {
    failUsage('task ref and intent are required');
    return;
  }
  if (args[1] !== 'finalize-summary') {
    failUsage(`unknown intent '${args[1]}'`);
    return;
  }
  let stage = '';
  let artifact = '';
  let dryRun = false;
  let orchestrated = false;
  let overrideTicket = '';
  let overrideTarget = '';
  let overrideScope = '';
  const seen = new Set<string>();
  for (let index = 2; index < args.length; index += 1) {
    const flag = args[index]!;
    if (!['--stage', '--artifact', '--orchestrated', '--dry-run', '--override-ticket', '--override-target', '--override-scope'].includes(flag)) {
      failUsage(`unknown option '${flag}'`);
      return;
    }
    if (seen.has(flag)) {
      failUsage(`duplicate option '${flag}'`);
      return;
    }
    seen.add(flag);
    if (flag === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (flag === '--orchestrated') {
      orchestrated = true;
      continue;
    }
    const value = args[++index];
    if (!value || value.startsWith('--')) {
      failUsage(`option '${flag}' requires a value`);
      return;
    }
    if (flag === '--stage') stage = value;
    else if (flag === '--artifact') artifact = value;
    else if (flag === '--override-ticket') overrideTicket = value;
    else if (flag === '--override-target') overrideTarget = value;
    else if (flag === '--override-scope') overrideScope = value;
  }
  if (!stage || !artifact) {
    failUsage("options '--stage' and '--artifact' are required");
    return;
  }
  const dryRunConflict = overrideDryRunConflict({ dryRun, overrideTicket, overrideTarget, overrideScope });
  if (dryRunConflict) { failUsage(dryRunConflict.message); return; }
  const resolved = resolveTaskRef(args[0]!);
  if (!resolved.ok) { failUsage(resolved.message); return; }
  let result;
  let humanOverride: unknown = null;
  try {
    result = withTaskExecutionLock(resolved.repoRoot, resolved.taskId, 'task-review.finalize-summary', () => {
      let current = finalizeReviewSummary({ taskRef: args[0]!, stage, artifact, orchestrated, dryRun }, { lockAlreadyHeld: true });
      if (current.status !== 'failed' || !overrideTicket) return current;
      if (!overrideTarget || !overrideScope) { failUsage('override ticket requires target and scope'); return current; }
      const consumed = consumeHumanOverride({
        taskRef: args[0]!, ticketId: overrideTicket,
        failureId: failureId('review-finalization', current.error?.code ?? 'TASK_STATE_MISMATCH'),
        target: overrideTarget, scope: overrideScope
      }, {
        effectExecutor: (capability) => {
          const retried = finalizeReviewSummary({ taskRef: args[0]!, stage, artifact, orchestrated, dryRun }, { lockAlreadyHeld: true, manualOverride: capability });
          current = retried;
          return retried.status === 'failed' || retried.status === 'planned'
            ? { code: 'OVERRIDE_EFFECT_FAILED', message: retried.status === 'planned' ? 'producer returned planned; no review effect was committed' : `${retried.error?.code ?? 'REVIEW_FAILED'}: ${retried.error?.message ?? 'manual review effect failed'}` }
            : null;
        }
      });
      humanOverride = consumed;
      return current;
    });
  } catch (error) {
    if (!(error instanceof TaskExecutionLockError)) throw error;
    process.stdout.write(`${JSON.stringify({ status: 'failed', changed: false, error: { code: error.code, message: error.message } })}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`${JSON.stringify(humanOverride ? { ...result, humanOverride } : result)}\n`);
  const overrideFailed = Boolean(
    humanOverride && typeof humanOverride === 'object' &&
    (humanOverride as { status?: unknown }).status === 'failed'
  );
  if (result.status === 'failed' || overrideFailed) process.exitCode = 1;
}

export { taskReview };
