import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

type CommandResult = { status: number | null; stdout: string; stderr: string };
type GitRunner = (args: readonly string[], cwd: string) => CommandResult;
type GitOperation = { name: string; status: 'applied' | 'no-op' | 'failed'; ref?: string; message?: string };

const defaultRunner: GitRunner = (args, cwd) => {
  const result = spawnSync('git', [...args], { cwd, encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
};

function run(runner: GitRunner, cwd: string, args: readonly string[]): CommandResult {
  return runner(args, cwd);
}

function value(runner: GitRunner, cwd: string, args: readonly string[], trim = true): string | null {
  const result = run(runner, cwd, args);
  return result.status === 0 ? (trim ? result.stdout.trim() : result.stdout.replace(/\n$/, '')) : null;
}

function nulPaths(output: string): string[] {
  return output.split('\0').filter(Boolean);
}

function cleanMessage(message: string): string {
  return message.replace(/(https?:\/\/)[^\s/@:]+(?::[^\s/@]*)?@/gi, '$1***@').trim();
}

function inspectGitWorkflow(cwd: string, runner: GitRunner = defaultRunner, remoteInput?: { remote: string; refs: readonly string[] }) {
  const head = value(runner, cwd, ['rev-parse', 'HEAD']);
  const branch = value(runner, cwd, ['branch', '--show-current']);
  const upstream = value(runner, cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']);
  const porcelain = value(runner, cwd, ['status', '--porcelain=v1'], false);
  if (!head || branch === null || porcelain === null) {
    return { status: 'failed' as const, changed: false, snapshot: null, operations: [], error: { code: 'GIT_INSPECT_FAILED', message: 'Unable to inspect Git repository' } };
  }
  const lines = porcelain ? porcelain.split('\n') : [];
  const remoteRefs = remoteInput ? Object.fromEntries(remoteInput.refs.map((ref) => {
    const canonical = ref.startsWith('refs/') ? ref : `refs/heads/${ref}`;
    const remote = run(runner, cwd, ['ls-remote', '--exit-code', remoteInput.remote, canonical]);
    return [ref, remote.status === 0 ? remote.stdout.trim().split(/\s+/)[0] ?? null : null];
  })) : {};
  return {
    status: 'no-op' as const, changed: false,
    snapshot: {
      head, branch, upstream,
      worktree: lines.filter((line) => line.startsWith('??') || line[1] !== ' ').map((line) => line.slice(3)),
      staged: lines.filter((line) => !line.startsWith('??') && line[0] !== ' ').map((line) => line.slice(3)),
      remoteRefs
    },
    operations: [], error: null
  };
}

function validatePaths(paths: readonly string[]): string | null {
  if (paths.length === 0) return 'At least one explicit path is required';
  for (const candidate of paths) {
    if (!candidate || candidate.startsWith('/') || candidate.split(/[\\/]/).includes('..')) return `Path escapes repository: ${candidate}`;
    if (/(^|\/)(?:\.env|credentials\.json|id_rsa)(?:$|\/)/i.test(candidate)) return `Sensitive path is not allowed: ${candidate}`;
  }
  return null;
}

function commitExplicitPaths(input: { cwd: string; paths: readonly string[]; message: string; expectedHead?: string; expectedTree?: string }, runner: GitRunner = defaultRunner) {
  const invalid = validatePaths(input.paths);
  if (invalid || !input.message.trim()) return { status: 'failed' as const, changed: false, snapshot: inspectGitWorkflow(input.cwd, runner).snapshot, operations: [], error: { code: 'GIT_COMMIT_INPUT_INVALID', message: invalid ?? 'Commit message is required' } };
  const before = inspectGitWorkflow(input.cwd, runner);
  if (!before.snapshot) return before;
  if (input.expectedHead && before.snapshot.head !== input.expectedHead) return { status: 'failed' as const, changed: false, snapshot: before.snapshot, operations: [], error: { code: 'GIT_HEAD_MISMATCH', message: `Expected HEAD ${input.expectedHead}, received ${before.snapshot.head}` } };
  const selected = new Set(input.paths);
  const unrelatedStaged = before.snapshot.staged.filter((candidate) => !selected.has(candidate));
  if (unrelatedStaged.length > 0) return { status: 'failed' as const, changed: false, snapshot: before.snapshot, operations: [], error: { code: 'GIT_STAGED_SCOPE_MISMATCH', message: `Unrelated staged paths: ${unrelatedStaged.join(', ')}` } };
  const stageFailure = (message: string) => ({ status: 'failed' as const, changed: false, snapshot: inspectGitWorkflow(input.cwd, runner).snapshot, operations: [{ name: 'stage', status: 'failed' as const, message }], error: { code: 'GIT_STAGE_FAILED', message } });
  const indexed = run(runner, input.cwd, ['ls-files', '-z', '--', ...input.paths]);
  if (indexed.status !== 0) return stageFailure(indexed.stderr.trim());
  const headed = run(runner, input.cwd, ['ls-tree', '-r', '--name-only', '-z', 'HEAD', '--', ...input.paths]);
  if (headed.status !== 0) return stageFailure(headed.stderr.trim());
  const indexedPaths = new Set(nulPaths(indexed.stdout));
  const headPaths = new Set(nulPaths(headed.stdout));
  const trackedPaths: string[] = [];
  const addPaths: string[] = [];
  for (const candidate of input.paths) {
    if (indexedPaths.has(candidate)) trackedPaths.push(candidate);
    else if (!headPaths.has(candidate) || fs.existsSync(path.join(input.cwd, candidate))) addPaths.push(candidate);
  }
  if (trackedPaths.length > 0) {
    const update = run(runner, input.cwd, ['add', '-u', '--', ...trackedPaths]);
    if (update.status !== 0) return stageFailure(update.stderr.trim());
  }
  if (addPaths.length > 0) {
    const add = run(runner, input.cwd, ['add', '--', ...addPaths]);
    if (add.status !== 0) return stageFailure(add.stderr.trim());
  }
  const staged = run(runner, input.cwd, ['diff', '--cached', '--quiet', '--']);
  if (staged.status === 0) return { status: 'no-op' as const, changed: false, snapshot: inspectGitWorkflow(input.cwd, runner).snapshot, operations: [{ name: 'stage', status: 'no-op' as const }], error: null };
  if (input.expectedTree) {
    const tree = value(runner, input.cwd, ['write-tree']);
    if (tree !== input.expectedTree) return { status: 'failed' as const, changed: false, snapshot: inspectGitWorkflow(input.cwd, runner).snapshot, operations: [{ name: 'stage', status: 'applied' as const }], error: { code: 'GIT_TREE_MISMATCH', message: `Expected staged tree ${input.expectedTree}, received ${tree ?? 'unavailable'}` } };
  }
  const commit = run(runner, input.cwd, ['commit', '-m', input.message]);
  const after = inspectGitWorkflow(input.cwd, runner);
  if (commit.status !== 0) return { status: 'failed' as const, changed: false, snapshot: after.snapshot, operations: [{ name: 'commit', status: 'failed' as const, message: commit.stderr.trim() }], error: { code: 'GIT_COMMIT_FAILED', message: commit.stderr.trim() } };
  return { status: 'applied' as const, changed: true, snapshot: after.snapshot, operations: [{ name: 'stage', status: 'applied' as const }, { name: 'commit', status: 'applied' as const }], error: null };
}

function pushGitRefs(input: { cwd: string; remote: string; refs: readonly string[] }, runner: GitRunner = defaultRunner) {
  if (!input.remote || input.refs.length === 0) return { status: 'failed' as const, changed: false, snapshot: inspectGitWorkflow(input.cwd, runner).snapshot, operations: [], error: { code: 'GIT_PUSH_INPUT_INVALID', message: 'Remote and refs are required' } };
  const operations: GitOperation[] = [];
  for (const ref of input.refs) {
    if (!/^(?:refs\/(?:heads|tags)\/)?[A-Za-z0-9._/-]+$/.test(ref) || ref.startsWith('-')) {
      operations.push({ name: 'push', ref, status: 'failed', message: 'Invalid ref' });
      continue;
    }
    const pushed = run(runner, input.cwd, ['push', input.remote, ref]);
    if (pushed.status !== 0) {
      operations.push({ name: 'push', ref, status: 'failed', message: pushed.stderr.trim() });
      continue;
    }
    const canonical = ref.startsWith('refs/') ? ref : `refs/heads/${ref}`;
    const remoteFact = run(runner, input.cwd, ['ls-remote', '--exit-code', input.remote, canonical]);
    operations.push({ name: 'push', ref, status: remoteFact.status === 0 ? 'applied' : 'failed', message: remoteFact.status === 0 ? undefined : 'Remote ref verification failed' });
  }
  const failures = operations.filter((item) => item.status === 'failed').length;
  return { status: failures === 0 ? 'applied' as const : failures === operations.length ? 'failed' as const : 'degraded' as const, changed: failures < operations.length, snapshot: inspectGitWorkflow(input.cwd, runner).snapshot, operations, error: failures ? { code: 'GIT_PUSH_PARTIAL', message: `${failures} ref push operation(s) failed` } : null };
}

type PushRebasedInput = {
  cwd: string;
  remote: string;
  branch: string;
  expectedOldHead: string;
  newHead: string;
  baseBranch: string;
  expectedBaseHead: string;
};

function pushRebasedBranch(input: PushRebasedInput, runner: GitRunner = defaultRunner) {
  const sha = /^[0-9a-f]{40}$/i;
  const refName = /^(?!-)(?!.*\.\.)(?!.*(?:^|\/)\.)(?!.*[~^:?*\[\\\s])(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/;
  if (!input.remote || !refName.test(input.remote) || !refName.test(input.branch) || !refName.test(input.baseBranch) ||
      !sha.test(input.expectedOldHead) || !sha.test(input.newHead) || !sha.test(input.expectedBaseHead)) {
    return { status: 'failed' as const, changed: false, snapshot: null, operations: [], error: { code: 'GIT_REBASED_INPUT_INVALID', message: 'Remote, branches, and full 40-character SHAs are required' } };
  }
  const snapshot = inspectGitWorkflow(input.cwd, runner).snapshot;
  if (!snapshot) return { status: 'failed' as const, changed: false, snapshot: null, operations: [], error: { code: 'GIT_INSPECT_FAILED', message: 'Unable to inspect Git repository' } };
  if (snapshot.branch !== input.branch || snapshot.head !== input.newHead) {
    return { status: 'failed' as const, changed: false, snapshot, operations: [], error: { code: 'GIT_LOCAL_IDENTITY_MISMATCH', message: 'Current branch or HEAD does not match the rebased intent' } };
  }
  const rebasePaths = ['rebase-merge', 'rebase-apply']
    .map((name) => value(runner, input.cwd, ['rev-parse', '--git-path', name]))
    .filter((candidate): candidate is string => Boolean(candidate));
  if (snapshot.worktree.length > 0 || snapshot.staged.length > 0 ||
      rebasePaths.some((candidate) => fs.existsSync(path.isAbsolute(candidate) ? candidate : path.join(input.cwd, candidate)))) {
    return { status: 'failed' as const, changed: false, snapshot, operations: [], error: { code: 'GIT_LOCAL_STATE_UNSAFE', message: 'Working tree must be clean with no rebase in progress' } };
  }
  const remoteRef = `refs/heads/${input.branch}`;
  const baseRef = `refs/heads/${input.baseBranch}`;
  const remoteHead = value(runner, input.cwd, ['ls-remote', '--exit-code', input.remote, remoteRef])?.split(/\s+/)[0] ?? null;
  if (remoteHead !== input.expectedOldHead) {
    return { status: 'failed' as const, changed: false, snapshot, operations: [], error: { code: 'GIT_REMOTE_HEAD_MISMATCH', message: `Expected remote head ${input.expectedOldHead}, received ${remoteHead ?? 'unavailable'}` } };
  }
  const baseHead = value(runner, input.cwd, ['ls-remote', '--exit-code', input.remote, baseRef])?.split(/\s+/)[0] ?? null;
  if (baseHead !== input.expectedBaseHead) {
    return { status: 'failed' as const, changed: false, snapshot, operations: [], error: { code: 'GIT_REMOTE_BASE_MISMATCH', message: `Expected base head ${input.expectedBaseHead}, received ${baseHead ?? 'unavailable'}` } };
  }
  if (run(runner, input.cwd, ['merge-base', '--is-ancestor', input.expectedBaseHead, input.newHead]).status !== 0) {
    return { status: 'failed' as const, changed: false, snapshot, operations: [], error: { code: 'GIT_REBASED_ANCESTOR_MISMATCH', message: 'Rebased head does not contain the expected base head' } };
  }
  const pushed = run(runner, input.cwd, [
    'push', `--force-with-lease=${remoteRef}:${input.expectedOldHead}`,
    input.remote, `${input.newHead}:${remoteRef}`
  ]);
  if (pushed.status !== 0) {
    const message = cleanMessage(pushed.stderr) || 'Rebased branch push was rejected';
    return { status: 'failed' as const, changed: false, snapshot: inspectGitWorkflow(input.cwd, runner).snapshot, operations: [{ name: 'push-rebased', status: 'failed' as const, ref: input.branch, message }], error: { code: 'GIT_REBASED_PUSH_REJECTED', message } };
  }
  const verified = value(runner, input.cwd, ['ls-remote', '--exit-code', input.remote, remoteRef])?.split(/\s+/)[0] ?? null;
  if (verified !== input.newHead) {
    return { status: 'failed' as const, changed: true, snapshot: inspectGitWorkflow(input.cwd, runner).snapshot, operations: [{ name: 'push-rebased', status: 'failed' as const, ref: input.branch, message: 'Remote ref verification failed' }], error: { code: 'GIT_REBASED_VERIFY_FAILED', message: `Expected pushed head ${input.newHead}, received ${verified ?? 'unavailable'}` } };
  }
  return { status: 'applied' as const, changed: true, snapshot: inspectGitWorkflow(input.cwd, runner).snapshot, operations: [{ name: 'push-rebased', status: 'applied' as const, ref: input.branch }], error: null };
}

export { commitExplicitPaths, inspectGitWorkflow, pushGitRefs, pushRebasedBranch };
export type { CommandResult, GitRunner, PushRebasedInput };
