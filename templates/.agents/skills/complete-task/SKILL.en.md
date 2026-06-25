---
name: complete-task
description: >
  Mark a task as completed and archive it.
  Use when a task's work is done and verified and you want to close and archive it.
---

# Complete Task

## Boundary / Critical Rules

- This command updates task metadata AND physically moves the task directory
- Do not move a task that has incomplete workflow steps unless forced

Version stamp rule: when creating or updating `task.md` frontmatter, read `.agents/rules/version-stamp.md` first and write or refresh `agent_infra_version`.

## Step 0: State Check (pre-execution hard gate)

After loading workflow / skill / rules instructions, and before any task-state judgment or user-visible conclusion, run the state check first. Reading instruction files does not count as an external-state action or conclusion.

Run these commands and paste the raw output into both the user-facing reply and this round's `## State Check` section:

```bash
git status -s
ls -la .agents/workspace/active/{task-id}/
tail .agents/workspace/active/{task-id}/task.md
```

Before the state check is complete, do not make external-state assertions such as "the code is unchanged", "tests passed", or "there are no other references", including in reasoning. This gate is only a structural floor; evidence pairing and authenticity still require the report template and review discipline.

## Task id short ref

> If `{task-id}` matches `^[#]?[0-9]+$` (bare numeric or `#`-prefixed), follow the "SKILL parameter resolver" section of `.agents/rules/task-short-id.md`; treat `{task-id}` as the resolved full `TASK-YYYYMMDD-HHMMSS` form for every downstream command.

## Step Start: Write the started Marker

After confirming the task exists and before this round's first artifact action, append a started marker to task.md `## Activity Log` (same base action as this round's done entry plus a ` [started]` suffix, note `started`):

```
- {YYYY-MM-DD HH:mm:ss±HH:MM} — **Complete Task [started]** by {agent} — started
```

`ai task log` pairs it with the done entry written on completion onto one row (in progress → done). Format and pairing rules: see the "Activity Log started / done dual-marker convention" in `.agents/rules/task-management.md`.

## Steps

### 1. Verify Task Exists

Check that the task exists in `.agents/workspace/active/{task-id}/`.

Note: `{task-id}` format is `TASK-{yyyyMMdd-HHmmss}`, e.g. `TASK-20260306-143022`

If not found in `active/`, check `blocked/` and `completed/`:
- If in `completed/`: Inform user the task is already completed
- If in `blocked/`: Inform user the task is blocked; suggest unblocking first

### 2. Verify Completion Prerequisites (Failure Must Stop)

**Gate read (project-level PR flow policy)**: Before running this step, read `.agents/.airc.json`'s `prFlow` field (three states: field absent = recommend PR by default, skipping allowed; `"required"` = PR mandatory; `"disabled"` = no PR flow), and `pr_status` from `task.md` frontmatter (`pending` / `created` / `skipped`).

**PR dimension decision (evaluate the `prFlow` strong constraint FIRST, then `pr_status`)**:

| `prFlow` | `pr_status` | Decision |
|---|---|---|
| `disabled` | any | No PR path -> PR dimension satisfied, continue with the other prerequisites |
| `required` | `created` | PR dimension satisfied, continue |
| `required` | `pending` / `skipped` | **Stop**: under a mandatory PR flow you must run `/create-pr` first; `--skip-pr` is NOT accepted (including a pre-existing / manually-set `skipped`) |
| absent | `created` / `skipped` | PR dimension satisfied, continue |
| absent | `pending` | **Stop by default** and print the two-option guidance below; unless the user passes `--skip-pr` (writes `pr_status: skipped`, then continues) or `--force` |

- `--skip-pr` handling: effective only when `prFlow` is not `required` -> set `pr_status` to `skipped` in `task.md`, then continue; when `prFlow=required`, ignore `--skip-pr` and stop per the table.
- Note: `--force` may override the other prerequisites below, but does **NOT** lift the `prFlow=required` PR constraint (the only exit from the strong constraint is creating a PR).

Two-option guidance for absent + `pending`:
```
Task {task-id} has no PR yet (pr_status: pending). Choose one:
  - Go through the PR flow: /create-pr {task-ref}
  - Explicitly skip and complete: /complete-task {task-ref} --skip-pr
```

