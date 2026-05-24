---
name: review-task
description: "Review a task implementation and output a code review report"
---

# Code Review

Review the latest implementation round and produce `review.md` or `review-r{N}.md`.

## Boundary / Critical Rules

- This skill reviews code and writes a report; it does not modify product code
- After executing this skill, you **must** immediately update task.md

Version stamp rule: when creating or updating `task.md` frontmatter, read `.agents/rules/version-stamp.md` first and write or refresh `agent_infra_version`.

## Common Rationalizations and Rebuttals

| Rationalization | Rebuttal |
|------|------|
| "It was only one line, so it cannot affect behavior." | Line count is not impact; read the full `git diff` and trace the downstream effect of each change. |
| "It looks mostly fine, so approve it." | The verdict must be backed by blocker/major/minor counts, and every finding must cite file:line; do not approve from impression. |
| "The test change looks reasonable, so I can skim it." | Before reviewing test changes, check `.agents/rules/testing-discipline.md` item by item (see the step 4 gate). |

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
> Test review gate: when `git diff` touches test files, read `.agents/rules/testing-discipline.md` first and check it item by item, especially "do not add negative assertions when a positive assertion already covers the behavior".

### 5. Write the Review Report

Create `.agents/workspace/active/{task-id}/{review-artifact}`.

> The report format and severity layout live in `reference/report-template.md`. Read `reference/report-template.md` before writing the review.

### 6. Update Task Status

Get the current time:

```bash
date "+%Y-%m-%d %H:%M:%S%:z"
```

Update task.md and append:
`- {YYYY-MM-DD HH:mm:ss±HH:MM} — **Code Review (Round {N})** by {agent} — Verdict: {Approved/Changes Requested/Rejected}, blockers: {n}, major: {n}, minor: {n}[ (+ {n} env-blocked)] → {artifact-filename}`

Omit the bracketed segment when env-blocked = 0; append ` (+ {n} env-blocked)` when env-blocked > 0.

If task.md contains a valid `issue_number`, perform these sync actions (skip and continue on any failure):
- Read `.agents/rules/issue-sync.md` before syncing, and complete upstream repository detection plus permission detection
- Set `status: in-progress` by following issue-sync.md
- Create or update the task comment marker defined in `.agents/rules/issue-sync.md` (follow the task.md comment sync rule in issue-sync.md)
- Publish the `{review-artifact}` comment

### 7. Verification Gate

Run the verification gate to confirm the task artifact and sync state are valid:

```bash
node .agents/scripts/validate-artifact.js gate review-task .agents/workspace/active/{task-id} {review-artifact} --format text
```

Handle the result as follows:
- exit code 0 (all checks passed) -> continue to the "Inform User" step
- exit code 1 (validation failed) -> fix the reported issues and run the gate again
- exit code 2 (network blocked) -> stop and tell the user that human intervention is required

Keep the gate output in your reply as fresh evidence. Do not claim completion without output from this run.

### 8. Inform User

> Execute this step only after the verification gate passes.

Choose exactly one branch based on the findings:
- no blockers, no major, no minor -> approved with no issues
- no blockers, but major or minor findings -> approved with issues
- blockers that can be fixed in a focused pass -> changes requested
- major redesign or re-implementation needed -> rejected

env-blocked counts do not influence branch selection; they are appended to the summary line only.

> The full four-branch output templates, selection rules, and prohibition clauses live in `reference/output-templates.md`. Read `reference/output-templates.md` before reporting the review result.

Include all TUI command formats in the next-step output. If `.agents/.airc.json` configures custom TUIs (via `customTUIs`), read each tool's `name` and `invoke`, then add the matching command line in the same format (`${skillName}` becomes the skill name and `${projectName}` becomes the project name).

## Completion Checklist

- [ ] Reviewed the latest implementation context
- [ ] Created `{review-artifact}`
- [ ] Updated task.md and appended the Activity Log entry
- [ ] Chose exactly one verdict branch in the user output
- [ ] Informed the user of the next step (must include all TUI command formats, including any custom TUIs; do not filter)

## Notes

- Round 1 uses `review.md`; later rounds use `review-r{N}.md`
- Always cite concrete file paths and line numbers in findings
- Review severity must distinguish blockers, major issues, and minor issues

## Error Handling

- Task not found: `Task {task-id} not found`
- Missing implementation report: `Implementation report not found, please run the implement-task skill first`
