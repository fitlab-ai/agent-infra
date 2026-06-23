---
name: review-code
description: "Review code implementation and output a code review report"
---

# Code Review

Review the latest code round and produce `review-code.md` or `review-code-r{N}.md`.

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
| "I'm sure it's that line, no need to check." | Line numbers drift; verify `file:line` via rg/nl before concluding, and do not file a blocker you cannot reproduce. |

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

After prerequisites pass and before this round's first artifact action, append a started marker to task.md `## Activity Log` (same base action as this round's done entry plus a ` [started]` suffix, note `started`):

```
- {YYYY-MM-DD HH:mm:ss±HH:MM} — **Review Code (Round {N}) [started]** by {agent} — started
```

`ai task log` pairs it with the done entry written when the review completes onto one row (in progress → done). Format and pairing rules: see the "Activity Log started / done dual-marker convention" in `.agents/rules/task-management.md`.

## Steps

### 1. Verify Prerequisites

Require:
- `.agents/workspace/active/{task-id}/task.md`
- at least one code artifact: `code.md` or `code-r{N}.md`

### 2. Determine Review Round

Scan the task directory and record:
- `{review-round}`
- `{review-artifact}` as `review-code.md` or `review-code-r{N}.md`

### 3. Read Implementation and Refinement Context

Read the highest-round code artifact and, if present, the highest-round fix artifact.

### 4. Perform the Review

Follow `.agents/workflows/feature-development.yaml` and inspect the full change context:
- `git diff --binary HEAD -- <post-review-globs>` for tracked changes
- `git ls-files -o --exclude-standard -z -- <post-review-globs>` for untracked new files
- `node .agents/scripts/review-diff-fingerprint.js worktree HEAD` for the reviewed diff fingerprint; write it into the report

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
`- {YYYY-MM-DD HH:mm:ss±HH:MM} — **Review Code (Round {N})** by {agent} — Verdict: {Approved/Changes Requested/Rejected}, blockers: {n}, major: {n}, minor: {n}[ (+ {n} env-blocked)] → {artifact-filename}`

Omit the bracketed segment when env-blocked = 0; append ` (+ {n} env-blocked)` when env-blocked > 0.
`env-blocked` is the data source for the `Manual-verify` count folded into review rows in `ai task log`; do not add a parallel manual-verification field.

If task.md contains a valid `issue_number`, perform these sync actions (skip and continue on any failure):
- Read `.agents/rules/issue-sync.md` before syncing, and complete upstream repository detection plus permission detection
- Set `status: in-progress` by following issue-sync.md
- Create or update the task comment marker defined in `.agents/rules/issue-sync.md` (follow the task.md comment sync rule in issue-sync.md)
- Publish the `{review-artifact}` comment

### 7. Verification Gate

Run the verification gate to confirm the task artifact and sync state are valid:

```bash
node .agents/scripts/validate-artifact.js gate review-code .agents/workspace/active/{task-id} {review-artifact} --format text
```

Handle the result as follows:
- exit code 0 (all checks passed) -> continue to the "Inform User" step
- exit code 1 (validation failed) -> fix the reported issues and run the gate again
- exit code 2 (network blocked) -> stop and tell the user that human intervention is required

Keep the gate output in your reply as fresh evidence. Do not claim completion without output from this run.

### 8. Inform User

> Execute this step only after the verification gate passes.

> **Important — branch labels are not values for the verdict field**. The four labels below are user-output template categories (scenarios A/B/C/D), **not** values for the `**Overall Verdict**:` field. The field accepts exactly one of the three canonical values (`Approved` / `Changes Requested` / `Rejected`, or zh-CN `通过` / `需要修改` / `拒绝`); combined phrases like `Approved with issues` will be rejected by the verify gate.

Choose exactly one branch based on the findings:
- no blockers, no major, no minor -> approved with no issues
- no blockers, but major or minor findings -> approved with issues
- blockers that can be fixed in a focused pass -> changes requested
- major redesign or re-implementation needed -> rejected

env-blocked counts do not influence branch selection; they are appended to the summary line only.

> The full four-branch output templates, selection rules, and prohibition clauses live in `reference/output-templates.md`. Read `reference/output-templates.md` before reporting the review result.

> Before rendering the final output, read `.agents/rules/next-step-output.md` and apply both of its rules: (1) render `{task-ref}` in the "Next steps" commands as the current task's short id `#NN` (see that file for lookup and fallback), while other `{task-id}` placeholders (report titles, paths) keep the full TASK-id form; (2) append the `Completed at` line as the very last line of the user-facing output (this applies to every user-facing output — success, error, and early-return paths alike, not only the success path).

Include all TUI command formats in the next-step output. If `.agents/.airc.json` configures custom TUIs (via `customTUIs`), read each tool's `name` and `invoke`, then add the matching command line in the same format (`${skillName}` becomes the skill name and `${projectName}` becomes the project name).

## Completion Checklist

- [ ] Reviewed the latest implementation context
- [ ] Created `{review-artifact}`
- [ ] Updated task.md and appended the Activity Log entry
- [ ] Chose exactly one verdict branch in the user output
- [ ] Informed the user of the next step (must include all TUI command formats, including any custom TUIs; do not filter)

## Notes

- Round 1 uses `review-code.md`; later rounds use `review-code-r{N}.md`
- Always cite concrete file paths and line numbers in findings
- Review severity must distinguish blockers, major issues, and minor issues

## Error Handling

- Task not found: `Task {task-id} not found`
- Missing code report: `Code report not found, please run the code-task skill first`
