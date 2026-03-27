---
name: refine-task
description: "Handle code review feedback and fix issues"
---

# Refine Task

Fix review findings and produce `refinement.md` or `refinement-r{N}.md`.

## Boundary / Critical Rules

- Fix only the issues documented in review artifacts
- Never auto-run `git add` or `git commit`
- After executing this skill, you **must** immediately update task.md

## Steps

### 1. Verify Prerequisites

Require:
- `.agents/workspace/active/{task-id}/task.md`
- at least one review artifact: `review.md` or `review-r{N}.md`

During prerequisite discovery, record `{review-artifact}`, `{refinement-round}`, `{refinement-artifact}`, and Record `{implementation-artifact}` from the latest implementation report.

Also validate the latest Code Review entry in Activity Log. If it points to a missing file, stop with:
`Review artifact mismatch: Activity Log references {expected} but file not found. Please verify the review artifact exists.`

### 2. Read Review and Implementation Context

Read the latest `{review-artifact}` and `{implementation-artifact}` before editing any code.

### 3. Plan and Apply the Fixes

Prioritize Blocker -> Major -> Minor and keep changes tightly scoped.

> The detailed fix workflow, repair order, and verification loop live in `reference/fix-workflow.md`. Read `reference/fix-workflow.md` before making changes.

### 4. Run Test Verification

Run the project test command after the fixes and keep the repair cycle focused on the documented findings.

### 5. Write the Refinement Report

Create `.agents/workspace/active/{task-id}/{refinement-artifact}`.

> The report structure and example sections live in `reference/report-template.md`. Read `reference/report-template.md` before writing the report.

### 6. Update Task Status

Get the current time:

```bash
date "+%Y-%m-%d %H:%M:%S"
```

Update task.md:
- review the `## Requirements` section and only change items from `- [ ]` to `- [x]` when they are newly satisfied by this round's fixes and passing tests
- append:
  `- {yyyy-MM-dd HH:mm:ss} — **Refinement (Round {N}, for {review-artifact})** by {agent} — Fixed {n} blockers, {n} major, {n} minor issues → {refinement-artifact}`

### 7. Inform User

> **IMPORTANT**: All TUI command formats listed below must be output in full. Do not show only the format for the current AI agent.

After summarizing the fixes, choose the next step based on severity:

If the round fixed any Blocker or Major issues (recommended):

```
Next step - code review:
  - Claude Code / OpenCode: /review-task {task-id}
  - Gemini CLI: /{{project}}:review-task {task-id}
  - Codex CLI: $review-task {task-id}
```

If the round fixed Minor issues only (low risk):

```
Next step - commit changes:
  - Claude Code / OpenCode: /commit
  - Gemini CLI: /{{project}}:commit
  - Codex CLI: $commit
```

## Completion Checklist

- [ ] Read the latest review and implementation context
- [ ] Fixed all required Blocker and Major findings
- [ ] Wrote `{refinement-artifact}`
- [ ] Updated task.md and appended the Activity Log entry
- [ ] Recommended the correct next step based on residual risk

## Notes

- Round 1 uses `refinement.md`; later rounds use `refinement-r{N}.md`
- Record any disagreement with a review comment under unresolved issues in the report
- Do not expand scope beyond the review findings

## STOP

Stop after the checklist is complete.

## Error Handling

- Task not found: `Task {task-id} not found`
- Missing review report: `Review report not found, please run the review-task skill first`
- Review artifact mismatch: `Review artifact mismatch: Activity Log references {expected} but file not found. Please verify the review artifact exists.`
