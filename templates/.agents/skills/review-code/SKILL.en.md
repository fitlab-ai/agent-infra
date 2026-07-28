---
name: review-code
description: >
  Review code implementation and output a code review report.
  Use when a code implementation needs review before merging.
  Only invoke this skill automatically when the conversation includes a resolvable task reference.
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
agent-infra-internal task-snapshot {task-id} --format text
```

Before the state check is complete, do not make external-state assertions such as "the code is unchanged", "tests passed", or "there are no other references", including in reasoning. This gate is only a structural floor; evidence pairing and authenticity still require the report template and review discipline.

## Task Context Resolution

> The entry point may omit the task ref and also accepts a legacy positional ref or `--task <ref>` / `-t <ref>`. Separate task scope from the full arguments while preserving every business operand, then call `agent-infra-internal task-context resolve {task-scope}` where `{task-scope}` is empty, one positional ref, or one task flag. Read only `taskId` from the structured result and bind `{task-id}` to that full `TASK-YYYYMMDD-HHMMSS` for downstream commands. Pass through resolution failures without scanning tasks locally.

> Resolve the task reference, then confirm that the task is in a state or directory supported by this skill and that `task.md` exists; if it cannot be located, handle it as a missing task and stop.

## Step Start: Write the started Marker

After resolving the artifact context and before this round's first artifact action, run `agent-infra-internal task-event {task-id} review-code.started --agent {agent}`.

## Steps

### 1. Verify Prerequisites

Require:
- `.agents/workspace/active/{task-id}/task.md`
- at least one code artifact: `code.md` or `code-r{N}.md`

### 2. Resolve the Artifact Context

Run `agent-infra-internal task-artifact {task-id} inspect --family review-code`. Continue only for `ready`; take the latest `{code-artifact}` from `inputs` and `{review-round}` / `{review-artifact}` from `next.round` / `next.name`. Do not scan rounds or construct names in the skill. Then run the started event and verify the returned identity.

### 3. Read Implementation and Refinement Context

Read the highest-round code artifact and, if present, the highest-round fix artifact. After reading, record the actually reviewed highest-round code artifact (and the highest-round fix artifact, if present) by filename in the report's `Review Input` field; leave it blank when it cannot be reliably determined—do not fabricate.

### 4. Perform the Review

Follow `.agents/workflows/feature-development.yaml` and inspect the full change context:
- Capture the reviewed commit `R=$(git rev-parse HEAD)` exactly once; reuse R for this round's report, snapshot tree, and task review fact, and do not re-read HEAD later as a substitute
- Call `agent-infra-internal platform-pr inspect {task-id}`. When a bound PR provides a base SHA, set the diff base to `D=$(git merge-base "$R" "{base-sha}")`. Without a PR, set `D=$R` only when tracked or untracked worktree changes exist. A clean worktree without a bound PR has no reliable complete committed range: stop and require a bound PR instead of reviewing an empty diff
- `git diff --binary "$D" -- <post-review-globs>` covers committed and uncommitted tracked changes from D to the current worktree
- `git ls-files -o --exclude-standard -z -- <post-review-globs>` for untracked new files
- Write `mode=worktree`, `baseline=R`, and `diffBase=D` to a temporary JSON file, then call `agent-infra-internal git-workflow snapshot --input {file}` to generate a reviewed diff fingerprint `F` for the complete committed range and a reviewed snapshot tree `T` for the current worktree; write R, D, F, and T into the report

> After collecting those facts, read `.agents/rules/review-method.md`, use them as readiness evidence, and run Passes 2–5 for traceability, risk lenses, counterevidence, and classification; the report must record all five passes.
> Detailed review criteria, severity rules, and reviewer expectations live in `reference/review-criteria.md`. Read `reference/review-criteria.md` before reviewing.

Apply the shared five-pass protocol to code in this order:
- Pass 1 reads the complete diff, untracked files, latest code artifact, approved plan/review-plan, task source, and raw test results.
- Pass 2 maps acceptance/plan → implementation → verification and records changed lines, necessary callers/callees, state/data flow, and uncovered areas per file.
- Pass 3 reviews overall design before per-file semantics, evaluates every shared registry trigger, and reads every matched reference in full. Test changes load `.agents/rules/testing-discipline.md` through the registry's `testing-discipline` lens; do not maintain a second trigger list.
- Pass 4 checks guards, call constraints, test coverage, and narrower impact boundaries as counterevidence.
- Pass 5 reconciles findings, manual-validation, advisories, evidence types, unverified assumptions, ledger state, and verdict.

Complete the code implementation coverage in `reference/report-template.md`. Approval is forbidden when a matched reference is missing or unloaded, or when a risk gap remains unclassified.

### 5. Write the Review Report

Create `.agents/workspace/active/{task-id}/{review-artifact}`.

> The report format and severity layout live in `reference/report-template.md`. Read `reference/report-template.md` before writing the review.

### 6. Update Task Status

Update task.md:
- After the report, submit each new finding with `agent-infra-internal task-ledger {task-id} finding-upsert --stage code --review-artifact {review-artifact} --ordinal {n} --severity {blocker|major|minor} --evidence {review-artifact}#{anchor}`; submit prior-response dispositions with `finding-review --id {ledger-id} --status {confirmed|closed|open|needs-human-decision} --evidence {evidence}`. Do not scan ids or edit ledger rows
- After all ledger writes, call `agent-infra-internal task-ledger {task-id} stage-status --stage code` exactly once. Derive the verdict and next-step branch from `stageStatus.canAdvance`, and blocker/major/minor event counts from `unresolvedFindingCounts`; only `canAdvance=true` permits Approved
- Only when `canAdvance=true`, the verdict is Approved, and `T == R^{tree}`, write `last_reviewed_commit: {R}`. Clear an old value for an Approved snapshot with uncommitted differences; otherwise preserve the existing value and do not advance it
- For an Approved exit, collect PR and required-checks facts as defined in `reference/output-templates.md`: route uncommitted/unpushed code to `commit`, no PR to `create-pr` (except no-PR flow), non-terminal checks to `watch-pr`, and route to `complete-task` only when `HEAD == last_reviewed_commit == PR head` with checks `passed|no-required`; never route by review round alone
- After handling `last_reviewed_commit`, run `agent-infra-internal task-event {task-id} review-code.completed --agent {agent} --artifact {review-artifact} --verdict {approved|changes-requested|rejected} --blockers {n} --major {n} --minor {n} --manual-validation {n}`

