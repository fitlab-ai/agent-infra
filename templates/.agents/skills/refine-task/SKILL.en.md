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
date "+%Y-%m-%d %H:%M:%S%:z"
```

Update task.md:
- review the `## Requirements` section and only change items from `- [ ]` to `- [x]` when they are newly satisfied by this round's fixes and passing tests
- append:
  `- {YYYY-MM-DD HH:mm:ss±HH:MM} — **Refinement (Round {N}, for {review-artifact})** by {agent} — Fixed {n} blockers, {n} major, {n} minor issues → {refinement-artifact}`

If task.md contains a valid `issue_number`, perform these sync actions (skip and continue on any failure):
- Read `.agents/rules/issue-sync.md` before syncing, and complete upstream repository detection plus permission detection
- Set `status: in-progress` by following issue-sync.md
- Create or update the `<!-- sync-issue:{task-id}:task -->` comment (follow the task.md comment sync rule in issue-sync.md)
- Publish the `{refinement-artifact}` comment

### 7. Verification Gate

Run the verification gate to confirm the task artifact and sync state are valid:

```bash
node .agents/scripts/validate-artifact.js gate refine-task .agents/workspace/active/{task-id} {refinement-artifact} --format text
```

Handle the result as follows:
- exit code 0 (all checks passed) -> continue to the "Inform User" step
- exit code 1 (validation failed) -> fix the reported issues and run the gate again
- exit code 2 (network blocked) -> stop and tell the user that human intervention is required

Keep the gate output in your reply as fresh evidence. Do not claim completion without output from this run.

### 8. Inform User

> Execute this step only after the verification gate passes.

> **IMPORTANT**: All TUI command formats listed below must be output in full. Do not show only the format for the current AI agent. If `.agents/.airc.json` configures custom TUIs (via `customTUIs`), read each tool's `name` and `invoke`, then add the matching command line in the same format (`${skillName}` becomes the skill name and `${projectName}` becomes the project name).

After summarizing the fixes, present the next step:

```
Next step - re-review or commit:
- Re-review (always recommended):
  - Claude Code / OpenCode: /review-task {task-id}
  - Gemini CLI: /{{project}}:review-task {task-id}
  - Codex CLI: $review-task {task-id}
- Commit directly (optional; only when all issues are resolved and changes are low risk):
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
