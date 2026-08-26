import fs from 'node:fs';
import { commitExplicitPaths, inspectGitWorkflow, pushGitRefs, pushRebasedBranch } from '../git/workflow.ts';
import { compareReviewTrees, snapshotReview } from '../git/review-snapshot.ts';
import { resolvePostReviewGlobs } from '../task/review-fingerprint.ts';
import { commitPushDecision } from '../task/commit-policy.ts';
import { mergeOperationWarnings, type OperationWarning } from '../task/operation-outcome.ts';

function output(value: unknown): void { process.stdout.write(`${JSON.stringify(value)}\n`); }

function policyFailure(cwd: string, message: string) {
  const inspected = inspectGitWorkflow(cwd);
  return {
    status: 'failed' as const,
    changed: false,
    snapshot: inspected.snapshot,
    operations: [],
    error: { code: 'COMMIT_PUSH_POLICY_INVALID', message },
    outcome: null,
    warnings: []
  };
}

function validateCommitPushInput(cwd: string, input: any): { remote: string; refs: [string]; policy: { branch: string; automatic: boolean } } | { error: ReturnType<typeof policyFailure> } {
  const remote = typeof input.remote === 'string' ? input.remote.trim() : '';
  const refs = Array.isArray(input.refs) ? input.refs : [];
  const policy = input.policy as { branch?: unknown; automatic?: unknown } | null;
  const branch = typeof policy?.branch === 'string' ? policy.branch.trim() : '';
  if (!remote || refs.length !== 1 || typeof refs[0] !== 'string' || !branch || typeof policy?.automatic !== 'boolean') {
    return { error: policyFailure(cwd, 'Commit push policy requires one remote, one full heads ref, branch, and automatic flag') };
  }
  const inspected = inspectGitWorkflow(cwd);
  if (!inspected.snapshot) return { error: policyFailure(cwd, 'Unable to inspect the current Git branch for commit push policy') };
  const expectedRef = `refs/heads/${inspected.snapshot.branch}`;
  if (branch !== inspected.snapshot.branch || refs[0] !== expectedRef) {
    return { error: policyFailure(cwd, 'Commit push policy branch and ref must match the current branch exactly') };
  }
  return { remote, refs: [refs[0]], policy: { branch, automatic: policy.automatic } };
}

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
    result = input ? commitExplicitPaths({ cwd: cwd ?? process.cwd(), ...input }) : { status: 'failed', changed: false, error: { code: 'GIT_INPUT_REQUIRED', message: '--input JSON file is required' } };
  } else if (action === 'push') {
    const inputIndex = rest.indexOf('--input');
    const input = inputIndex >= 0 && rest[inputIndex + 1] ? JSON.parse(fs.readFileSync(rest[inputIndex + 1]!, 'utf8')) : null;
    if (!input) result = { status: 'failed', changed: false, error: { code: 'GIT_INPUT_REQUIRED', message: '--input JSON file is required' } };
    else if (input.policy) {
      const validated = validateCommitPushInput(cwd ?? process.cwd(), input);
      if ('error' in validated) result = validated.error;
      else {
        const { policy, remote, refs } = validated;
        const ref = refs[0];
      const decision = commitPushDecision({
        branch: policy.branch,
        automatic: policy.automatic
      }, `${remote}:${ref}`);
      if (!decision.shouldPush) {
        result = {
          status: 'applied', changed: false,
          outcome: 'committed_with_warnings' as const,
          warnings: decision.warning ? [decision.warning] : [],
          error: null
        };
      } else {
        const pushed = pushGitRefs({ cwd: cwd ?? process.cwd(), remote, refs });
        const warning: OperationWarning | null = pushed.status === 'applied' || !pushed.error
          ? null
          : {
            code: 'COMMIT_PUSH_FAILED',
            message: pushed.error.message,
            retryable: true,
            step: 'push',
            target: `${remote}:${ref}`,
            severity: 'ACTION_REQUIRED'
          };
        result = {
          ...pushed,
          status: warning ? 'applied' as const : pushed.status,
          error: warning ? null : pushed.error,
          outcome: warning ? 'committed_with_warnings' as const : null,
          warnings: mergeOperationWarnings(warning ? [warning] : [])
        };
      }
      }
    } else result = pushGitRefs({ cwd: cwd ?? process.cwd(), ...input });
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
