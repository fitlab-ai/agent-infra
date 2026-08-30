---
name: commit
description: >
  Commit current changes to Git.
  Use when completed work needs to be recorded as a Git commit.
---

# Commit code

> See the collaborator token convention in `.agents/rules/task-management.md` for valid `--agent` values.

Create a Git commit without overwriting local work, and update the associated task state when needed.

The commit core returns one primary result: `committed`, `no_op`, `committed_with_warnings`, `failed`, or `blocked`, with structured `warnings`. A push failure or protected-branch policy never rolls back a local commit.

## Task context

The entry point accepts an omitted task ref, a legacy positional task ref, or `--task <ref>` / `-t <ref>`. First call `agent-infra-internal task-context resolve {task-scope}`.

- An explicit task-resolution failure stops the operation.
- Without an explicit task scope, only `TASK_CONTEXT_NOT_FOUND` may enter taskless direct mode; detached HEAD, malformed candidates, and multiple matches fail closed.
- If the literal `--orchestrated` is present in the business operands, use `mode=orchestrated`; otherwise use `mode=direct`. Never infer the mode from files or environment.
- Taskless direct mode does not read, create, or complete task intent, receipt, checkpoint, or task.md records.
- Task-bound direct mode does not require a delegation receipt; orchestrated mode must validate the matching activated commit receipt and capability in the core.
- After resolution, use only the core-returned `taskId`; never infer task identity from the environment, branch, or filename.

## 1. Inspect local changes

Before editing, run:

```bash
git status --short
git diff
```

Respect existing user changes. If the planned work conflicts with them, stop and record the blocking reason according to the no-mid-flow-questions rule.

## 2. Update copyright years

Get the current year dynamically and update only touched files that contain a copyright header. Read `reference/copyright-check.md` for the complete procedure.

## 3. Create the commit message

Review status, diff, and recent history. Use an imperative Conventional Commit message and read `reference/commit-message.md` for co-author handling.

## 4. Call the single commit core

Read `reference/commit-orchestration.md` before this step.

Write the message, explicit paths, expected HEAD/tree, task scope, agent, mode, and required push policy to a temporary JSON file, then call:

```bash
agent-infra-internal git-workflow commit --input {commit-operation.json}
```

Example:

```json
{
  "taskRef": "TASK-YYYYMMDD-HHMMSS",
  "agent": "codex",
  "mode": "direct",
  "paths": ["lib/example.ts", "tests/example.test.ts"],
  "message": "fix(core): validate example input",
  "expectedHead": "{HEAD}",
  "expectedTree": "{TREE}",
  "push": {
    "remote": "origin",
    "refs": ["refs/heads/{branch}"]
  }
}
```

Taskless direct mode omits `taskRef`; orchestrated mode must pass `taskRef`, `agent`, and `mode: "orchestrated"`. The core owns repository/worktree mutation locking, task locking when bound, path and sensitive-file checks, staged scope, HEAD/tree, branch/ref, commit, push, protected-branch policy, warnings, and idempotency.

- Create at most one local commit for explicit changes.
- If there are no changes but HEAD is ahead and delivery is requested, perform push-only and do not create an empty commit.
- Skip automatic push on `main` / `master` with `COMMIT_AUTOPUSH_PROTECTED_BRANCH`; retain the local commit.
- Return `COMMIT_PUSH_FAILED` as a warning on ordinary push failure; a retry only repairs push and never creates a second commit.
- Successful taskless operations write no task.md, review, receipt, checkpoint, or Activity Log record.

## 5. Finish task and platform synchronization

Continue task synchronization from the core-returned task result for task-bound operations; taskless operations skip task verification and platform synchronization.

When the task has an associated Issue or PR, follow `reference/issue-metadata-sync.md`, `reference/pr-summary-sync.md`, and the platform rules. The commit path passes `--result no_op` to summary-sync because it only synchronizes an existing PR identity. Synchronization failures are warnings and do not roll back the local commit.

After task-bound finalization, run:

```bash
date "+%Y-%m-%d %H:%M:%S%z" | sed 's/\([+-][0-9][0-9]\)\([0-9][0-9]\)$/\1:\2/'
agent-infra-internal task-verify {task-id} commit.completed --format text
```

Do not claim task finalization without fresh verification output.

## 6. Render the next step

Before rendering the next step, read `.agents/rules/next-step-output.md` and call the unified helper exactly once based on the latest task and PR state. A failed push keeps the task active and reports only diagnostics; a final commit routes to `create-pr` or `complete-task` according to `prFlow`.

## Notes

- Never commit `.env`, credentials, keys, or other sensitive files.
- Never use `git add -A` or `git add .`.
- Never hand-write task Activity Log, review anchors, receipts, or checkpoints.
