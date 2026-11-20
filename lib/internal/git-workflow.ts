import fs from 'node:fs';
import { inspectGitWorkflow, previewCommitTree, pushRebasedBranch } from '../git/workflow.ts';
import { compareReviewTrees, snapshotReview } from '../git/review-snapshot.ts';
import { resolvePostReviewGlobs } from '../task/review-fingerprint.ts';
import { executeCommitOperation } from '../task/commit-operation.ts';
import { ensureInternalHandlerRoute, internalHandlerRoute } from './cli-route-inventory.ts';

function output(value: unknown): void { process.stdout.write(`${JSON.stringify(value)}\n`); }

function readInput(rest: string[]): any {
  const inputIndex = rest.indexOf('--input');
  return inputIndex >= 0 && rest[inputIndex + 1] ? JSON.parse(fs.readFileSync(rest[inputIndex + 1]!, 'utf8')) : null;
}

function gitWorkflow(args: string[] = []): void {
  if (!ensureInternalHandlerRoute('git-workflow', args)) return;
  const [action, ...rest] = args;
  const routeAction = action ?? '';
  const cwdIndex = rest.indexOf('--cwd');
  const cwd = cwdIndex >= 0 ? rest[cwdIndex + 1] : process.cwd();
  let result;
  function runInspect() {
    const input = readInput(rest);
    return inspectGitWorkflow(cwd ?? process.cwd(), undefined, input?.remote && input.refs ? { remote: input.remote, refs: input.refs } : undefined);
  }

  function runCommit() {
    const input = readInput(rest);
    return input
      ? executeCommitOperation({ cwd: cwd ?? process.cwd(), ...input })
      : { status: 'failed', changed: false, error: { code: 'GIT_INPUT_REQUIRED', message: '--input JSON file is required' } };
  }

  function runPushRebased() {
    const input = readInput(rest);
    return input ? pushRebasedBranch({ cwd: cwd ?? process.cwd(), ...input }) : { status: 'failed', changed: false, error: { code: 'GIT_INPUT_REQUIRED', message: '--input JSON file is required' } };
  }

  function runPreviewTree() {
    const input = readInput(rest);
    return input
      ? previewCommitTree({ cwd: cwd ?? process.cwd(), paths: input.paths, expectedHead: input.expectedHead })
      : { status: 'failed', changed: false, error: { code: 'GIT_INPUT_REQUIRED', message: '--input JSON file is required' } };
  }

  function runSnapshotOrCompare() {
    const input = readInput(rest);
    if (!input) return { status: 'failed', changed: false, error: { code: 'GIT_INPUT_REQUIRED', message: '--input JSON file is required' } };
    else if (internalHandlerRoute('git-workflow', 'snapshot', routeAction)) return { status: 'no-op', changed: false, snapshot: snapshotReview({ cwd: cwd ?? process.cwd(), mode: input.mode, baseline: input.baseline, diffBase: input.diffBase, globs: input.globs ?? resolvePostReviewGlobs({}, {}) }), error: null };
    else return { status: 'no-op', changed: false, comparison: compareReviewTrees({ cwd: cwd ?? process.cwd(), expected: input.expected, actual: input.actual }), error: null };
  }

  if (internalHandlerRoute('git-workflow', 'inspect', routeAction)) {
    result = runInspect();
  }
  else if (internalHandlerRoute('git-workflow', 'commit', routeAction)) {
    result = runCommit();
  } else if (internalHandlerRoute('git-workflow', 'push-rebased', routeAction)) {
    result = runPushRebased();
  } else if (internalHandlerRoute('git-workflow', 'preview-tree', routeAction)) {
    result = runPreviewTree();
  } else if (internalHandlerRoute('git-workflow', 'snapshot', routeAction)
    || internalHandlerRoute('git-workflow', 'compare-trees', routeAction)) {
    result = runSnapshotOrCompare();
  } else result = { status: 'failed', changed: false, error: { code: 'GIT_ACTION_INVALID', message: `Unknown git-workflow action '${routeAction}'` } };
  output(result);
  process.exitCode = result.status === 'failed' ? 1 : result.status === 'blocked' ? 2 : 0;
}

export { gitWorkflow };
