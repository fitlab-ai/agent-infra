# Commit core boundary

Commit, push, result mapping, and task finalization use one `commit-operation.execute`. The entry point only resolves task scope, explicit agent, and the literal `--orchestrated`; it never infers the source from state files.

## Entry modes

- `mode=direct`: explicit user invocation is the authorization. Task-bound direct may read task facts but does not require a delegation receipt; taskless direct is allowed only for `TASK_CONTEXT_NOT_FOUND` and skips task facts, review, task lock, checkpoint, and task.md finalization.
- `mode=orchestrated`: an explicit task is required. Before the first Git write, the core validates the matching activated commit receipt, agent, stage, round, artifact, role, and unconsumed capability. Missing evidence returns `blocked` without writing Git.

## Shared order

1. Acquire the repository/worktree mutation lock; task-bound execution also acquires the task lock.
2. Validate the repository, current branch, explicit paths, sensitive paths, staged scope, expected HEAD/tree, remote, and full heads ref.
3. Validate the authorization for the selected mode.
4. Create at most one local commit; with no changes, allow push-only and never create an empty commit.
5. Return `COMMIT_AUTOPUSH_PROTECTED_BRANCH` on protected automatic push, or `COMMIT_PUSH_FAILED` on ordinary push failure, while retaining local facts.
6. Return one primary result: `committed`, `no_op`, `committed_with_warnings`, `failed`, or `blocked`.

## Retry boundary

Retries reread current HEAD, worktree, branch, and remote facts. A local commit that already exists is push-only and cannot produce a second commit. Taskless retries create no task record. Orchestration owns stage completion, sealing, and consumption of receipts; direct mode never fabricates them.
