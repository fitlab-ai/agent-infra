---
name: review-code
description: >
  Review code implementation and output a code review report.
  Use when a code implementation needs review before merging.
  Only invoke this skill automatically when the conversation includes a resolvable task reference.
---

# Code Review
> `--agent` values are defined in `.agents/rules/task-management.md` under “Collaborator Token Specification”.

If the entry operands contain `--orchestrated`, bind `{execution-flag}` to `--orchestrated` and forward it unchanged to both the summary finalizer and completed event; otherwise bind it to an empty value. Never infer it from `orchestration.json`, environment variables, or prior artifacts.

Review the latest code round and produce `review-code.md` or `review-code-r{N}.md`.

## Boundary / Critical Rules

- This skill reviews code and writes a report; it does not modify product code
- Before generating task or lifecycle Markdown that will be synchronized to an Issue, read `.agents/rules/sync-content-generation.md` and apply its producer-side constraints; the sync path does not parse or rewrite the body
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

Run these commands and paste the raw output into this round's `## State Check` section:

```bash
agent-infra-internal task-snapshot {task-id} --format text
```

Before the state check is complete, do not make external-state assertions such as "the code is unchanged", "tests passed", or "there are no other references", including in reasoning. This gate is only a structural floor; evidence pairing and authenticity still require the report template and review discipline.

## Task Context Resolution

> The entry point may omit the task ref; explicit task scope accepts only `--task <ref>` or `-t <ref>`, and positional task refs are not interpreted. Preserve every other business operand, then call `agent-infra-internal task-context resolve {task-scope}` where `{task-scope}` is empty or one task flag. Read only `taskId` from the structured result and bind `{task-id}` to the full `TASK-YYYYMMDD-HHMMSS` for downstream commands. Pass through resolution failures without scanning tasks locally.

> Resolve the task reference, then confirm that the task is in a state or directory supported by this skill and that `task.md` exists; if it cannot be located, handle it as a missing task and stop.

## Step Start: Write the started Marker

After resolving the artifact context and before this round's first artifact action, run `agent-infra-internal task-event {task-id} review-code.started --agent {standard-agent-token}`.

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
- Resolve the task's bound delivery remote/base and read the target SHA once at review start, `M=$(git ls-remote --refs {remote} refs/heads/{baseRef})`; then capture the reviewed commit `R=$(git rev-parse HEAD)` once and compute `D=$(git merge-base "$R" "$M")`. Save M/D/R as historical evidence and never overwrite them with a later live target value
- If the delivery target cannot be resolved or its target commit is unavailable, stop and record the target error; M/D/R must come from one fact-collection round and must not be replaced by PR-existence evidence
- `git diff --binary "$D" -- <post-review-globs>` covers committed and uncommitted tracked changes from D to the current worktree
- `git ls-files -o --exclude-standard -z -- <post-review-globs>` for untracked new files
- Write `mode=worktree`, `baseline=R`, and `diffBase=D` to a temporary JSON file, then call `agent-infra-internal git-workflow snapshot --input {file}` to generate a reviewed diff fingerprint `F` for the complete committed range and a reviewed snapshot tree `T` for the current worktree; write M, R, D, F, and T into the report

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
- After the report, submit each new finding with `agent-infra-internal task-ledger {task-id} finding-upsert --stage code --review-artifact {review-artifact} --ordinal {n} --severity {blocker|major|minor} --evidence {review-artifact}#{anchor}`; submit prior-response dispositions with `finding-review --id {ledger-id} --status {confirmed|closed|open|needs-human-decision} --evidence {evidence}`. When escalating to `needs-human-decision`, append `--needs-implementation true|false` using the judgment recorded in the detail block. Do not scan ids or edit ledger rows
- After all ledger writes, make the initial call to `agent-infra-internal task-review {task-id} finalize-summary --stage code --artifact {review-artifact} {execution-flag}`; after a failure, follow `.agents/rules/local-artifact-repair.md` to decide whether to edit and rerun, and never treat an error type or `changed=false` as automatic authorization

  Bind and reuse this structured mapping from that one response:

  ```text
  {unresolved-blockers} = stageStatus.unresolvedFindingCounts.blocker
  {unresolved-major} = stageStatus.unresolvedFindingCounts.major
  {unresolved-minor} = stageStatus.unresolvedFindingCounts.minor
  ```

  The intent atomically finalizes the report summary and returns the same ledger snapshot. Do not call `stage-status`, replace placeholders manually, or rescan the finding list. After a failure, the model may edit the same controlled artifact and rerun the same intent only when the shared rule's mechanical gates pass; reassess convergence after every failure. The final complete result determines the verdict and counts from that same snapshot: `stageStatus.canAdvance=true` with an Approved conclusion permits cross-stage advancement; `stageStatus.canAdvance=false` still requires `agent-infra-internal task-event {task-id} review-code.completed --agent {standard-agent-token} --artifact {review-artifact} --verdict {approved|changes-requested|rejected} --blockers {unresolved-blockers} --major {unresolved-major} --minor {unresolved-minor} --manual-validation {n} {execution-flag}`, using `changes-requested` and routing to same-stage revision/review (use `rejected` when the report explicitly rejects). On failure, model stop, lack of progress, or the emergency cap, do not publish a completion event or cross-stage command; use the `repair-stop` scenario in `reference/output-templates.md` to show existing summary/findings, the artifact, actual repair attempts, the last diagnostic, and the stop reason
