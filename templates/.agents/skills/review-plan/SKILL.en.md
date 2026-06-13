---
name: review-plan
description: "Review the technical plan"
---

# Technical Plan Review

Review the latest plan artifact and produce `review-plan.md` or `review-plan-r{N}.md`.

## Boundary / Critical Rules

- This skill only reviews plan artifacts and writes a report; it does not modify product code.
- After executing this skill, you **must** immediately update task.md.

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

> If `{task-id}` matches `^[#]?[0-9]+$` (bare numeric or `#`-prefixed), follow the "SKILL parameter resolver" section of `.agents/rules/task-short-id.md`; treat `{task-id}` as the resolved full `TASK-YYYYMMDD-HHMMSS` form for every downstream command.

## Steps

### 1. Verify Prerequisites

Require `task.md` and at least one plan artifact: `plan.md` or `plan-r{N}.md`.

### 2. Determine Review Round

Record `{plan-artifact}`, `{review-round}`, and `{review-artifact}` (`review-plan.md` or `review-plan-r{N}.md`).

### 3. Read Plan Context

Read `{plan-artifact}`, the latest analysis artifact, `task.md`, and Issue context when available.

### 4. Perform Review

Check simplicity, executability, risk control, test strategy, file coverage, and phase boundaries.

> Read `reference/review-criteria.md` before this step.

### 5. Write Review Report

Create `.agents/workspace/active/{task-id}/{review-artifact}`.

> Read `reference/report-template.md` before writing the report.

### 6. Update Task Status

Get the current time:

```bash
date "+%Y-%m-%d %H:%M:%S%:z"
```

Set `current_step` to `technical-design-review`, refresh task metadata, and append:
`- {YYYY-MM-DD HH:mm:ss±HH:MM} — **Plan Review (Round {N})** by {agent} — Verdict: {Approved/Changes Requested/Rejected}, blockers: {n}, major: {n}, minor: {n}[ (+ {n} env-blocked)] → {review-artifact}`

If task.md has a valid `issue_number`, read `.agents/rules/issue-sync.md`, sync the task comment, and publish the `{review-artifact}` comment.

### 7. Run Completion Gate

```bash
node .agents/scripts/validate-artifact.js gate review-plan .agents/workspace/active/{task-id} {review-artifact} --format text
```

### 8. Tell the User

Use the conclusion branch in `reference/output-templates.md` and show all TUI command formats.

> When rendering "Next steps" commands, `{task-ref}` uses the verbatim `{task-id}` argument from this invocation (bare numeric / `#NN` / full `TASK-id`). Other `{task-id}` placeholders (report titles, paths) keep the full TASK-id form.
