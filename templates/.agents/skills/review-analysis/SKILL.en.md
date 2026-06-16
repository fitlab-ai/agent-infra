---
name: review-analysis
description: "Review the requirement analysis artifact"
---

# Requirement Analysis Review

Review the latest analysis artifact and produce `review-analysis.md` or `review-analysis-r{N}.md`.

## Boundary / Critical Rules

- This skill only reviews analysis artifacts and writes a report; it does not modify product code.
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

Require `task.md` and at least one analysis artifact: `analysis.md` or `analysis-r{N}.md`.

### 2. Determine Review Round

Record `{analysis-artifact}`, `{review-round}`, and `{review-artifact}` (`review-analysis.md` or `review-analysis-r{N}.md`).

### 3. Read Analysis Context

Read `{analysis-artifact}`, `task.md`, and Issue context when available.

### 4. Perform Review

Check requirement completeness, risks, affected scope, open questions, and effort estimates.

> Read `reference/review-criteria.md` before this step.

### 5. Write Review Report

Create `.agents/workspace/active/{task-id}/{review-artifact}`.

> Read `reference/report-template.md` before writing the report.

### 6. Update Task Status

Get the current time:

```bash
date "+%Y-%m-%d %H:%M:%S%:z"
```

Set `current_step` to `requirement-analysis-review`, refresh task metadata, and append:
`- {YYYY-MM-DD HH:mm:ss±HH:MM} — **Review Analysis (Round {N})** by {agent} — Verdict: {Approved/Changes Requested/Rejected}, blockers: {n}, major: {n}, minor: {n}[ (+ {n} env-blocked)] → {review-artifact}`

If task.md has a valid `issue_number`, read `.agents/rules/issue-sync.md`, sync the task comment, and publish the `{review-artifact}` comment.

### 7. Run Completion Gate

```bash
node .agents/scripts/validate-artifact.js gate review-analysis .agents/workspace/active/{task-id} {review-artifact} --format text
```

### 8. Tell the User

Use the conclusion branch in `reference/output-templates.md` and show all TUI command formats.

> Before rendering the final output, read `.agents/rules/next-step-output.md` and apply both of its rules: (1) render `{task-ref}` in the "Next steps" commands as the current task's short id `#NN` (see that file for lookup and fallback), while other `{task-id}` placeholders (report titles, paths) keep the full TASK-id form; (2) append the `Completed at` line as the very last line of the user-facing output (this applies to every user-facing output — success, error, and early-return paths alike, not only the success path).