- Only when `canAdvance=true`, the verdict is Approved, and `T == R^{tree}`, write `last_reviewed_commit: {R}`. Clear an old value for an Approved snapshot with uncommitted differences; otherwise preserve the existing value and do not advance it
- For an Approved exit, collect PR and all-check facts as defined in `reference/output-templates.md`: route uncommitted/unpushed code to `commit`, no PR to `create-pr` (except no-PR flow), non-terminal checks to `watch-pr`, and route to `complete-task` only when `HEAD == last_reviewed_commit == PR head` with checks `passed|no-required`; never route by review round alone
- After handling `last_reviewed_commit`, run `agent-infra-internal task-event {task-id} review-code.completed --agent {standard-agent-token} --artifact {review-artifact} --verdict {approved|changes-requested|rejected} --blockers {unresolved-blockers} --major {unresolved-major} --minor {unresolved-minor} --manual-validation {n} {execution-flag}`

Always include the `Manual-validation: {n}` field in the done log, including when it is 0.
`manual-validation` is the data source for the `Manual-validation` count folded into review rows in `ai task log`; do not add a parallel manual-verification field.

If task.md contains a valid `issue_number`, perform these sync actions (skip and continue on any failure):
- Run `agent-infra-internal platform-issue sync {task-id} --agent {standard-agent-token} --status in-progress`
- Run `agent-infra-internal platform-comment sync {task-id} --kind task --agent {standard-agent-token}`
- Run `agent-infra-internal platform-comment sync {task-id} --kind artifact --artifact {review-artifact} --agent {standard-agent-token}`

Before writing the summary, the finalization intent checks decision-detail ids; any visible duplicate returns a structured failure and preserves the artifact bytes, while the model decides whether a minimal edit is safe under the shared rule. If the safety gates fail, diagnostics repeat, no byte-level progress occurs, or the emergency cap is reached, stop before the completion event; the stop path must still show the existing review result instead of hiding the artifact.

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

render the selected next-step commands through the shared helper. If `.agents/.airc.json` configures custom TUIs (via `customTUIs`), read each tool's `name` and `invoke`, then add the matching command line in the same format (`${skillName}` becomes the skill name and `${projectName}` becomes the project name).

## Completion Checklist

- [ ] Reviewed the latest implementation context
- [ ] Created `{review-artifact}`
- [ ] Updated task.md and appended the Activity Log entry
- [ ] Chose exactly one verdict branch in the user output
- [ ] Rendered the selected next-step commands through the shared helper

## Notes

- Round 1 uses `review-code.md`; later rounds use `review-code-r{N}.md`
- Always cite concrete file paths and line numbers in findings
- Review severity must distinguish blockers, major issues, and minor issues

## Error Handling

- Task not found: `Task {task-id} not found`
- Missing code report: `Code report not found, please run the code-task skill first`
