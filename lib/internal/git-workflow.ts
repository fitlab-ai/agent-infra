import fs from 'node:fs';
import { inspectGitWorkflow, pushRebasedBranch } from '../git/workflow.ts';
import { compareReviewTrees, snapshotReview } from '../git/review-snapshot.ts';
import { resolvePostReviewGlobs } from '../task/review-fingerprint.ts';
import { executeCommitOperation } from '../task/commit-operation.ts';

function output(value: unknown): void { process.stdout.write(`${JSON.stringify(value)}\n`); }

function gitWorkflow(args: string[] = []): void {
  const [action, ...rest] = args;
  const cwdIndex = rest.indexOf('--cwd');
  const cwd = cwdIndex >= 0 ? rest[cwdIndex + 1] : process.cwd();
  let result;
  if (action === 'inspect') {
    const inputIndex = rest.indexOf('--input');
    const input = inputIndex >= 0 && rest[inputIndex + 1] ? JSON.parse(fs.readFileSync(rest[inputIndex + 1]!, 'utf8')) as { remote?: string; refs?: string[] } : null;
    result = inspectGitWorkflow(cwd ?? process.cwd(), undefined, input?.remote && input.refs ? { remote: input.remote, refs: input.refs } : undefined);
  }
  else if (action === 'commit') {
    const inputIndex = rest.indexOf('--input');
    const input = inputIndex >= 0 && rest[inputIndex + 1] ? JSON.parse(fs.readFileSync(rest[inputIndex + 1]!, 'utf8')) : null;
    result = input
      ? executeCommitOperation({ cwd: cwd ?? process.cwd(), ...input })
      : { status: 'failed', changed: false, error: { code: 'GIT_INPUT_REQUIRED', message: '--input JSON file is required' } };
  } else if (action === 'push-rebased') {
    const inputIndex = rest.indexOf('--input');
    const input = inputIndex >= 0 && rest[inputIndex + 1] ? JSON.parse(fs.readFileSync(rest[inputIndex + 1]!, 'utf8')) : null;
    result = input ? pushRebasedBranch({ cwd: cwd ?? process.cwd(), ...input }) : { status: 'failed', changed: false, error: { code: 'GIT_INPUT_REQUIRED', message: '--input JSON file is required' } };
  } else if (action === 'snapshot' || action === 'compare-trees') {
    const inputIndex = rest.indexOf('--input');
    const input = inputIndex >= 0 && rest[inputIndex + 1] ? JSON.parse(fs.readFileSync(rest[inputIndex + 1]!, 'utf8')) : null;
    if (!input) result = { status: 'failed', changed: false, error: { code: 'GIT_INPUT_REQUIRED', message: '--input JSON file is required' } };
    else if (action === 'snapshot') result = { status: 'no-op', changed: false, snapshot: snapshotReview({ cwd: cwd ?? process.cwd(), mode: input.mode, baseline: input.baseline, diffBase: input.diffBase, globs: input.globs ?? resolvePostReviewGlobs({}, {}) }), error: null };
    else result = { status: 'no-op', changed: false, comparison: compareReviewTrees({ cwd: cwd ?? process.cwd(), expected: input.expected, actual: input.actual }), error: null };
  } else result = { status: 'failed', changed: false, error: { code: 'GIT_ACTION_INVALID', message: `Unknown git-workflow action '${action ?? ''}'` } };
  output(result);
  process.exitCode = result.status === 'failed' ? 1 : result.status === 'blocked' ? 2 : 0;
}

export { gitWorkflow };
