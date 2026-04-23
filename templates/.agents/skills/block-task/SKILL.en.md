---
name: block-task
description: "Mark a task as blocked and record the reason"
---

# Block Task

## Boundary / Critical Rules

- This command updates task metadata AND physically moves the task directory
- Only block when you genuinely cannot proceed -- if it is a difficulty you can work through, try harder first

## Use Cases

- **Technical problems**: Unresolvable bugs, missing dependencies, infrastructure issues
- **Requirement issues**: Unclear requirements, conflicting specifications, pending decisions
- **Resource issues**: Missing access, waiting for external team, blocked by another task
- **Decision needed**: Architecture decision pending, stakeholder approval required

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

### 3. Update Task Metadata

Get the current time:

```bash
date "+%Y-%m-%d %H:%M:%S%:z"
```

Update `.agents/workspace/active/{task-id}/task.md`:
- `status`: blocked
- `blocked_at`: {current timestamp}
- `updated_at`: {current timestamp}
- **Append** to `## Activity Log` (do NOT overwrite previous entries):
  ```
  - {YYYY-MM-DD HH:mm:ss±HH:MM} — **Blocked** by {agent} — {one-line reason}
  ```

Add a blocking information section to task.md.

### 4. Move Task to Blocked Directory

```bash
mv .agents/workspace/active/{task-id} .agents/workspace/blocked/{task-id}
```

### 5. Verify Move

```bash
ls .agents/workspace/blocked/{task-id}/task.md
```

### 6. Sync to Issue (Optional)

Check whether `task.md` includes a valid `issue_number`. If not, skip this step.

> Status-label sync rules live in `.agents/rules/issue-sync.md`. Read that file before syncing, and complete upstream repository detection plus permission detection.

If a valid `issue_number` exists, set `status: blocked` by following issue-sync.md.

### 7. Verification Gate

Run the verification gate to confirm the task artifact and sync state are valid:

```bash
node .agents/scripts/validate-artifact.js gate block-task .agents/workspace/blocked/{task-id} --format text
```

Handle the result as follows:
- exit code 0 (all checks passed) -> continue to the "Inform User" step
- exit code 1 (validation failed) -> fix the reported issues and run the gate again
- exit code 2 (network blocked) -> stop and tell the user that human intervention is required

Keep the gate output in your reply as fresh evidence. Do not claim completion without output from this run.

### 8. Inform User

> Execute this step only after the verification gate passes.

> **IMPORTANT**: All TUI command formats listed below must be output in full. Do not show only the format for the current AI agent. If `.agents/.airc.json` configures custom TUIs (via `customTools`), read each tool's `name` and `invoke`, then add the matching command line in the same format (`${skillName}` becomes the skill name and `${projectName}` becomes the project name).

Output format:
```
Task {task-id} marked as blocked.

Blocking reason: {summary}
Required to unblock: {what's needed}
Archived to: .agents/workspace/blocked/{task-id}/

To unblock when the issue is resolved:
  mv .agents/workspace/blocked/{task-id} .agents/workspace/active/{task-id}
  # Then update task.md: status -> active, remove blocked_at

Next step - check task status after unblocking:
  - Claude Code / OpenCode: /check-task {task-id}
  - Gemini CLI: /{{project}}:check-task {task-id}
  - Codex CLI: $check-task {task-id}
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
# 1. Move back to active
mv .agents/workspace/blocked/{task-id} .agents/workspace/active/{task-id}

# 2. Update task.md: set status to active, update timestamps
# 3. Resume from where you left off (check current_step)
```

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
