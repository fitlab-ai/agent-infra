---
name: review-task
description: "Review a task implementation and output a code review report"
---

# Code Review

Review the latest implementation round and produce `review.md` or `review-r{N}.md`.

## Boundary / Critical Rules

- This skill reviews code and writes a report; it does not modify product code
- After executing this skill, you **must** immediately update task.md

## Steps

### 1. Verify Prerequisites

Require:
- `.agents/workspace/active/{task-id}/task.md`
- at least one implementation artifact: `implementation.md` or `implementation-r{N}.md`

### 2. Determine Review Round

Scan the task directory and record:
- `{review-round}`
- `{review-artifact}` as `review.md` or `review-r{N}.md`

### 3. Read Implementation and Refinement Context

Read the highest-round implementation artifact and, if present, the highest-round refinement artifact.

### 4. Perform the Review

Follow `.agents/workflows/feature-development.yaml` and inspect `git diff` for the full change context.

> Detailed review criteria, severity rules, and reviewer expectations live in `reference/review-criteria.md`. Read `reference/review-criteria.md` before reviewing.

### 5. Write the Review Report

Create `.agents/workspace/active/{task-id}/{review-artifact}`.

> The report format and severity layout live in `reference/report-template.md`. Read `reference/report-template.md` before writing the review.

### 6. Update Task Status

Get the current time:

```bash
date "+%Y-%m-%d %H:%M:%S"
```

Update task.md and append:
`- {yyyy-MM-dd HH:mm:ss} — **Code Review (Round {N})** by {agent} — Verdict: {Approved/Changes Requested/Rejected}, blockers: {n}, major: {n}, minor: {n} → {artifact-filename}`

### 7. Inform User

Choose exactly one branch based on the findings:
- no blockers, no major, no minor -> approved with no issues
- no blockers, but major or minor findings -> approved with issues
- blockers that can be fixed in a focused pass -> changes requested
- major redesign or re-implementation needed -> rejected

> The full four-branch output templates, selection rules, and prohibition clauses live in `reference/output-templates.md`. Read `reference/output-templates.md` before reporting the review result.

Include all TUI command formats in the next-step output.

## Completion Checklist

- [ ] Reviewed the latest implementation context
- [ ] Created `{review-artifact}`
- [ ] Updated task.md and appended the Activity Log entry
- [ ] Chose exactly one verdict branch in the user output
- [ ] Informed the user of the next step (must include all TUI command formats; do not filter)

## Notes

- Round 1 uses `review.md`; later rounds use `review-r{N}.md`
- Always cite concrete file paths and line numbers in findings
- Review severity must distinguish blockers, major issues, and minor issues

## Error Handling

- Task not found: `Task {task-id} not found`
- Missing implementation report: `Implementation report not found, please run the implement-task skill first`
