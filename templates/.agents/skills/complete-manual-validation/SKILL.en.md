---
name: complete-manual-validation
description: >
  Mark PR manual validation as completed and update the manual-validation section
  in the existing PR summary comment in place.
  Only invoke this skill automatically when the conversation includes a resolvable task reference.
---

# Complete Manual Validation
> `--agent` values are defined in `.agents/rules/task-management.md` under “Collaborator Token Specification”.

Lifecycle events require explicit trigger data: use `{trigger-initiator}=orchestrator` for orchestration and `model` otherwise; `{request-id}` is a stable single-line identifier for this task and artifact round, and `{reason-code}` is `user-request` or `validation-rerun`. Reuse the same values for started and completed.


## Boundary / Critical Rules

- This skill closes the manual-validation status in an existing PR summary comment; it does not create a parallel ordinary validation comment.
- It must write `manual-validation.md` or `manual-validation-r{N}.md` so later PR summary refreshes can reuse the validation result.
- If the `sync-pr` summary comment is missing, fail instead of creating a partial fallback summary.
- Before generating manual-validation artifact Markdown that will be synced to an Issue, read `.agents/rules/sync-content-generation.md` and follow its generator-side constraints; Issue sync remains transparent and does not parse or rewrite the body.
- After this skill runs, update `task.md` immediately.

Version stamp rule: when creating or updating `task.md` frontmatter, read `.agents/rules/version-stamp.md` first and write or refresh `agent_infra_version`.

## Step 0: State Check (pre-execution hard gate)

After loading workflow / skill / rules instructions, and before any task-state judgment or user-visible conclusion, run the state check first. Reading instruction files does not count as an external-state action or conclusion.

Run these commands and paste the raw output into this round's `## State Check` section:

```bash
agent-infra-internal task-snapshot {task-id} --format text
```

## Task Context Resolution

> The entry point may omit the task ref; explicit task scope accepts only `--task <ref>` or `-t <ref>`, and positional task refs are not interpreted. Preserve every other business operand, then call `agent-infra-internal task-context resolve {task-scope}` where `{task-scope}` is empty or one task flag. Read only `taskId` from the structured result and bind `{task-id}` to the full `TASK-YYYYMMDD-HHMMSS` for downstream commands. Pass through resolution failures without scanning tasks locally.

> Resolve the task reference, then confirm that the task is in a state or directory supported by this skill and that `task.md` exists; if it cannot be located, handle it as a missing task and stop.

## Step Start: Write the started Marker

After resolving the artifact context and before this round's first artifact action, run `agent-infra-internal task-event {task-id} manual-validation.started --agent {standard-agent-token} --initiator {trigger-initiator} --request-id {request-id} --reason-code {reason-code}` and record the returned `artifactContext`.

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

Run `agent-infra-internal task-artifact {task-id} inspect --family manual-validation`. Continue only for `ready`; take the round and `{manual-validation-artifact}` from `next.round` / `next.name`. Do not scan rounds or construct names in the skill. Then run the started event and verify the returned identity.

### 4. Update the PR Summary

Before this step, read:
- `.agents/rules/issue-sync.md`
- `.agents/rules/pr-sync.md`
- `reference/summary-update.md`

Follow `reference/summary-update.md` to validate the PR binding, obtain canonical inputs from `platform-pr summary-context`, and update the manual-validation section through `platform-pr summary-sync` to `### ✅ Manual Validation Passed`.

### 5. Create the Manual Validation Artifact

Before this step, read `reference/report-template.md`. Create `{manual-validation-artifact}` and record:
- State check
- Validation verdict
- Validation scope
- Validation details
- PR summary sync result

### 6. Update task.md

Run `agent-infra-internal task-event {task-id} manual-validation.completed --agent {standard-agent-token} --initiator {trigger-initiator} --request-id {request-id} --reason-code {reason-code} --artifact {manual-validation-artifact} --summary-result "{summary-result}"`. The core keeps `current_step` unchanged while atomically recording the implementation-notes link, metadata, and done log.

If the task has a valid `issue_number`, run `agent-infra-internal platform-comment sync {task-id} --kind task --agent {standard-agent-token}`, then `agent-infra-internal platform-comment sync {task-id} --kind artifact --artifact {manual-validation-artifact} --agent {standard-agent-token}`.

### 7. Verification Gate

Run:

```bash
agent-infra-internal task-verify {task-id} manual-validation.completed --artifact {manual-validation-artifact} --format text
```

Handle the result:
- Exit code 0 -> tell the user
- Exit code 1 -> fix the reported problem and rerun
- Exit code 2 -> stop and report that manual intervention is required

### 8. Tell the User

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
