---
name: code-task
description: >
  Implement code from the technical plan and output a report.
  Use when an approved technical plan needs implementing, or code review found issues to fix.
  Only invoke this skill automatically when the conversation includes a resolvable task reference.
---

# Code Task

Implement the approved plan and produce `code.md` or `code-r{N}.md`. This skill supports initial implementation, fix mode based on `review-code` feedback, and human-decision-driven implementation.

## Boundary / Critical Rules

- Follow the latest plan artifact: `plan.md` or `plan-r{N}.md`
- Fix mode verifies each finding of the latest `review-code` one by one: fix it if it holds, or rebut it and record it under unresolved if it is unfounded/hallucinated; do not expand to issues the review did not list; manual-validation items are out of scope
- If implementation encounters a key design decision not covered by the plan, run `agent-infra-internal task-ledger {task-id} decision-next-id`, write the returned `HD-N` detail block per `.agents/rules/human-decision-context.md`, then run `decision-upsert --id {HD-N} --stage code --artifact {code-artifact}`. Do not scan ids, assemble ledger rows, ask mid-flow, or silently expand scope
- Never auto-run `git add` or `git commit`
- Create a new code artifact for each round and never overwrite an older one
- After executing this skill, you **must** immediately update task.md

Version stamp rule: when creating or updating `task.md` frontmatter, read `.agents/rules/version-stamp.md` first and write or refresh `agent_infra_version`.

## Step 0: State Check (pre-execution hard gate)

After loading workflow / skill / rules instructions, and before any task-state judgment or user-visible conclusion, run the state check first.

Run these commands and paste the raw output into both the user-facing reply and this round's `## State Check` section:

```bash
agent-infra-internal task-snapshot {task-id} --format text
```

## Task Context Resolution

> The entry point may omit the task ref and also accepts a legacy positional ref or `--task <ref>` / `-t <ref>`. Separate task scope from the full arguments while preserving every business operand, then call `agent-infra-internal task-context resolve {task-scope}` where `{task-scope}` is empty, one positional ref, or one task flag. Read only `taskId` from the structured result and bind `{task-id}` to that full `TASK-YYYYMMDD-HHMMSS` for downstream commands. Pass through resolution failures without scanning tasks locally.

> Resolve the task reference, then confirm that the task is in a state or directory supported by this skill and that `task.md` exists; if it cannot be located, handle it as a missing task and stop.

## Step Start: Write the started Marker

After prerequisites and mode are confirmed and before this round's first artifact action, run `agent-infra-internal task-event {task-id} code.started --agent {agent}`. Append `--fix-for {review-artifact}` in fix mode or `--implementation-input {input-id}` in decision mode. The core derives and validates the round and input identity; record the returned `artifactContext`.

## Steps

### 1. Verify Prerequisites

Require `task.md` and at least one plan artifact: `plan.md` or `plan-r{N}.md`.

### 2. Ensure the Task Branch

Read `reference/branch-management.md`, ensure the current branch matches the task branch, and write the final branch back to task.md when needed.

### 3. Narrow the Milestone

**Mandatory; do not skip.** If task.md has a valid `issue_number`, run `agent-infra-internal platform-issue sync {task-id} --agent {agent} --milestone specific`.

> If this step is skipped or the Issue milestone is still a release line `X.Y.x` afterward, the step-11 `validate-artifact` gate will block the `code-task` round via `verify_milestone_specific` and require narrowing to a specific version (e.g. `0.7.1`) before proceeding.

### 4. Determine Mode and Round

Run mode detection and preserve its exit code:

```bash
result=$(agent-infra-internal task-artifact {task-id} inspect --family code)
status=$?
echo "$result"
```

Dispatch by `$status` and `result.mode`:

- `0` + `"init"`: initial implementation; record `{code-artifact}` and `{code-round}`
- `0` + `"fix"`: fix mode; record `{code-artifact}`, `{code-round}`, and `{review-artifact}`
- `0` + `"decision"`: decision implementation mode; record `{code-artifact}`, `{code-round}`, `{input-id}`, `{decision-id}`, and `{decision-evidence}`
- `1` + `"refused"`: print `result.message`, stop, and do not write an artifact or Activity Log entry
- `2` + `"error"`: print `result.message`, stop, and do not write an artifact or Activity Log entry

> Read `reference/dual-mode.md` before this step.

### 5. Read Structured Inputs

Use only the structured result from step 4: read the selected plan artifact and, in fix mode, the selected review artifact. Use `next.name` as `{code-artifact}` and `next.round` as `{code-round}`. In decision mode, take the unified identity from `implementation_input`, `decision_id`, and `decision_evidence`; do not rescan or construct identities in the skill.

### 6. Read the Technical Plan

Extract implementation steps, files, test strategy, constraints, risks, and approved tradeoffs. In decision mode, also read the `{input-id}` row and its `{decision-evidence}` record in task.md, and implement only that ruling's requested behavior change.

### 7. Implement the Code

Follow the plan in order.

> Read `reference/code-rules.md` before implementation.
> In fix mode, read `reference/fix-mode.md` before editing.
> Read `.agents/rules/testing-discipline.md` before adding or changing tests.

### 8. Run Test Verification

Use the project test commands from the `test` skill and iterate until all required tests pass.

When triaging a test failure or unexpected behavior, first read `.agents/rules/debugging-guide.md` and locate the root cause via its four-phase flow; do not blindly patch and retry.

### 9. Write the Code Report

Create `.agents/workspace/active/{task-id}/{code-artifact}`.

> Read `reference/report-template.md` before writing the report.

### 10. Update Task Status

After requirement checkboxes are updated, run the initial event `agent-infra-internal task-event {task-id} code.completed --agent {agent} --artifact {code-artifact} --files-modified {n} --tests-passed {n}`; in fix mode use `--fix-for {review-artifact} --blockers {n} --major {n} --minor {n} --manual-validation {n}` instead; in decision mode add `--implementation-input {input-id}` to the initial counts. The core atomically records the artifact link, stage, metadata, done log, and decision-input consumption.

If task.md has a valid `issue_number`, read `.agents/rules/issue-sync.md`, then:
- Run `agent-infra-internal platform-issue sync {task-id} --agent {agent} --status in-progress`
- Run `agent-infra-internal platform-comment sync {task-id} --kind task --agent {agent}`
- Run `agent-infra-internal platform-comment sync {task-id} --kind artifact --artifact {code-artifact} --agent {agent}`

### 11. Run Completion Gate

```bash
agent-infra-internal task-verify {task-id} code.completed --artifact {code-artifact} --format text
```

### 12. Tell the User

Use `reference/output-template.md` (or `reference/fix-mode.md` in fix mode) and show all TUI command formats.

> Before rendering the final output, read `.agents/rules/next-step-output.md` and apply both of its rules: (1) render `{task-ref}` in the "Next steps" commands as the current task's short id `#NN` (see that file for lookup and fallback), while other `{task-id}` placeholders (report titles, paths) keep the full TASK-id form; (2) append the `Completed at` line as the very last line of the user-facing output (this applies to every user-facing output — success, error, and early-return paths alike, not only the success path).
