---
name: review-plan
description: >
  Review the technical plan.
  Use when a technical plan needs review before implementation.
  Only invoke this skill automatically when the conversation includes a resolvable task reference.
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
agent-infra-internal task-snapshot {task-id} --format text
```

## Task Context Resolution

> The entry point may omit the task ref and also accepts a legacy positional ref or `--task <ref>` / `-t <ref>`. Separate task scope from the full arguments while preserving every business operand, then call `agent-infra-internal task-context resolve {task-scope}` where `{task-scope}` is empty, one positional ref, or one task flag. Read only `taskId` from the structured result and bind `{task-id}` to that full `TASK-YYYYMMDD-HHMMSS` for downstream commands. Pass through resolution failures without scanning tasks locally.

> Resolve the task reference, then confirm that the task is in a state or directory supported by this skill and that `task.md` exists; if it cannot be located, handle it as a missing task and stop.

## Step Start: Write the started Marker

After resolving the artifact context and before this round's first artifact action, run `agent-infra-internal task-event {task-id} review-plan.started --agent {agent}`.

## Steps

### 1. Verify Prerequisites

Require `task.md` and at least one plan artifact: `plan.md` or `plan-r{N}.md`.

### 2. Resolve the Artifact Context

Run `agent-infra-internal task-artifact {task-id} inspect --family review-plan`. Continue only for `ready`; take `{plan-artifact}` from `inputs` and `{review-round}` / `{review-artifact}` from `next.round` / `next.name`. Do not scan rounds or construct names in the skill. Then run the started event and verify the returned identity.

### 3. Read Plan Context

Read `{plan-artifact}`, the latest analysis artifact, `task.md`, and Issue context when available. After reading, record the actually reviewed highest-round plan artifact by filename in the report's `Review Input` field; leave it blank when it cannot be reliably determined—do not fabricate.

### 4. Perform Review

Check simplicity, executability, risk control, test strategy, file coverage, and phase boundaries.

> Read `.agents/rules/review-method.md` before this step and follow its five-pass protocol for coverage, risk-lens decisions, traceability, and counterevidence.
> Read `reference/review-criteria.md` before this step.

### 5. Write Review Report

Create `.agents/workspace/active/{task-id}/{review-artifact}`.

> Read `reference/report-template.md` before writing the report.

### 6. Update Task Status

After the report, submit each new finding with `agent-infra-internal task-ledger {task-id} finding-upsert --stage plan --review-artifact {review-artifact} --ordinal {n} --severity {blocker|major|minor} --evidence {review-artifact}#{anchor}`; submit prior-response dispositions with `finding-review --id {ledger-id} --status {confirmed|closed|open|needs-human-decision} --evidence {evidence}`. Do not scan ids or edit ledger rows. After all ledger writes, call `agent-infra-internal task-ledger {task-id} stage-status --stage plan` exactly once. Derive the verdict and next-step branch from `stageStatus.canAdvance`, and blocker/major/minor event counts from `unresolvedFindingCounts`: only `canAdvance=true` permits `approved`; otherwise use `changes-requested` or `rejected`. Then run `agent-infra-internal task-event {task-id} review-plan.completed --agent {agent} --artifact {review-artifact} --verdict {approved|changes-requested|rejected} --blockers {n} --major {n} --minor {n} --manual-validation {n}`.

`manual-validation` is the data source for the `Manual-validation` count folded into review rows in `ai task log`; do not add a parallel manual-verification field.

If task.md has a valid `issue_number`, run `agent-infra-internal platform-comment sync {task-id} --kind task --agent {agent}`, then `agent-infra-internal platform-comment sync {task-id} --kind artifact --artifact {review-artifact} --agent {agent}`.

### 7. Run Completion Gate

```bash
agent-infra-internal task-verify {task-id} review-plan.completed --artifact {review-artifact} --format text
```

### 8. Tell the User

Use the conclusion branch in `reference/output-templates.md` and show all TUI command formats.

> Before rendering the final output, read `.agents/rules/next-step-output.md` and apply both of its rules: (1) render `{task-ref}` in the "Next steps" commands as the current task's short id `NN` (see that file for lookup and fallback), while other `{task-id}` placeholders (report titles, paths) keep the full TASK-id form; (2) append the `Completed at` line as the very last line of the user-facing output (this applies to every user-facing output — success, error, and early-return paths alike, not only the success path).
