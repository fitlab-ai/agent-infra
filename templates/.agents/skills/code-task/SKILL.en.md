---
name: code-task
description: >
  Implement code from the technical plan and output a report.
  Use when an approved technical plan needs implementing, or code review found issues to fix.
  Only invoke this skill automatically when the conversation includes a resolvable task reference.
---

# Code Task
> `--agent` values are defined in `.agents/rules/task-management.md` under “Collaborator Token Specification”.

If the entry operands contain `--orchestrated`, bind `{execution-flag}` to `--orchestrated` and forward it unchanged to the completed event; otherwise bind it to an empty value. Never infer it from `orchestration.json`, environment variables, or prior artifacts. Lifecycle events also require explicit trigger data: use `{trigger-initiator}=orchestrator` for orchestration and `model` otherwise; `{request-id}` is a stable single-line identifier for this task and artifact round, and `{reason-code}` is `user-request` for initial work and `review-finding` for fixes or decisions. Reuse the same values for started and completed.

Implement the approved plan and produce `code.md` or `code-r{N}.md`. This skill supports initial implementation, fix mode based on `review-code` feedback, and human-decision-driven implementation.

## Boundary / Critical Rules

## Persisted Report Evidence

Before generating the implementation report, read `.agents/rules/evidence-reporting.md`. Successful tests record the command, target scope, status or structured result, actual result, and uncovered parts; failures, blocking conditions, or disputes retain a reproducible entry point, exact location, and decisive excerpt instead of complete successful stdout.

- Follow the latest plan artifact: `plan.md` or `plan-r{N}.md`
- Before generating task or lifecycle Markdown that will be synchronized to an Issue, read `.agents/rules/sync-content-generation.md` and apply its producer-side constraints; the sync path does not parse or rewrite the body
- Read `.agents/rules/compatibility-policy.md` before implementation. Implement only the compatibility budget explicitly approved by the plan; never retain old branches, result contracts, or migration shims merely to be “safe”
- Fix mode verifies each finding of the latest `review-code` one by one: fix it if it holds, or rebut it and record it under unresolved if it is unfounded/hallucinated; do not expand to issues the review did not list; manual-validation items are out of scope
- Before `code.completed`, the implementation report must pass `task-artifact ... finalize-local --family code`; follow `.agents/rules/local-artifact-repair.md` for any provably safe minimal structural repair in that same report, and pass only that successful call's digests to the completion event
- If implementation encounters a key design decision not covered by the plan, run `agent-infra-internal task-ledger {task-id} decision-next-id`, write the returned `HD-N` detail block per `.agents/rules/human-decision-context.md` and determine whether implementation is required, then run `decision-upsert --id {HD-N} --stage code --artifact {code-artifact} --needs-implementation {true|false}`. Do not scan ids, assemble ledger rows, ask mid-flow, or silently expand scope
- Do not invoke the `commit` skill or push to a remote; after tests pass, call the shared commit core with `delivery: { mode: 'local' }` to create the local checkpoint. The durable intent must close only after the checkpoint and task state sync succeed; only then emit `code.completed`
- Create a new code artifact for each round and never overwrite an older one
- After executing this skill, you **must** immediately update task.md

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

After prerequisites and mode are confirmed and before this round's first artifact action, run `agent-infra-internal task-event {task-id} code.started --agent {standard-agent-token} --initiator {trigger-initiator} --request-id {request-id} --reason-code {reason-code}`. Append `--fix-for {review-artifact}` in fix mode or `--implementation-input {input-id}` in decision mode. The core derives and validates the round and input identity; record the returned `artifactContext`.

## Steps

### 1. Verify Prerequisites

Require `task.md` and at least one plan artifact: `plan.md` or `plan-r{N}.md`.

### 2. Ensure the Task Branch

Read `reference/branch-management.md`, ensure the current branch matches the task branch, and write the final branch back to task.md when needed.

### 3. Narrow the Milestone

**Mandatory; do not skip.** If task.md has a valid `issue_number`, run `agent-infra-internal platform-issue sync {task-id} --agent {standard-agent-token} --milestone specific`.

