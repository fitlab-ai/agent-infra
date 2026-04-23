---
name: check-task
description: "Check a task's current status and progress"
---

# Check Task Status

## Boundary / Critical Rules

- This skill is **read-only** -- do not modify any files
- Always check the active, blocked, and completed directories

## Steps

### 1. Locate Task

Search for the task in this priority order:
1. `.agents/workspace/active/{task-id}/task.md`
2. `.agents/workspace/blocked/{task-id}/task.md`
3. `.agents/workspace/completed/{task-id}/task.md`

Note: `{task-id}` format is `TASK-{yyyyMMdd-HHmmss}`, for example `TASK-20260306-143022`

If the task is not found in any directory, prompt "Task {task-id} not found".

### 2. Read Task Metadata

Extract from `task.md`:
- `id`, `title`, `type`, `status`, `workflow`
- `current_step`, `assigned_to`
- `created_at`, `updated_at`
- `issue_number`, `pr_number` (if applicable)

### 3. Inspect Context Files

Scan and record the existence, round, and status of these artifact types:
- `analysis.md`, `analysis-r{N}.md` - Requirement analysis
- `plan.md`, `plan-r{N}.md` - Technical plan
- `implementation.md`, `implementation-r2.md`, ... - Implementation reports
- `refinement.md`, `refinement-r2.md`, ... - Refinement reports
- `review.md`, `review-r2.md`, ... - Review reports

For versioned artifacts (`analysis`, `plan`, `implementation`, `refinement`, `review`):
- Scan all versioned files of the same artifact type in the task directory
- Record the latest round, latest file path, and total number of rounds for each artifact type
- If the latest round is recorded in `task.md` Activity Log, cross-check it against the actual file when possible

### 4. Output Status Report

Format the status report with a clear structure and status indicators:

```
Task status: {task-id}
=======================

Basic info:
- Title: {title}
- Type: {type}
- Status: {status}
- Workflow: {workflow}
- Assigned to: {assigned_to}
- Created at: {created_at}
- Updated at: {updated_at}

Workflow progress:
  [done]       Requirement Analysis  analysis-r2.md (Round 2, latest)
  [done]       Technical Design      plan.md (Round 1)
  [current]    Implementation        implementation.md (Round 1)
  [pending]    Refinement            refinement.md (Round 1 will be created next)
  [pending]    Code Review           review.md (Round 1 will be created next)
  [pending]    Final Commit

Context files:
- analysis.md:           Exists (Round 1)
- analysis-r2.md:        Exists (Round 2, latest)
- plan.md:               Exists (Round 1, latest)
- implementation.md:     Exists (Round 1, latest)
- refinement.md:         Not started
- review.md:             Not started

If multiple rounds exist, show all rounds and mark the latest, for example:
- plan.md: Exists (Round 1)
- plan-r2.md: Exists (Round 2, latest)
- implementation.md: Exists (Round 1)
- implementation-r2.md: Exists (Round 2, latest)
- refinement.md: Exists (Round 1)
- review.md: Exists (Round 1)
- review-r2.md: Exists (Round 2, latest)

Next step:
  Complete implementation, then run code review
```

**Status indicators**:
- `[done]` - Step completed
- `[current]` - Currently in progress
- `[pending]` - Not started yet
- `[blocked]` - Blocked
- `[skipped]` - Skipped

### 5. Recommend Next Action

Recommend the appropriate next skill based on the current workflow state. You must show command formats for all TUI columns in the table below, not just the current AI agent. If `.agents/.airc.json` configures `customTools`, read each tool's `name` and `invoke`, then add the matching command line in the same format (`{name}` becomes the skill name and `&#123;project&#125;` becomes the project name).

> **⚠️ CONDITION CHECK — you must choose the single matching row in the table below based on `status`, `current_step`, the latest artifacts, and the latest review result:**
>
> - `status = blocked` -> choose "Task Blocked"
> - `status = completed` -> choose "Task Completed"
> - `current_step = requirement-analysis` and the latest analysis artifact is complete -> choose "Analysis Complete"
> - `current_step = technical-design` and the latest plan artifact is complete -> choose "Plan Complete"
> - The latest implementation artifact exists and there is still no latest review artifact -> choose "Implementation Complete"
> - The latest review artifact exists, the verdict is `Approved`, and `Blocker = 0`, `Major = 0`, `Minor = 0` -> choose "Review Passed"
> - The latest review artifact exists, but any `Blocker`, `Major`, or `Minor` issue remains, or the verdict is not a clean approval -> choose "Review Has Issues"
>
> **Important: if the latest review report contains any issue at all, do not use the "Review Passed" row. You must use "Review Has Issues" instead.**

| Current State | Claude Code / OpenCode | Gemini CLI | Codex CLI |
|--------------|------------------------|------------|-----------|
| Analysis Complete | `/plan-task {task-id}` | `/{{project}}:plan-task {task-id}` | `$plan-task {task-id}` |
| Plan Complete | `/implement-task {task-id}` | `/{{project}}:implement-task {task-id}` | `$implement-task {task-id}` |
| Implementation Complete | `/review-task {task-id}` | `/{{project}}:review-task {task-id}` | `$review-task {task-id}` |
| Review Passed | `/commit` | `/{{project}}:commit` | `$commit` |
| Review Has Issues | `/refine-task {task-id}` | `/{{project}}:refine-task {task-id}` | `$refine-task {task-id}` |
| Task Blocked | Unblock the task or provide the missing information | — | Unblock the task or provide the missing information |
| Task Completed | No action needed | — | No action needed |

## Notes

1. **Read-only**: This skill only reads and reports -- it does not modify files
2. **Multi-directory search**: Always check active, blocked, and completed
3. **Quick reference**: Use this skill any time you need to see where a task is in the workflow
4. **Versioned artifacts**: `analysis`, `plan`, `implementation`, `refinement`, and `review` must all report the actual round, not only the base filename
