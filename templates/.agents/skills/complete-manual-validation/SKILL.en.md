---
name: complete-manual-validation
description: >
  Mark PR manual validation as completed and update the manual-validation section
  in the existing PR summary comment in place.
  Only invoke this skill automatically when the conversation includes a resolvable task reference.
---

# Complete Manual Validation
> `--agent` values are defined in `.agents/rules/task-management.md` under “Collaborator Token Specification”.

The transaction coordinator appends lifecycle events and the final PR summary state. The maintainer's validation summary and PR manual-validation comment are the human-validation authority; the transaction receipt provides state-transition and recovery consistency.


## Boundary / Critical Rules

### Persisted Report Evidence

Before generating the validation completion report, read `.agents/rules/evidence-reporting.md`. Record commands, scope, structured results, actual conclusions, and uncovered parts for state checks and synchronization; keep the stricter basename-only and sanitized-result boundaries for manual validation.

- This skill closes the manual-validation status in an existing PR summary comment; it does not create a parallel ordinary validation comment.
- It must write `manual-validation.md` or `manual-validation-r{N}.md` so later PR summary refreshes can reuse the validation result.
- If the `sync-pr` summary comment is missing, fail instead of creating a partial fallback summary; before the receipt, completion log, and final summary are all committed, the remote summary may only be pending/non-pass.
- Before generating manual-validation artifact Markdown that will be synced to an Issue, read `.agents/rules/sync-content-generation.md` and follow its generator-side constraints; Issue sync remains transparent and does not parse or rewrite the body.
- After this skill runs, update `task.md` immediately.

Version stamp rule: when creating or updating `task.md` frontmatter, read `.agents/rules/version-stamp.md` first and write or refresh `agent_infra_version`.

## Step 0: State Check (pre-execution hard gate)

After loading workflow / skill / rules instructions, and before any task-state judgment or user-visible conclusion, run the state check first. Reading instruction files does not count as an external-state action or conclusion.

Run these commands and record the task/artifact scope, key result, and uncovered parts in this round's `## State Check` section; do not paste complete directory listings or task tails on normal success. Retain decisive raw lines only for failures, blocking conditions, identity mismatches, or disputes:

```bash
agent-infra-internal task-snapshot {task-id} --format text
```

## Task Context Resolution

> The entry point may omit the task ref; explicit task scope accepts only `--task <ref>` or `-t <ref>`, and positional task refs are not interpreted. Preserve every other business operand, then call `agent-infra-internal task-context resolve {task-scope}` where `{task-scope}` is empty or one task flag. Read only `taskId` from the structured result and bind `{task-id}` to the full `TASK-YYYYMMDD-HHMMSS` for downstream commands. Pass through resolution failures without scanning tasks locally.

> Resolve the task reference, then confirm that the task is in a state or directory supported by this skill and that `task.md` exists; if it cannot be located, handle it as a missing task and stop.

## Steps

### 1. Parse Arguments

Input:

```text
complete-manual-validation [--task <ref> | -t <ref>] [{pr-ref}] {verification-summary}
```

- The task scope may be omitted; explicit scope accepts only `--task <ref>` or `-t <ref>`.
- `{pr-ref}` is optional and accepts `#NN`, `NN`, or a full PR URL.
- `{verification-summary}` is required. If it is missing, stop and ask for a validation summary; do not write an artifact or update the PR.

### 2. Verify Prerequisites

Check:
- `.agents/workspace/active/{task-id}/task.md`
- a valid PR: prefer explicit `{pr-ref}`, otherwise read verified `pr_delivery_fact.identity.number` from task.md frontmatter

Stop if the task is missing, the validation summary is missing, or no valid PR can be resolved.

### 3. Resolve the Artifact Context

Run `agent-infra-internal task-artifact {task-id} inspect --family manual-validation`. Continue only for `ready`; take the round and `{manual-validation-artifact}` from `next.round` / `next.name`. Do not scan rounds or construct names in the skill. The transaction coordinator owns the started event.

### 4. Register Manual Validation Start

Before creating any manual-validation artifact, obtain the canonical summary body from `platform-pr summary-context`, then call the transaction coordinator in prepare mode:

```bash
agent-infra-internal manual-validation transaction {task-id} --prepare \
  --artifact {manual-validation-artifact} \
  --summary-file {summary-body-file} --agent {standard-agent-token}
```

Prepare must idempotently record `manual-validation.started` before writing the prepared transaction; on failure, stop without creating the artifact.

### 5. Create the Manual Validation Artifact

Before this step, read `reference/report-template.md`. After `started` is recorded, create `{manual-validation-artifact}` and record the state check, validation verdict, validation scope, validation details, and expected PR summary synchronization result; the transaction coordinator validates and commits this artifact in the next step.

### 6. Update the PR Summary

Before this step, read:
- `.agents/rules/issue-sync.md`
- `.agents/rules/pr-sync.md`
- `reference/summary-update.md`

Follow `reference/summary-update.md` to validate the PR binding, obtain canonical inputs from `platform-pr summary-context`, and call the transaction coordinator once:

```bash
agent-infra-internal manual-validation transaction {task-id} \
  --artifact {manual-validation-artifact} \
  --summary-file {summary-body-file} --change-report-file .agents/workspace/active/{task-id}/pr-change-report.json \
  --agent {standard-agent-token} --result no_op
```

The coordinator owns pending summary, receipt, completion log, final promotion, and post-write verification; it internally uses the controlled `agent-infra-internal task-event {task-id}` route. Do not call final `summary-sync` or `manual-validation.completed` separately. Raw evidence files from other hosts are not required.

### 7. Update task.md

After the transaction coordinator succeeds, the core has atomically recorded `manual-validation.completed` with the same transaction/receipt/head identity. Do not append the Activity Log manually.

If the task has a valid `issue_number`, run `agent-infra-internal platform-comment sync {task-id} --kind task --agent {standard-agent-token}`, then `agent-infra-internal platform-comment sync {task-id} --kind artifact --artifact {manual-validation-artifact} --agent {standard-agent-token}`.

### 8. Verification Gate

Run:

```bash
agent-infra-internal task-verify {task-id} manual-validation.completed --artifact {manual-validation-artifact} --format text
```

Handle the result:
- Exit code 0 -> tell the user
- Exit code 1 -> fix the reported problem and rerun
- Exit code 2 -> stop and report that manual intervention is required

### 9. Tell the User

Report:
- Artifact path
- PR summary sync result
- Current verification output
- Suggested next step: enter the final closing flow and run /complete-task --task {task-ref}

Before rendering the final output, read `.agents/rules/next-step-output.md` and append `Completed at: YYYY-MM-DD HH:mm:ss` as the absolute last line.

## Completion Checklist

- [ ] Read `reference/summary-update.md`
- [ ] Created the manual validation artifact
- [ ] Updated the same PR summary comment, or stopped according to failure semantics
- [ ] Updated task.md and appended the Activity Log
- [ ] Ran the verification gate