> If the milestone remains `X.Y.x`, step 12 `task-verify code.completed` blocks through the typed milestone check.

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

After tests pass, call the shared commit core with `agent-infra-internal git-workflow commit --input {checkpoint-input}`. Pass `delivery: { "mode": "local" }`, explicit paths, expected HEAD/tree, task ref, agent, and the code round. This creates only a local checkpoint and does not contact a remote. The core writes a durable intent before committing and removes it after task-writer synchronization; do not emit `code.completed` if either checkpoint or task synchronization fails.

After the checkpoint succeeds, when task.md has an `issue_number`, run `agent-infra-internal platform-issue sync {task-id} --agent {standard-agent-token} --in-labels from-diff --base {delivery-base-ref}`. The task-bound `delivery_base_ref` is the only source for Issue `in:` evidence; record a warning and stop this round without emitting `code.completed` if this sync fails.

### 9. Write the Code Report

Create `.agents/workspace/active/{task-id}/{code-artifact}`.

> Read `reference/report-template.md` before writing the report.

### 10. Pre-completion Report Gate

After writing the report and before publishing `code.completed`, read and follow `.agents/rules/local-artifact-repair.md` and run:

```bash
finalizer=$(agent-infra-internal task-artifact {task-id} finalize-local --family code --artifact {code-artifact})
status=$?
echo "$finalizer"
```

- `status=0` with `finalizer.status="passed"`: bind `{artifact-sha256}` and `{semantic-digest}` from this result.
- `status=1` with `repairable=true` and a diagnostic explicitly describing a one-line replacement: confirm task, round, artifact, and provenance are unchanged; edit only that `code*.md` once, confirm the bytes changed, then rerun the same command completely.
- For any other failure, lack of progress, repeated diagnostic, or eight actual report edits, stop without publishing `code.completed`.

Do not rescan or manually write digest data; the completion event must include `--artifact-sha256 {artifact-sha256} --semantic-digest {semantic-digest}` from the successful finalizer result.

### 11. Update Task Status

After requirement checkboxes are updated, run the initial event `agent-infra-internal task-event {task-id} code.completed --agent {standard-agent-token} --initiator {trigger-initiator} --request-id {request-id} --reason-code {reason-code} --artifact {code-artifact} --artifact-sha256 {artifact-sha256} --semantic-digest {semantic-digest} --files-modified {n} --tests-passed {n} {execution-flag}`; in fix mode add `--fix-for {review-artifact} --blockers {n} --major {n} --minor {n} --manual-validation {n} {execution-flag}` instead; in decision mode add `--implementation-input {input-id}` to the initial counts. The core atomically records the artifact link, stage, metadata, done log, and decision-input consumption.

If task.md has a valid `issue_number`, read `.agents/rules/issue-sync.md`, then (status/comment failures follow the warning rules; an Issue `in:` evidence failure must not emit `code.completed`):
- Run `agent-infra-internal platform-issue sync {task-id} --agent {standard-agent-token} --status in-progress`
- Run `agent-infra-internal platform-comment sync {task-id} --kind task --agent {standard-agent-token}`
- Run `agent-infra-internal platform-comment sync {task-id} --kind artifact --artifact {code-artifact} --agent {standard-agent-token}`

### 12. Run Completion Gate

```bash
agent-infra-internal task-verify {task-id} code.completed --artifact {code-artifact} --format text
```

### 13. Tell the User

Use `reference/output-template.md` (or `reference/fix-mode.md` in fix mode) and render the selected next-step commands through the shared helper. Do not push, create a PR, or invoke the `commit` skill here.

> Before rendering the final output, read `.agents/rules/next-step-output.md` and apply both of its rules: (1) render `{task-ref}` in the "Next steps" commands as the current task's short id `NN` (see that file for lookup and fallback), while other `{task-id}` placeholders (report titles, paths) keep the full TASK-id form; (2) append the `Completed at` line as the very last line of the user-facing output (this applies to every user-facing output — success, error, and early-return paths alike, not only the success path).
