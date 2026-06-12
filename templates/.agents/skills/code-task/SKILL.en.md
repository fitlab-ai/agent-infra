---
name: code-task
description: "Implement code from the technical plan and output a report"
---

# Code Task

Implement the approved plan and produce `code.md` or `code-r{N}.md`. This skill supports initial implementation and fix mode based on `review-code` feedback.

## Boundary / Critical Rules

- Follow the latest plan artifact: `plan.md` or `plan-r{N}.md`
- Fix mode only addresses findings from the latest `review-code`; env-blocked items are out of scope
- Never auto-run `git add` or `git commit`
- Create a new code artifact for each round and never overwrite an older one
- After executing this skill, you **must** immediately update task.md

Version stamp rule: when creating or updating `task.md` frontmatter, read `.agents/rules/version-stamp.md` first and write or refresh `agent_infra_version`.

## Step 0: State Check (pre-execution hard gate)

After loading workflow / skill / rules instructions, and before any task-state judgment or user-visible conclusion, run the state check first.

Run these commands and paste the raw output into both the user-facing reply and this round's `## State Check` section:

```bash
git status -s
ls -la .agents/workspace/active/{task-id}/
tail .agents/workspace/active/{task-id}/task.md
```

## Task id short ref

> If `{task-id}` begins with `#`, follow the "SKILL parameter resolver" section of `.agents/rules/task-short-id.md`; treat `{task-id}` as the resolved full `TASK-YYYYMMDD-HHMMSS` form for every downstream command.

## Steps

### 1. Verify Prerequisites

Require `task.md` and at least one plan artifact: `plan.md` or `plan-r{N}.md`.

### 2. Ensure the Task Branch

Read `reference/branch-management.md`, ensure the current branch matches the task branch, and write the final branch back to task.md when needed.

### 3. Narrow the Milestone

If task.md has a valid `issue_number`, read `.agents/rules/issue-sync.md` and `.agents/rules/milestone-inference.md`; follow Phase 2 for `code-task`.

### 4. Determine Mode and Round

Run mode detection and preserve its exit code:

```bash
result=$(node .agents/skills/code-task/scripts/detect-mode.js .agents/workspace/active/{task-id})
status=$?
echo "$result"
```

Dispatch by `$status` and `result.mode`:

- `0` + `"init"`: initial implementation; record `{code-artifact}` and `{code-round}`
- `0` + `"fix"`: fix mode; record `{code-artifact}`, `{code-round}`, and `{review-artifact}`
- `1` + `"refused"`: print `result.message`, stop, and do not write an artifact or Activity Log entry
- `2` + `"error"`: print `result.message`, stop, and do not write an artifact or Activity Log entry

> Read `reference/dual-mode.md` before this step.

### 5. Determine the Input Plan

Read the highest-round plan artifact and use the `{code-artifact}` selected in step 4. In fix mode, also read `{review-artifact}`.

### 6. Read the Technical Plan

Extract implementation steps, files, test strategy, constraints, risks, and approved tradeoffs.

### 7. Implement the Code

Follow the plan in order.

> Read `reference/code-rules.md` before implementation.
> In fix mode, read `reference/fix-mode.md` before editing.
> Read `.agents/rules/testing-discipline.md` before adding or changing tests.

### 8. Run Test Verification

Use the project test commands from the `test` skill and iterate until all required tests pass.

### 9. Write the Code Report

Create `.agents/workspace/active/{task-id}/{code-artifact}`.

> Read `reference/report-template.md` before writing the report.

### 10. Update Task Status

Get the current time:

```bash
date "+%Y-%m-%d %H:%M:%S%:z"
```

Set `current_step` to `code`, refresh task metadata, and append one Activity Log entry:

- initial implementation: `Code (Round {N})`
- fix mode: `Code (Round {N}, fix for {review-artifact})`

If task.md has a valid `issue_number`, read `.agents/rules/issue-sync.md`, then:
- Set `status: in-progress` according to issue-sync.md
- Create or update the task comment marker defined in `.agents/rules/issue-sync.md`
- Publish the `{code-artifact}` comment

### 11. Run Completion Gate

```bash
node .agents/scripts/validate-artifact.js gate code-task .agents/workspace/active/{task-id} {code-artifact} --format text
```

### 12. Tell the User

Use `reference/output-template.md` and show all TUI command formats.
