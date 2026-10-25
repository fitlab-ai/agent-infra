# Commit core boundary

Commit, push, result mapping, and task finalization use one `commit-operation.execute`. The entry point resolves task scope, explicit agent, and call arguments. Execution mode is always `direct`; the caller explicitly selects delivery mode `local` or `push`.

## Entry contract

- Task-bound direct may read task facts. Taskless direct is allowed only for `TASK_CONTEXT_NOT_FOUND` and skips task facts, review, checkpoint, and task.md finalization.
- `code-task` creates a local checkpoint through the shared core with `delivery=local`; standalone `commit` uses `delivery=push`. Both share the same validation and commit order.

## Shared order

1. Execute serially according to caller semantics.
2. Validate the repository, current branch, explicit paths, sensitive paths, staged scope, expected HEAD/tree, remote, and full heads ref.
3. Validate direct-mode authorization.
4. Create at most one local commit; with no changes, allow push-only and never create an empty commit.
5. Return `COMMIT_AUTOPUSH_PROTECTED_BRANCH` on protected automatic push, or `COMMIT_PUSH_FAILED` on ordinary push failure, while retaining local facts.
6. Return one primary result: `committed`, `no_op`, `committed_with_warnings`, `failed`, or `blocked`.

## Retry boundary

Retries reread current HEAD, worktree, branch, and remote facts. A local commit that already exists is push-only and cannot produce a second commit. Taskless retries create no task record.