Always include the `Manual-validation: {n}` field in the done log, including when it is 0.
`manual-validation` is the data source for the `Manual-validation` count folded into review rows in `ai task log`; do not add a parallel manual-verification field.

If task.md contains a valid `issue_number`, perform these sync actions (skip and continue on any failure):
- Run `agent-infra-internal platform-issue sync {task-id} --agent {agent} --status in-progress`
- Run `agent-infra-internal platform-comment sync {task-id} --kind task --agent {agent}`
- Run `agent-infra-internal platform-comment sync {task-id} --kind artifact --artifact {review-artifact} --agent {agent}`

### 7. Verification Gate

Run the verification gate to confirm the task artifact and sync state are valid:

```bash
agent-infra-internal task-verify {task-id} review-code.completed --artifact {review-artifact} --format text
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
- `stageStatus.canAdvance=true` -> approved
- `stageStatus.canAdvance=false` and focused fixes are sufficient -> changes requested
- major redesign or re-implementation needed -> rejected

manual-validation counts do not influence branch selection; they are displayed only as manual validation counts.

> The full four-branch output templates, selection rules, and prohibition clauses live in `reference/output-templates.md`. Read `reference/output-templates.md` before reporting the review result.

> Before rendering the final output, read `.agents/rules/next-step-output.md` and apply both of its rules: (1) render `{task-ref}` in the "Next steps" commands as the current task's short id `NN` (see that file for lookup and fallback), while other `{task-id}` placeholders (report titles, paths) keep the full TASK-id form; (2) append the `Completed at` line as the very last line of the user-facing output (this applies to every user-facing output — success, error, and early-return paths alike, not only the success path).

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