Stop message for `required` + `pending`/`skipped`:
```
This project enforces the PR flow (prFlow: "required") and the task has no PR yet.
Run /create-pr {task-ref} first, then complete; --skip-pr is not accepted under a mandatory PR flow.
```

Before marking complete, verify ALL of these:
- [ ] All workflow steps are complete (check workflow progress in task.md; **for the `pr_tasks` list under each yaml `commit` step, decide whether to count them by the "PR path" rule: `prFlow=required` always counts; `prFlow=disabled` never counts; when absent, exclude only if `pr_status=skipped`, otherwise count**)
- [ ] Code has been reviewed (`review-code.md` or `review-code-r{N}.md` exists, and the latest review verdict is Approved; or review was done externally)
- [ ] Code has been committed (no uncommitted changes related to this task)
- [ ] Tests are passing
- [ ] The disagreement ledger has no unclosed disagreements and there are no un-re-reviewed post-review commits (mechanically checked by the "Pre-completion hard gate" below)

**Pre-completion hard gate (run BEFORE moving the directory or releasing the short id)**: the Step 7 `gate complete-task` runs only after the directory has been `mv`-ed to `completed/` and the short id released; to avoid a gate failure occurring after those irreversible operations, run the two new completion gates on the **active directory** first:

```bash
node .agents/scripts/validate-artifact.js check review-ledger .agents/workspace/active/{task-id} --skill complete-task --format text
node .agents/scripts/validate-artifact.js check post-review-commit .agents/workspace/active/{task-id} --skill complete-task --format text
```

A non-zero exit from either (fail/blocked) -> treat as an unmet prerequisite and **stop**, do not run Steps 3-7. `--force` does **NOT** lift this hard gate: unclosed disagreements must first be closed in the ledger (`confirmed`/`closed`/`human-decided`), and un-re-reviewed post-review commits must be re-reviewed via `review-code` or covered by a `post-review-commit` / `human-decided` exemption row in the ledger.

> **⚠️ Prerequisite Branch Check — you must decide whether to continue or stop before proceeding:**
>
> - If all conditions above are satisfied -> continue to Step 3
> - If any condition is missing -> **stop by default** and output the prerequisite warning
> - Only continue with unmet prerequisites when the user explicitly requested `--force`
>
> **Do not continue to Steps 3-7 when prerequisites are not met, and do not output "Task {task-id} completed; task directory moved to completed/."**

If any prerequisite is not met, warn the user:
```
Cannot complete task {task-id} - prerequisites not met:
- [ ] {Missing prerequisite}

Please complete the missing steps first, or use --force to override.
```

If prerequisites are not met and the user did not explicitly provide `--force`, stop immediately and do not execute Steps 3-7.

### 3. Update Task Metadata

Get the current time:

```bash
date "+%Y-%m-%d %H:%M:%S%:z"
```

Update `.agents/workspace/active/{task-id}/task.md`:
- `status`: completed
- `current_step`: completed
- `completed_at`: {current timestamp}
- `target_date`: write the date portion (`YYYY-MM-DD`) of `completed_at` only when empty; keep any existing (human-entered) value
- `updated_at`: {current timestamp}
- `agent_infra_version`: value from `.agents/rules/version-stamp.md`
- Add or update the `## State Check` section with the raw Step 0 audit command output, including `$ ` prompt lines, before `## Activity Log`
- Mark all workflow steps as complete
- Verify and check off all items in `## Completion Checklist` (change `- [ ]` to `- [x]`)
- **Append** to `## Activity Log` (do NOT overwrite previous entries):
  ```
  - {YYYY-MM-DD HH:mm:ss±HH:MM} — **Complete Task** by {agent} — Task moved to completed/
  ```

### 4. Move Task

Move the task directory from active to completed:

```bash
mv .agents/workspace/active/{task-id} .agents/workspace/completed/{task-id}
```

### 5. Verify Move

```bash
ls .agents/workspace/completed/{task-id}/task.md
```

Confirm the task directory was successfully moved.

### 6. Sync to Issue

Check whether `task.md` includes a valid `issue_number`. If not, skip this step and output nothing.

