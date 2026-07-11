---
name: complete-manual-validation
description: >
  Mark PR manual validation as completed and update the manual-validation section
  in the existing PR summary comment in place.
---

# Complete Manual Validation

## Boundary / Critical Rules

- This skill closes the manual-validation status in an existing PR summary comment; it does not create a parallel ordinary validation comment.
- It must write `manual-validation.md` or `manual-validation-r{N}.md` so later PR summary refreshes can reuse the validation result.
- If the `sync-pr` summary comment is missing, fail instead of creating a partial fallback summary.
- After this skill runs, update `task.md` immediately.

Version stamp rule: when creating or updating `task.md` frontmatter, read `.agents/rules/version-stamp.md` first and write or refresh `agent_infra_version`.

## Step 0: State Check (pre-execution hard gate)

After loading workflow / skill / rules instructions, and before any task-state judgment or user-visible conclusion, run the state check first. Reading instruction files does not count as an external-state action or conclusion.

Run these commands and paste the raw output into both the user-facing reply and this round's `## State Check` section:

```bash
git status -s
ls -la .agents/workspace/active/{task-id}/
tail .agents/workspace/active/{task-id}/task.md
```

## Task id short ref

> If `{task-id}` matches `^[#]?[0-9]+$` (bare numeric or `#`-prefixed), follow the "SKILL parameter resolver" section of `.agents/rules/task-short-id.md`; treat `{task-id}` as the resolved full `TASK-YYYYMMDD-HHMMSS` form for every downstream command.

## Step Start: Write the started Marker

After confirming prerequisites and the artifact round, and before this round's first artifact action, append a started marker to task.md `## Activity Log`:

```
- {YYYY-MM-DD HH:mm:ss±HH:MM} — **Complete Manual Validation [started]** by {agent} — started
```

See the "Activity Log started / done dual-marker convention" in `.agents/rules/task-management.md`.

## Steps

### 1. Parse Arguments

Input:

```text
complete-manual-validation {task-ref} [{pr-ref}] {verification-summary}
```

- `{task-ref}` is required.
- `{pr-ref}` is optional and accepts `#NN`, `NN`, or a full PR URL.
- `{verification-summary}` is required. If it is missing, stop and ask for a validation summary; do not write an artifact or update the PR.

### 2. Verify Prerequisites

Check:
- `.agents/workspace/active/{task-id}/task.md`
- a valid PR: prefer explicit `{pr-ref}`, otherwise read `pr_number` from task.md frontmatter

Stop if the task is missing, the validation summary is missing, or no valid PR can be resolved.

### 3. Determine Artifact Round

Scan the task directory:
- no `manual-validation.md` and no `manual-validation-r*.md` -> write `manual-validation.md`
- `manual-validation.md` exists and no `manual-validation-r*.md` -> write `manual-validation-r2.md`
- `manual-validation-r{N}.md` exists -> write `manual-validation-r{N+1}.md`

### 4. Update the PR Summary

Before this step, read:
- `.agents/rules/issue-sync.md`
- `.agents/rules/pr-sync.md`
- `reference/summary-update.md`

Follow `reference/summary-update.md` to resolve the PR number, find the `sync-pr` summary comment, extract the manual-validation scope, and update the section to `### ✅ Manual Validation Passed`.

### 5. Create the Manual Validation Artifact

Before this step, read `reference/report-template.md`. Create `{manual-validation-artifact}` and record:
- State check
- Validation verdict
- Validation scope
- Validation details
- PR summary sync result

### 6. Update task.md

Get the current time:

```bash
date "+%Y-%m-%d %H:%M:%S%:z"
```

Update `.agents/workspace/active/{task-id}/task.md`:
- `updated_at`: current time
- `assigned_to`: current agent
- `agent_infra_version`: value from `.agents/rules/version-stamp.md`
- keep `current_step` unchanged
- append the `{manual-validation-artifact}` link and PR summary sync result to `## Implementation Notes`
- append Activity Log:
  ```
  - {YYYY-MM-DD HH:mm:ss±HH:MM} — **Complete Manual Validation** by {agent} — Manual validation passed → {manual-validation-artifact}; {summary-result}
  ```

If the task has a valid `issue_number`, follow `.agents/rules/issue-sync.md` to update the task comment and publish the `{manual-validation-artifact}` comment.

### 7. Verification Gate

Run:

```bash
node .agents/scripts/validate-artifact.js gate complete-manual-validation .agents/workspace/active/{task-id} {manual-validation-artifact} --format text
```

Handle the result:
- Exit code 0 -> tell the user
- Exit code 1 -> fix the reported problem and rerun
- Exit code 2 -> stop and report that manual intervention is required

### 8. Tell the User

Report:
- Artifact path
- PR summary sync result
- Current verification output
- Suggested next step: continue with `commit` / `create-pr`, or enter the final review flow

Before rendering the final output, read `.agents/rules/next-step-output.md` and append `Completed at: YYYY-MM-DD HH:mm:ss` as the absolute last line.

## Completion Checklist

- [ ] Read `reference/summary-update.md`
- [ ] Created the manual validation artifact
- [ ] Updated the same PR summary comment, or stopped according to failure semantics
- [ ] Updated task.md and appended the Activity Log
- [ ] Ran the verification gate
