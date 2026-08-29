---
name: cancel-task
description: >
  Cancel an unneeded task and move it.
  Use when a task is no longer needed and should be dropped from active work.
  Only invoke this skill automatically when the conversation includes a resolvable task reference.
---

# Cancel Task
> `--agent` values are defined in `.agents/rules/task-management.md` under “Collaborator Token Specification”.


## Boundary / Critical Rules

- This command terminates a task that no longer needs to continue and moves it into `completed/`
- Cancel only when the task no longer needs implementation, review, or follow-up work
- When a valid `issue_number` exists, Issue sync is required

Version stamp rule: when creating or updating `task.md` frontmatter, read `.agents/rules/version-stamp.md` first and write or refresh `agent_infra_version`.

## Task Context Resolution

> The entry point may omit the task ref and also accepts a legacy positional ref or `--task <ref>` / `-t <ref>`. Separate task scope from the full arguments while preserving every business operand, then call `agent-infra-internal task-context resolve {task-scope}` where `{task-scope}` is empty, one positional ref, or one task flag. Read only `taskId` from the structured result and bind `{task-id}` to that full `TASK-YYYYMMDD-HHMMSS` for downstream commands. Pass through resolution failures without scanning tasks locally.

> Resolve the task reference, then confirm that the task is in a state or directory supported by this skill and that `task.md` exists; if it cannot be located, handle it as a missing task and stop.

## Step Start: Local Lifecycle Boundary

After prerequisites pass, Step 3 declares one lifecycle intent that atomically commits base metadata, the started/done pair, the directory move, and short-id handling. Do not write partial lifecycle state first.

## Steps

### 1. Verify Task Exists

Check these directories in order:
- `.agents/workspace/active/{task-id}/`
- `.agents/workspace/blocked/{task-id}/`
- `.agents/workspace/completed/{task-id}/`

Handling rules:
- If found in `active/` or `blocked/`: continue
- If found only in `completed/`: inform the user the task is already moved and stop
- If not found anywhere: prompt `Task {task-id} not found`

### 2. Choose the Cancellation Label

Infer the Issue closing label from the cancellation reason:
- `status: superseded`: reason implies duplicate, replaced, merged into, or already covered by another Issue or PR
- `status: invalid`: reason implies invalid report, no real problem, cannot reproduce, or no issue after investigation
- `status: declined`: reason implies not planned, deprioritized, or explicitly rejected
- If nothing matches: fall back to `status: declined`

When syncing to the Issue, replace any existing `status:` labels with the inferred label.

### 3. Apply the Local Lifecycle Intent

```bash
agent-infra-internal task-lifecycle {task-id} cancel --agent {standard-agent-token} --reason "{one-line cancellation reason}"
```

Only `status=applied|no-op` means local cancellation completed. On `status=failed`, show the structured error and recovery steps and retry the same intent; do not manually edit task.md, move the directory, or release the short id.

### 4. Verify the Local Final State

Confirm `targetState=completed`, terminal fields, and the short-id effect from the structured result.

### 5. Verify the Move

```bash
ls .agents/workspace/completed/{task-id}/task.md
```

Confirm the task directory was moved successfully.

### 6. Sync to Issue

Check whether `task.md` contains a valid `issue_number`. If not, skip this step.

If a valid `issue_number` exists:
- Run `agent-infra-internal platform-issue sync {task-id} --agent {standard-agent-token} --status {reason} --in-labels none --assignees none --milestone none --state closed --close-reason not_planned`
- Write the cancellation body to a temporary file and run `agent-infra-internal platform-comment sync {task-id} --kind cancel --body-file {path} --agent {standard-agent-token}`
- Run `agent-infra-internal platform-comment sync {task-id} --kind task --agent {standard-agent-token}`

The cancellation comment must include at least:
- the cancellation reason
- the selected `status:` label

### 7. Verification Gate

Run the verification gate to confirm the moved task and sync state are valid:

```bash
agent-infra-internal task-verify {task-id} cancel-task.completed --format text
```

Handle the result as follows:
- exit code 0 (all checks passed) -> continue to the "Inform User" step
- exit code 1 (validation failed) -> fix the reported issues and run the gate again
- exit code 2 (network blocked) -> stop and tell the user that human intervention is required

Keep the gate output in your reply as fresh evidence. Do not claim completion without output from this run.

### 8. Inform User

> Execute this step only after the verification gate passes.

> Before rendering next steps, read `.agents/rules/next-step-output.md`, invoke the shared helper only for the selected scenario, and insert its stdout at `{next-step-commands}`.

> **Optional sandbox-cleanup hint (gated)**: Render the "Optional: clean up this task's sandbox" block — placed after "Target path" and before "Next step" in the output below — only when BOTH (1) `.agents/.airc.json` has a `sandbox` field and (2) task.md's `branch` field exists and is not `main` / `master`; otherwise omit the whole block. Use the full `{task-id}` for cleanup; do not substitute the branch name. This block is independent of "Next steps" semantics.

Output format:
Populate `{next-step-commands}` for this scenario by running `agent-infra-internal agent-client next-steps --skill check-task --task-ref {task-ref}`.

```
Task {task-id} cancelled; task directory moved to completed/.

Cancellation reason: {reason}
Status label: {status-label or skipped}
Target path: .agents/workspace/completed/{task-id}/

Optional: clean up this task's sandbox
(The task is completed and archived; the sandbox container and per-branch config directory are not reclaimed automatically. Run this if you no longer need them:)

ai sandbox rm {task-id}

Next step - inspect the moved task:
{next-step-commands}
```



## Completion Checklist

- [ ] Recorded the cancellation reason and updated task.md
- [ ] Moved the task directory into `.agents/workspace/completed/`
- [ ] Completed Issue sync when an Issue exists
- [ ] Ran and passed the verification gate
- [ ] Showed the full next-step command set to the user

## Notes

1. Cancelled tasks reuse the `completed` status instead of introducing `cancelled`
2. Use `cancelled_at` and `cancel_reason` to distinguish cancellation from normal completion
3. If closing the Issue fails, do not claim the cancellation is complete

## Error Handling

- Task not found: `Task {task-id} not found`
- Task already moved: inform the user it is already in `completed/`
- Issue sync failed: keep the local move result and tell the user manual platform follow-up is required
