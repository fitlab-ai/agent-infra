---
name: commit
description: >
  Commit the current changes to Git.
  Use when finished work needs to be turned into a Git commit.
---

# Commit Changes

Create a Git commit without overwriting user work and update the related task state when needed.

When updating related `task.md` frontmatter, read `.agents/rules/version-stamp.md` first and write or refresh `agent_infra_version`.

## Common Rationalizations and Rebuttals

| Rationalization | Rebuttal |
|------|------|
| "The tests already ran earlier, so I do not need to rerun them." | The staged content is the current truth; before committing, re-check `git status` and `git diff` instead of relying on memory. |
| "`git add -A` is faster." | `git add -A` and `git add .` are forbidden; stage only explicitly listed files to avoid including unrelated changes. |
| "This file has a copyright header, but the year can wait." | If you changed it, update the copyright year using `date +%Y`; this is a hard pre-commit check. |

## Task Context Resolution

> The entry point may omit the task ref and also accepts a legacy positional ref or `--task <ref>` / `-t <ref>`. Separate task scope from the full arguments while preserving every business operand, then call `agent-infra-internal task-context resolve {task-scope}` where `{task-scope}` is empty, one positional ref, or one task flag. Read only `taskId` from the structured result and bind `{task-id}` to that full `TASK-YYYYMMDD-HHMMSS` for downstream commands. Pass through resolution failures without scanning tasks locally.

Without explicit task scope, only `TASK_CONTEXT_NOT_FOUND` may continue through the existing bare-commit path. Detached HEAD, damaged candidates, or multiple matches are ambiguity errors. Any explicit task-scope failure is fatal.

## Step Start: Write the started Marker

