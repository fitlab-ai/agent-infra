---
name: review-plan
description: >
  Review the technical plan.
  Use when a technical plan needs review before implementation.
  Only invoke this skill automatically when the conversation includes a resolvable task reference.
---

# Technical Plan Review
> `--agent` values are defined in `.agents/rules/task-management.md` under “Collaborator Token Specification”.

If the entry operands contain `--orchestrated`, bind `{execution-flag}` to `--orchestrated` and forward it unchanged to both the summary finalizer and completed event; otherwise bind it to an empty value. Never infer it from `orchestration.json`, environment variables, or prior artifacts. Lifecycle events also require explicit trigger data: use `{trigger-initiator}=orchestrator` for orchestration and `model` otherwise; `{request-id}` is a stable single-line identifier for this task and artifact round, and `{reason-code}` is `user-request` or `review-finding`. Reuse the same values for started and completed.

Review the latest plan artifact and produce `review-plan.md` or `review-plan-r{N}.md`.

## Boundary / Critical Rules

- This skill only reviews plan artifacts and writes a report; it does not modify product code.
- Before generating task or lifecycle Markdown that will be synchronized to an Issue, read `.agents/rules/sync-content-generation.md` and apply its producer-side constraints; the sync path does not parse or rewrite the body
- After executing this skill, you **must** immediately update task.md.

Version stamp rule: when creating or updating `task.md` frontmatter, read `.agents/rules/version-stamp.md` first and write or refresh `agent_infra_version`.

## Step 0: State Check (pre-execution hard gate)

After loading workflow / skill / rules instructions, and before any task-state judgment or user-visible conclusion, run the state check first.

Run these commands and paste the raw output into this round's `## State Check` section:

```bash
agent-infra-internal task-snapshot {task-id} --format text
```

## Task Context Resolution

> The entry point may omit the task ref; explicit task scope accepts only `--task <ref>` or `-t <ref>`, and positional task refs are not interpreted. Preserve every other business operand, then call `agent-infra-internal task-context resolve {task-scope}` where `{task-scope}` is empty or one task flag. Read only `taskId` from the structured result and bind `{task-id}` to the full `TASK-YYYYMMDD-HHMMSS` for downstream commands. Pass through resolution failures without scanning tasks locally.

> Resolve the task reference, then confirm that the task is in a state or directory supported by this skill and that `task.md` exists; if it cannot be located, handle it as a missing task and stop.

## Step Start: Write the started Marker

After resolving the artifact context and before this round's first artifact action, run `agent-infra-internal task-event {task-id} review-plan.started --agent {standard-agent-token} --initiator {trigger-initiator} --request-id {request-id} --reason-code {reason-code}`.

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

After the report, submit each new finding with `agent-infra-internal task-ledger {task-id} finding-upsert --stage plan --review-artifact {review-artifact} --ordinal {n} --severity {blocker|major|minor} --evidence {review-artifact}#{anchor}`; submit prior-response dispositions with `finding-review --id {ledger-id} --status {confirmed|closed|open|needs-human-decision} --evidence {evidence}`. Do not scan ids or edit ledger rows. After all ledger writes, make the initial call to `agent-infra-internal task-review {task-id} finalize-summary --stage plan --artifact {review-artifact} {execution-flag}`; after a failure, follow `.agents/rules/local-artifact-repair.md` to decide whether to edit and rerun, and never treat an error type or `changed=false` as automatic authorization.

Bind and reuse this structured mapping from that one response:

```text
{unresolved-blockers} = stageStatus.unresolvedFindingCounts.blocker
{unresolved-major} = stageStatus.unresolvedFindingCounts.major
{unresolved-minor} = stageStatus.unresolvedFindingCounts.minor
```

The intent atomically finalizes the report summary and returns the same ledger snapshot. Do not call `stage-status`, replace placeholders manually, or rescan the finding list. After a failure, the model may edit the same controlled artifact and rerun the same intent only when the shared rule's mechanical gates pass; reassess convergence after every failure. The final complete result determines the verdict and counts from that same snapshot: `stageStatus.canAdvance=true` with an Approved conclusion permits cross-stage advancement; `stageStatus.canAdvance=false` still requires `agent-infra-internal task-event {task-id} review-plan.completed --agent {standard-agent-token} --initiator {trigger-initiator} --request-id {request-id} --reason-code {reason-code} --artifact {review-artifact} --verdict {approved|changes-requested|rejected} --blockers {unresolved-blockers} --major {unresolved-major} --minor {unresolved-minor} --manual-validation {n} {execution-flag}`, using `changes-requested` and routing to same-stage revision/review (use `rejected` when the report explicitly rejects). On failure, model stop, lack of progress, or the emergency cap, do not publish a completion event or cross-stage command; use the `repair-stop` scenario in `reference/output-templates.md` to show existing summary/findings, the artifact, actual repair attempts, the last diagnostic, and the stop reason.

`manual-validation` is the data source for the `Manual-validation` count folded into review rows in `ai task log`; do not add a parallel manual-verification field.

If task.md has a valid `issue_number`, run `agent-infra-internal platform-comment sync {task-id} --kind task --agent {standard-agent-token}`, then `agent-infra-internal platform-comment sync {task-id} --kind artifact --artifact {review-artifact} --agent {standard-agent-token}`.

Before writing the summary, the finalization intent checks decision-detail ids; any visible duplicate returns a structured failure and preserves the artifact bytes, while the model decides whether a minimal edit is safe under the shared rule. If the safety gates fail, diagnostics repeat, no byte-level progress occurs, or the emergency cap is reached, stop before the completion event; the stop path must still show the existing review result instead of hiding the artifact.

### 7. Run Completion Gate

```bash
agent-infra-internal task-verify {task-id} review-plan.completed --artifact {review-artifact} --format text
```

### 8. Tell the User

Use the conclusion branch in `reference/output-templates.md` and render the selected next-step commands through the shared helper.

> Before rendering the final output, read `.agents/rules/next-step-output.md` and apply both of its rules: (1) render `{task-ref}` in the "Next steps" commands as the current task's short id `NN` (see that file for lookup and fallback), while other `{task-id}` placeholders (report titles, paths) keep the full TASK-id form; (2) append the `Completed at` line as the very last line of the user-facing output (this applies to every user-facing output — success, error, and early-return paths alike, not only the success path).
