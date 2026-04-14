---
name: commit
description: "Commit the current changes to Git"
---

# Commit Changes

Create a Git commit without overwriting user work and update the related task state when needed.

## 1. Check Local Modifications (CRITICAL)

Before any edit, inspect:

```bash
git status --short
git diff
```

Respect existing user changes. If your planned edit conflicts with them, stop and ask before proceeding.

## 2. Update Copyright Headers

Use the current year dynamically and only update files that are already modified.

> The full copyright workflow lives in `reference/copyright-check.md`. Read `reference/copyright-check.md` before editing any header.

## 3. Build the Commit Message

Review status, diff, and recent history, then prepare a Conventional Commit with the correct co-author lines.

> Commit message rules, examples, and multi-agent co-authorship details live in `reference/commit-message.md`. Read `reference/commit-message.md` before writing the commit.

## 4. Create the Commit

Stage specific files only and run `git commit` with the prepared message.

## 5. Update Task Status When Applicable

Get the current time:

```bash
date "+%Y-%m-%d %H:%M:%S%:z"
```

> The full four-case status matrix, prerequisite checks, and multi-TUI next-step commands live in `reference/task-status-update.md`. Read `reference/task-status-update.md` before updating task state.

> **IMPORTANT**: When showing the next step, output every TUI command format in full and directly use the standard template from `reference/task-status-update.md`.

Append the Commit Activity Log entry and choose exactly one next-step case:
- final commit -> `complete-task {task-id}`
- more work remains -> update task.md and stop
- ready for review -> `review-task {task-id}`
- ready for PR -> `create-pr`

## 6. Sync PR Summary When Applicable

When `{task-id}` exists and task.md contains a valid `pr_number`, refresh the PR summary comment `<!-- sync-pr:{task-id}:summary -->` on the PR. Otherwise, skip this step.

> The full trigger conditions, aggregation rules, PATCH/POST flow, shell-safety constraints, and error handling live in `reference/pr-summary-sync.md` (which in turn points to `.agents/rules/pr-sync.md`). Read `reference/pr-summary-sync.md` before executing this step.
>
> If this step touches the code-hosting platform, complete the prerequisite checks in `.agents/rules/issue-pr-commands.md` first so the runtime context required by `.agents/rules/pr-sync.md` is ready.

Failure handling matches "Update Task Status When Applicable": warn, but do **not** block an already completed `git commit`.

## 7. Verification Gate

If this operation is associated with `{task-id}`, run the verification gate to confirm task metadata and sync state. If there is no task context, skip this step.

```bash
node .agents/scripts/validate-artifact.js gate commit .agents/workspace/active/{task-id}
```

Handle the result as follows:
- exit code 0 (all checks passed) -> continue the remaining wrap-up steps
- exit code 1 (validation failed) -> fix the reported issues and run the gate again
- exit code 2 (network blocked) -> stop and tell the user that human intervention is required

Keep the gate output in your reply as fresh evidence. Do not claim completion without output from this run.

## Notes

- Never commit secrets such as `.env`, credentials, or keys
- Keep the current agent first in the co-author block
- Do not use `git add -A` or `git add .`

## Error Handling

- If the task status update fails, warn the user but do not block the commit
