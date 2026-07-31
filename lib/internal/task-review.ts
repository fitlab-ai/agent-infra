import { finalizeReviewSummary } from '../task/review-finalization.ts';

const USAGE = 'Usage: agent-infra-internal task-review <task-ref> finalize-summary --stage <analysis|plan|code> --artifact <review-*.md> [--dry-run]\n';

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
  const seen = new Set<string>();
  for (let index = 2; index < args.length; index += 1) {
    const flag = args[index]!;
    if (!['--stage', '--artifact', '--dry-run'].includes(flag)) {
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
    const value = args[++index];
    if (!value || value.startsWith('--')) {
      failUsage(`option '${flag}' requires a value`);
      return;
    }
    if (flag === '--stage') stage = value;
    else artifact = value;
  }
  if (!stage || !artifact) {
    failUsage("options '--stage' and '--artifact' are required");
    return;
  }
  const result = finalizeReviewSummary({ taskRef: args[0]!, stage, artifact, dryRun });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.status === 'failed') process.exitCode = 1;
}

export { taskReview };