> Issue sync rules live in `.agents/rules/issue-sync.md`. Read that file before syncing, and complete upstream repository detection plus permission detection.

If a valid `issue_number` exists:
- First scan and backfill unpublished `task.md`, `analysis*.md`, `review-analysis*.md`, `plan*.md`, `review-plan*.md`, `code*.md`, and `review-code*.md` comments using the backfill rules in `.agents/rules/issue-sync.md` (`task.md` uses the idempotent update path)
- Backfill checked `## Requirements` items to the Issue body by following the requirements-checkbox sync steps in issue-sync.md
- Do not set any `status:` label — status labels are automatically cleared when the Issue is closed
- Finally create or update the summary comment marked with the summary marker defined in `.agents/rules/issue-sync.md`
- Read `.agents/rules/issue-fields.md` and follow Flow A to sync every non-empty Issue field (`priority`/`effort`/`start_date`/`target_date`) from `task.md` to the Issue (idempotent; skip without blocking when `has_push=false` or the fetch/write fails)

### 7. Verification Gate

**Release short id** (after the directory has already been moved; the script is idempotent and returns 0 even if the task isn't registered):

```bash
node .agents/scripts/task-short-id.js release "$task_id" || true
```

Run the verification gate to confirm the task artifact and sync state are valid:

```bash
node .agents/scripts/validate-artifact.js gate complete-task .agents/workspace/completed/{task-id} --format text
```

Handle the result as follows:
- exit code 0 (all checks passed) -> continue to the "Inform User" step
- exit code 1 (validation failed) -> fix the reported issues and run the gate again
- exit code 2 (network blocked) -> stop and tell the user that human intervention is required

Keep the gate output in your reply as fresh evidence. Do not claim completion without output from this run.

### 8. Inform User

> Execute this step only after the verification gate passes.

> The completion timestamp line (the last line of the whole output) uses `date "+%Y-%m-%d %H:%M:%S"` (local timezone, no offset) and always sits at the very end of the output for at-a-glance scanning across windows. This skill renders no "Next steps" commands, but it does render an **optional sandbox-cleanup hint** before the timestamp line (see the gate below), and still prints the line.

> **Optional sandbox-cleanup hint (gated)**: Render the "Optional: clean up this task's sandbox" block in the output below only when BOTH (1) `.agents/.airc.json` has a `sandbox` field and (2) task.md's `branch` field exists and is not `main` / `master`; otherwise omit the whole block. `{branch}` is the `branch` value from the task.md you already loaded (the task has moved to completed/, so read it from `.agents/workspace/completed/{task-id}/task.md`). This block is independent of "Next steps" semantics — it is not a workflow successor command.

Output format:
```
Task {task-id} completed; task directory moved to completed/.

Task info:
- Title: {title}
- Completed at: {timestamp}
- Target path: .agents/workspace/completed/{task-id}/

Deliverables:
- {List of key outputs: files modified, tests added, etc.}

Optional: clean up this task's sandbox
(The task is archived; the sandbox container and per-branch config directory are not reclaimed automatically. Run this if you no longer need them:)

ai sandbox rm {branch}

Completed at: {completion-time}
```



## Completion Checklist

- [ ] Verified all workflow steps are complete
- [ ] Updated task.md with completed status and timestamp
- [ ] Moved task directory to `.agents/workspace/completed/`
- [ ] Verified move succeeded
- [ ] Informed user of completion

## Notes

1. **Premature completion**: Do not move a task that has incomplete steps. Examples of incomplete situations:
   - Code is written but not committed
   - Code is committed but not reviewed
   - Review found blockers that haven't been fixed
   - PR is created but not merged

2. **Rollback**: If a task was incorrectly moved:
   ```bash
   mv .agents/workspace/completed/{task-id} .agents/workspace/active/{task-id}
   ```
   Then update task.md status back to `active`.

3. **Multiple contributors**: If multiple AI agents worked on the task, ensure all contributions are committed before completing.

## Error Handling

- Task not found: Prompt "Task {task-id} not found in active directory"
- Already completed: Prompt "Task {task-id} is already in completed directory"
- Task is blocked: Prompt "Task {task-id} is blocked. Unblock it first by moving to active/"
- Move failed: Prompt error and suggest manual move