Before checking local modifications, append a started marker to task.md `## Activity Log` (same base action as this step's done entry plus a ` [started]` suffix, note `started`):

```
- {YYYY-MM-DD HH:mm:ss±HH:MM} — **Commit [started]** by {agent} — started
```

`ai task log` pairs it with the done entry written when the commit completes onto one row (in progress → done). Format and pairing rules: see the "Activity Log started / done dual-marker convention" in `.agents/rules/task-management.md`. Only write it when this task has a task.md (a bare commit with no task context may skip it).

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

Detect the restricted push-only scenario first. Otherwise write message, explicit paths, and expected HEAD/tree to JSON and call `agent-infra-internal git-workflow commit --input {file}`.

If this commit is associated with a task and a `review-code` artifact exists, read the highest-round `review-code` artifact before committing:
- If that artifact's `Overall Verdict` / `总体结论` is Approved, parse `R`, `F`, and `Reviewed Snapshot Tree` / `审查快照树` (`T`)
- After staging the explicit files, record `pre_head=$(git rev-parse HEAD)` and use the helper's JSON mode to generate the complete worktree tree `W` and normalized staged tree `S`
- Before `git commit`, require `pre_head == R && W == T && S == T`; use the helper's `compare` mode to produce added, missing, and different diagnostics for both worktree and staged snapshots
- If any condition fails, enter Scenario 4 in `reference/task-status-update.md`; do not run `git commit`, push, successful state updates, PR summary sync, or the completion gate
- After all comparisons match and the commit succeeds, write `last_reviewed_commit: <new_head>` to task.md frontmatter
- Do not scan backward to earlier Approved artifacts; the highest-round `review-code` artifact is the only authoritative source

## 5. Push to the Existing PR When Applicable

After a new commit is created, or when Step 4 selects push-only, push HEAD normally if the current branch already has an open Pull Request. Otherwise keep the current behavior (the first push is still handled by `create-pr`). This adds no extra/empty commit and never pushes when there is no PR.

> Detect whether the current branch has an open PR — and authenticate to the platform — per `.agents/rules/issue-pr-commands.md`; if that rule is unavailable or detection fails, follow the degradation below.

a. Detect whether the current branch (head) has an open PR per `.agents/rules/issue-pr-commands.md`.

b. On an open PR -> push the current branch:

Use `agent-infra-internal git-workflow push --input {file}` for per-ref normal push and verification. Never force push.

c. Safe degradation (never block an already completed `git commit`; only warn the user):
   - Platform unavailable / unauthenticated / detection failed / no open PR -> do not push; continue.
   - `git push` fails (needs `git pull --rebase`, no upstream, network error) -> keep the local commit and tell the user to push manually.

Fold the push outcome (pushed / skipped(no PR) / failed) into the next step's "Update Task Status" Activity Log note or user output.

## 6. Update Task Status When Applicable

Get the current time:

```bash
date "+%Y-%m-%d %H:%M:%S%z" | sed 's/\([+-][0-9][0-9]\)\([0-9][0-9]\)$/\1:\2/'
```

> The full five-case status matrix, prerequisite checks, and multi-TUI next-step commands live in `reference/task-status-update.md`. Read `reference/task-status-update.md` before updating task state.

> **IMPORTANT**: When showing the next step, output every TUI command format in full and directly use the standard template from `reference/task-status-update.md`. If `.agents/.airc.json` configures custom TUIs (via `customTUIs`), read each tool's `name` and `invoke`, then add the matching command line in the same format (`${skillName}` becomes the skill name and `${projectName}` becomes the project name). Before rendering the final output, read `.agents/rules/next-step-output.md` and apply both of its rules: (1) render `{task-ref}` in the "Next steps" commands as the short id `#NN` (falling back to the full TASK-id when unallocated or released); (2) append the `Completed at` line as the very last line of the user-facing output (this applies to every user-facing output — success, error, and early-return paths alike, not only the success path).

Append the Commit Activity Log entry and choose exactly one next-step case:
- open PR and successful push -> `watch-pr {task-ref}`; this takes precedence over the final-commit `prFlow` route
- failed push -> keep the task active and show only push/synchronization diagnostics; do not show `watch-pr` or `complete-task`
- final commit -> render the next step by `.agents/.airc.json`'s `prFlow` (`disabled` -> single option `complete-task`; `required` -> single option `create-pr`; absent -> two options `create-pr` / `complete-task`); see Case 1 in `reference/task-status-update.md`
- more work remains -> update task.md and stop
- ready for review -> `review-code {task-id}`

## 7. Sync Issue Metadata When Applicable

When `{task-id}` exists and task.md contains a valid `issue_number`, sync the linked Issue `in:` labels and requirement checkboxes. Otherwise, skip this step.

> Trigger conditions and the declarative `platform-issue` call live in `reference/issue-metadata-sync.md`. Read that file before running this step.
>
> If this step touches the code-hosting platform, complete the prerequisite checks in `.agents/rules/issue-pr-commands.md` first.

Failure handling matches "Update Task Status When Applicable": warn, but do **not** block an already completed `git commit`.

## 8. Sync PR Summary When Applicable

When `{task-id}` exists and task.md contains a valid `pr_number`, refresh the PR summary comment marked with the PR summary marker defined in `.agents/rules/pr-sync.md` on the PR. Otherwise, skip this step.

> The full trigger conditions, aggregation rules, PATCH/POST flow, shell-safety constraints, and error handling live in `reference/pr-summary-sync.md` (which in turn points to `.agents/rules/pr-sync.md`). Read `reference/pr-summary-sync.md` before executing this step.
>
> If this step touches the code-hosting platform, complete the prerequisite checks in `.agents/rules/issue-pr-commands.md` first so the runtime context required by `.agents/rules/pr-sync.md` is ready.

Failure handling matches "Update Task Status When Applicable": warn, but do **not** block an already completed `git commit`.

## 9. Verification Gate

If this operation is associated with `{task-id}`, run the verification gate to confirm task metadata and sync state. If there is no task context, skip this step.

```bash
agent-infra-internal task-verify {task-id} commit.completed --format text
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
