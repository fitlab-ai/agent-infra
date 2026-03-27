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
date "+%Y-%m-%d %H:%M:%S"
```

Update `.agents/workspace/active/{task-id}/task.md`:
- `status`: blocked
- `blocked_at`: {current timestamp}
- `updated_at`: {current timestamp}
- **Append** to `## Activity Log` (do NOT overwrite previous entries):
  ```
  - {yyyy-MM-dd HH:mm:ss} — **Blocked** by {agent} — {one-line reason}
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

Check whether `task.md` includes an `issue_number` field whose value is neither empty nor `N/A`. If not, **skip this step and output nothing**.

If a valid `issue_number` exists, suggest syncing:

> **IMPORTANT**: All TUI command formats listed below must be output in full. Do not show only the format for the current AI agent.

```
(Optional) Sync the blocking status to the Issue:
  - Claude Code / OpenCode: /sync-issue {issue_number}
  - Gemini CLI: /{{project}}:sync-issue {issue_number}
  - Codex CLI: $sync-issue {issue_number}
```

### 7. Inform User

> **IMPORTANT**: All TUI command formats listed below must be output in full. Do not show only the format for the current AI agent.

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

## Output Template

Blocking information section to add to task.md:

```markdown
## Blocking Information

### Summary
{One-line description of why the task is blocked}

### Problem Description
{Detailed description of the blocking issue}

### Root Cause
{Analysis of why this is blocking}

### Attempted Solutions
- {What was tried and why it didn't work}

### Required to Unblock
- {What's needed: information, decision, resource, etc.}

### Unblocking Conditions
{Specific conditions that would allow work to resume}

### Alternative Plans
{Any workarounds or alternative approaches considered}
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
