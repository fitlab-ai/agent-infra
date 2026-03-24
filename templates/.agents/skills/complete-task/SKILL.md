---
name: complete-task
description: >
  Mark a task as completed and archive it by moving the task directory from
  active/ to completed/. Verifies that all workflow steps are done, code is
  reviewed and committed, and tests pass before allowing completion.
  Triggered when the user requests task completion or archiving.
  Argument: task-id.
---

# Complete Task

## Boundary / Critical Rules

- This command updates task metadata AND physically moves the task directory
- Do not archive a task that has incomplete workflow steps unless forced

## Steps

### 1. Verify Task Exists

Check that the task exists in `.agents/workspace/active/{task-id}/`.

Note: `{task-id}` format is `TASK-{yyyyMMdd-HHmmss}`, e.g. `TASK-20260306-143022`

If not found in `active/`, check `blocked/` and `completed/`:
- If in `completed/`: Inform user the task is already completed
- If in `blocked/`: Inform user the task is blocked; suggest unblocking first

### 2. Verify Completion Prerequisites (Failure Must Stop)

Before marking complete, verify ALL of these:
- [ ] All workflow steps are complete (check workflow progress in task.md)
- [ ] Code has been reviewed (`review.md` or `review-r{N}.md` exists, and the latest review verdict is Approved; or review was done externally)
- [ ] Code has been committed (no uncommitted changes related to this task)
- [ ] Tests are passing

> **⚠️ Prerequisite Branch Check — you must decide whether to continue or stop before proceeding:**
>
> - If all conditions above are satisfied -> continue to Step 3
> - If any condition is missing -> **stop by default** and output the prerequisite warning
> - Only continue with unmet prerequisites when the user explicitly requested `--force`
>
> **Do not continue to Steps 3-7 when prerequisites are not met, and do not output "Task {task-id} completed and archived."**

If any prerequisite is not met, warn the user:
```
Cannot complete task {task-id} - prerequisites not met:
- [ ] {Missing prerequisite}

Please complete the missing steps first, or use --force to override.
```

If prerequisites are not met and the user did not explicitly provide `--force`, stop immediately and do not execute Steps 3-7.

### 3. Update Task Metadata

Get the current time:

```bash
date "+%Y-%m-%d %H:%M:%S"
```

Update `.agents/workspace/active/{task-id}/task.md`:
- `status`: completed
- `completed_at`: {current timestamp}
- `updated_at`: {current timestamp}
- Mark all workflow steps as complete
- **Append** to `## Activity Log` (do NOT overwrite previous entries):
  ```
  - {yyyy-MM-dd HH:mm:ss} — **Completed** by {agent} — Task archived to completed/
  ```

### 4. Archive Task

Move the task directory from active to completed:

```bash
mv .agents/workspace/active/{task-id} .agents/workspace/completed/{task-id}
```

### 5. Verify Archive

```bash
ls .agents/workspace/completed/{task-id}/task.md
```

Confirm the task directory was successfully moved.

### 6. Sync to Issue (Optional)

Check whether `task.md` includes an `issue_number` field whose value is neither empty nor `N/A`. If not, **skip this step and output nothing**.

If a valid `issue_number` exists, optionally sync the completion status:

> **IMPORTANT**: All TUI command formats listed below must be output in full. Do not show only the format for the current AI agent.

```
(Optional) Sync completion status to the GitHub Issue:
  - Claude Code / OpenCode: /sync-issue {issue_number}
  - Gemini CLI: /{{project}}:sync-issue {issue_number}
  - Codex CLI: $sync-issue {issue_number}
```

### 7. Inform User

Output format:
```
Task {task-id} completed and archived.

Task info:
- Title: {title}
- Completed at: {timestamp}
- Archived to: .agents/workspace/completed/{task-id}/

Deliverables:
- {List of key outputs: files modified, tests added, etc.}
```

## Completion Checklist

- [ ] Verified all workflow steps are complete
- [ ] Updated task.md with completed status and timestamp
- [ ] Moved task directory to `.agents/workspace/completed/`
- [ ] Verified archive succeeded
- [ ] Informed user of completion

## Notes

1. **Premature completion**: Do not archive a task that has incomplete steps. Examples of incomplete situations:
   - Code is written but not committed
   - Code is committed but not reviewed
   - Review found blockers that haven't been fixed
   - PR is created but not merged

2. **Rollback**: If a task was archived incorrectly:
   ```bash
   mv .agents/workspace/completed/{task-id} .agents/workspace/active/{task-id}
   ```
   Then update task.md status back to `active`.

3. **Multiple contributors**: If multiple AI agents worked on the task, ensure all contributions are committed before completing.

## Error Handling

- Task not found: Prompt "Task {task-id} not found in active directory"
- Already completed: Prompt "Task {task-id} is already in completed directory"
- Task is blocked: Prompt "Task {task-id} is blocked. Unblock it first by moving to active/"
- Move failed: Prompt error and suggest manual move
