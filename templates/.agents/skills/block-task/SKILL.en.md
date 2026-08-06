---
name: block-task
description: >
  Mark a task as blocked and record the reason.
  Use when a task cannot proceed because of an external blocker and you need to park it with a reason.
  Only invoke this skill automatically when the conversation includes a resolvable task reference.
---

# Block Task
> `--agent` values follow the "Collaborator Token Specification" in `.agents/rules/task-management.md`: standard AI short tokens (`claude`/`codex`/`antigravity`/`opencode`/`cursor`), long-name normalization (`claude-code`->`claude`, `antigravity-cli`->`antigravity`), or the `human` manual exception.


## Boundary / Critical Rules

- This command updates task metadata AND physically moves the task directory
- Only block when you genuinely cannot proceed -- if it is a difficulty you can work through, try harder first

## Use Cases

- **Technical problems**: Unresolvable bugs, missing dependencies, infrastructure issues
- **Requirement issues**: Unclear requirements, conflicting specifications, pending decisions
- **Resource issues**: Missing access, waiting for external team, blocked by another task
- **Decision needed**: Architecture decision pending, stakeholder approval required

Version stamp rule: when creating or updating `task.md` frontmatter, read `.agents/rules/version-stamp.md` first and write or refresh `agent_infra_version`.

## Task Context Resolution

> The entry point may omit the task ref and also accepts a legacy positional ref or `--task <ref>` / `-t <ref>`. Separate task scope from the full arguments while preserving every business operand, then call `agent-infra-internal task-context resolve {task-scope}` where `{task-scope}` is empty, one positional ref, or one task flag. Read only `taskId` from the structured result and bind `{task-id}` to that full `TASK-YYYYMMDD-HHMMSS` for downstream commands. Pass through resolution failures without scanning tasks locally.

> Resolve the task reference, then confirm that the task is in a state or directory supported by this skill and that `task.md` exists; if it cannot be located, handle it as a missing task and stop.

## Step Start: Local Lifecycle Boundary

After prerequisites pass, Step 3 declares one lifecycle intent that atomically writes the started/done pair, base metadata, directory move, and short-id release. Do not write those pieces manually first.

## Steps

### 1. Verify Task Exists

Check that the task exists in `.agents/workspace/active/{task-id}/`.

Note: `{task-id}` format is `TASK-{yyyyMMdd-HHmmss}`, e.g. `TASK-20260306-143022`

If not found, check other directories and inform user.

### 2. Analyze Blocking Reason

Before blocking, thoroughly analyze:
- [ ] What exactly is the problem?
- [ ] What is the root cause?
- [ ] What solutions have been attempted?
- [ ] What help or information is needed to unblock?

### 3. Apply the Local Lifecycle Intent

```bash
agent-infra-internal task-lifecycle {task-id} block --agent {standard-agent-token} \
  --reason "{one-line reason}" --unblock-condition "{unblock condition}"
```

Only `status=applied|no-op` means the local block completed. On `status=failed`, show the structured error and recovery steps and retry the same intent; do not manually edit task.md, move the directory, or release the short id.

### 4. Verify the Local Final State

Confirm `targetState=blocked`, the target path, and the committed short-id effect.

### 5. Preserve Recovery Identity

```bash
ls .agents/workspace/blocked/{task-id}/task.md
```

### 6. Sync to Issue (Optional)

Check whether `task.md` includes a valid `issue_number`. If not, skip this step.

If a valid `issue_number` exists, run `agent-infra-internal platform-issue sync {task-id} --agent {standard-agent-token} --status blocked`.
Then run `agent-infra-internal platform-comment sync {task-id} --kind task --agent {standard-agent-token}`.

### 7. Verification Gate

Run the verification gate to confirm the task artifact and sync state are valid:

```bash
agent-infra-internal task-verify {task-id} block-task.completed --format text
```

Handle the result as follows:
- exit code 0 (all checks passed) -> continue to the "Inform User" step
- exit code 1 (validation failed) -> fix the reported issues and run the gate again
- exit code 2 (network blocked) -> stop and tell the user that human intervention is required

Keep the gate output in your reply as fresh evidence. Do not claim completion without output from this run.

### 8. Inform User

> Execute this step only after the verification gate passes.

> Before rendering next steps, read `.agents/rules/next-step-output.md`, invoke the shared helper only for the selected scenario, and insert its stdout at `{next-step-commands}`.

> **Optional sandbox-cleanup hint (gated)**: Render the "Optional: clean up this task's sandbox" block — placed after "Archived to" and before "To unblock" in the output below — only when BOTH (1) `.agents/.airc.json` has a `sandbox` field and (2) task.md's `branch` field exists and is not `main` / `master`; otherwise omit the whole block. `{branch}` is the `branch` value from the task.md you already loaded (the task has moved to blocked/, so read it from `.agents/workspace/blocked/{task-id}/task.md`). This block is independent of "Next step" semantics.

Output format:
Populate `{next-step-commands}` for this scenario by running `agent-infra-internal agent-client next-steps --skill check-task --task-ref {task-ref}`.

```
Task {task-id} marked as blocked.

Blocking reason: {summary}
Required to unblock: {what's needed}
Archived to: .agents/workspace/blocked/{task-id}/

Optional: clean up this task's sandbox
(The task is blocked and moved to blocked/; the sandbox container and per-branch config directory are not reclaimed automatically. Run this if you no longer need them:)

ai sandbox rm {branch}

To unblock when the issue is resolved:
  agent-infra-internal task-lifecycle {task-id} activate --agent {standard-agent-token} --note "{activation note}"

Next step - check task status after unblocking:
{next-step-commands}
```



## Completion Checklist

- [ ] Analyzed and documented the blocking reason
- [ ] Updated task.md with blocked status and blocking information
- [ ] Moved task directory to `.agents/workspace/blocked/`
- [ ] Verified move succeeded
- [ ] Informed user how to unblock

## Unblocking

When the blocking issue is resolved:

```bash
agent-infra-internal task-lifecycle {task-id} activate --agent {standard-agent-token} --note "{activation note}"
```

Resume from the preserved `current_step`. On failure, retry the same intent from the structured recovery fields instead of hand-editing lifecycle state.

## Notes

1. **When to block**: Only block when you genuinely cannot proceed. If it is a difficulty you can work through, try harder first.
2. **Documentation**: The more detail in the blocking info, the easier it is for someone else to help unblock.
3. **Multiple blockers**: If there are multiple blocking issues, list all of them.
4. **Timeout**: If a task has been blocked for a long time, consider whether it should be redesigned or cancelled.

## Error Handling

- Task not found: Prompt "Task {task-id} not found"
- Task already blocked: Prompt "Task {task-id} is already in blocked directory"
- Task already completed: Prompt "Task {task-id} is already completed"
- Move failed: Prompt error and suggest manual move
