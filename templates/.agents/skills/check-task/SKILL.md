---
name: check-task
description: >
  View a task's current status, workflow progress, and context files.
  This is a read-only operation that reports the task state and suggests
  the appropriate next action. Triggered when the user requests a task
  status check. Argument: task-id.
---

# Check Task Status

## Boundary / Critical Rules

- This skill is **read-only** -- it does not modify any files
- Always check active, blocked, and completed directories

## Steps

### 1. Find Task

Search for the task in this priority order:
1. `.ai-workspace/active/{task-id}/task.md`
2. `.ai-workspace/blocked/{task-id}/task.md`
3. `.ai-workspace/completed/{task-id}/task.md`

Note: `{task-id}` format is `TASK-{yyyyMMdd-HHmmss}`, e.g. `TASK-20260306-143022`

If not found in any directory, prompt "Task {task-id} not found".

### 2. Read Task Metadata

From `task.md`, extract:
- `id`, `title`, `type`, `status`, `workflow`
- `current_step`, `assigned_to`
- `created_at`, `updated_at`
- `issue_number`, `pr_number` (if applicable)

### 3. Check Context Files

Check existence and status of:
- `analysis.md` - Requirement analysis
- `plan.md` - Technical plan
- `implementation.md` - Implementation report
- `review.md` - Review report

### 4. Output Status Report

Format the output with clear structure and status indicators:

```
Task Status: {task-id}
=======================

Basic Info:
- Title: {title}
- Type: {type}
- Status: {status}
- Workflow: {workflow}
- Assigned to: {assigned_to}
- Created: {created_at}
- Updated: {updated_at}

Workflow Progress:
  [done]       Requirement Analysis    analysis.md
  [done]       Technical Design        plan.md
  [current]    Implementation          implementation.md
  [pending]    Code Review             review.md
  [pending]    Final Commit

Context Files:
- analysis.md:       exists
- plan.md:           exists
- implementation.md: in progress
- review.md:         not started

Next Step:
  Complete implementation, then run the review-task skill with {task-id}
```

**Status indicators**:
- `[done]` - Step completed
- `[current]` - Currently in progress
- `[pending]` - Not started yet
- `[blocked]` - Blocked
- `[skipped]` - Skipped

### 5. Suggest Next Action

Based on the current workflow state, suggest the appropriate next skill:

| Current State | Suggestion |
|--------------|------------|
| analysis complete | Execute the `plan-task` skill |
| plan complete | Execute the `implement-task` skill |
| implementation complete | Execute the `review-task` skill |
| review passed | Execute the `commit` skill |
| review has issues | Execute the `refine-task` skill |
| task blocked | Unblock or provide required info |
| task completed | No action needed |

## Notes

1. **Read-only**: This skill only reads and reports -- it does not modify any files
2. **Multi-directory search**: Always check active, blocked, and completed directories
3. **Quick reference**: Use this skill anytime to check where a task stands in the workflow
