---
name: "complete-task"
description: "Mark task completed and archive to completed directory"
usage: "/complete-task <task-id>"
---

# Complete Task Command

## Description

Mark a task as completed, update task metadata, and move the task from the `active` directory to the `completed` directory for archival.

## CRITICAL: Status Update Requirement

After executing this command, you **must** immediately update task status and move the task directory. See rule 7.

## Prerequisites

Before executing this command, confirm all the following conditions are met:

- [ ] All workflow steps are completed
- [ ] Code has been reviewed and approved (review.md shows approval)
- [ ] Code has been committed to Git
- [ ] Code has been merged to target branch (if needed)
- [ ] All tests pass
- [ ] Issue has been synced (if there's a linked Issue)
- [ ] PR has been merged (if there's a PR)

**Do not execute this command if any of the above conditions are not met.**

## Execution Flow

### 1. Verify Task Exists

Check if the task file exists:
```bash
ls -la .ai-workspace/active/{task-id}/task.md
```

If the task is not in the `active` directory, check if it's already in the `completed` or `blocked` directory.

### 2. Read and Verify Task Status

Read `.ai-workspace/active/{task-id}/task.md`, check:

**Workflow Progress**:
- Are all steps marked as complete ✅
- Is `current_step` the final step (e.g., `finalize` or `code-review`)

**Task Status**:
- Is `status` `active` (about to be changed to `completed`)
- Are there any unresolved blocking issues

**File Completeness**:
- [ ] `analysis.md` exists (for feature-development or security-fix)
- [ ] `plan.md` exists (for feature-development)
- [ ] `implementation.md` exists
- [ ] `review.md` exists and shows approval

If any issues are found, prompt the user and **stop execution**.

### 3. Update Task Status (CRITICAL)

**Must update** `.ai-workspace/active/{task-id}/task.md`:

```yaml
status: completed
current_step: finalize
updated_at: {current time, format: yyyy-MM-dd HH:mm:ss}
completed_at: {current time, format: yyyy-MM-dd HH:mm:ss}
```

**Mark all steps as complete in workflow progress**:
```markdown
## Workflow Progress

- [x] requirement-analysis (claude, {date})
- [x] technical-design (claude, {date})
- [x] implementation (claude, {date})
- [x] code-review (claude, {date})
- [x] finalize (claude, {current date})  ← mark as complete
```

**Add completion summary** (append to task.md):
```markdown
---

## Task Completion Summary

### Completion Information

- **Completion Time**: {current time}
- **Completed By**: {current AI}
- **Related PR**: #{pr-number} (if any)
- **Related Issue**: #{issue-number} (if any)
- **Target Branch**: {branch name}

### Deliverables

- [x] Requirement analysis document: `analysis.md`
- [x] Technical plan document: `plan.md`
- [x] Implementation report: `implementation.md`
- [x] Code review report: `review.md`
- [x] Code commit: {commit-hash}
- [x] PR merged: #{pr-number}

### Task Completion Criteria

- [x] Feature fully implemented
- [x] Code review passed
- [x] All tests pass
- [x] Documentation complete
- [x] Code merged

### Notes

{Add notes if needed}
```

### 4. Archive Task (CRITICAL)

Move the task from the `active` directory to the `completed` directory:

```bash
# Ensure completed directory exists
mkdir -p .ai-workspace/completed

# Move task directory
mv .ai-workspace/active/{task-id} .ai-workspace/completed/
```

**Verify the move was successful**:
```bash
# Verify source directory no longer exists
test ! -d .ai-workspace/active/{task-id} && echo "Removed from active" || echo "ERROR: active directory still exists"

# Verify target directory exists
test -d .ai-workspace/completed/{task-id} && echo "Archived to completed" || echo "ERROR: archival failed"
```

### 5. Optional: Sync to Issue

If the task is linked to a GitHub Issue, use `/sync-issue` to update the Issue status:

```bash
/sync-issue {issue-number}
```

Add completion summary to the Issue:
```markdown
✅ Task completed

**Completion Time**: {current time}
**Related PR**: #{pr-number}
**Task ID**: {task-id}

All work has been completed. Task archived to `.ai-workspace/completed/{task-id}`.
```

### 6. Optional: Update Milestone

If the task is part of a milestone, update milestone progress:
- Mark the task as completed in the project management tool
- Update the milestone's completion percentage

### 7. Inform User

Output format:
```
🎉 Task {task-id} completed and archived

**Task Information**:
- Task ID: {task-id}
- Task Type: {type}
- Workflow: {workflow}
- Completion Time: {current time}

**Archive Location**:
- `.ai-workspace/completed/{task-id}/`

**Related Resources**:
- PR: #{pr-number} (merged)
- Issue: #{issue-number} (synced)
- Commit: {commit-hash}

**Deliverables**:
- ✅ Requirement analysis document
- ✅ Technical plan document
- ✅ Implementation report
- ✅ Code review report
- ✅ Code committed and merged

**Statistics**:
- Modified files: {file count}
- Code lines: +{added lines} -{removed lines}
- Duration: {time from creation to completion}

**Next Steps**:
If there are other pending tasks, check them with:
- Claude Code / OpenCode: `/check-task {task-id}`
- Gemini CLI: `/{project}:check-task {task-id}`
- Codex CLI: `/prompts:{project}-check-task {task-id}`

Task archived successfully! 🎊
```

## Completion Checklist

After executing this command, confirm:

- [ ] Verified all prerequisites are met
- [ ] Updated `status` to completed in task.md
- [ ] Updated `current_step` to finalize in task.md
- [ ] Updated `updated_at` to current time in task.md
- [ ] Added `completed_at` field in task.md
- [ ] Marked all steps as complete in workflow progress
- [ ] Added "Task Completion Summary" section
- [ ] Moved task from active to completed directory
- [ ] Verified the move was successful
- [ ] If there's a linked Issue, synced the update
- [ ] Informed user the task is complete

## FAQ

### Q: What if the task still has incomplete steps?

A: **Do not execute this command**. Complete all steps before archiving. If a step cannot be completed, use `/block-task` to mark as blocked.

### Q: What if code is committed but PR is not merged?

A: Wait for the PR to merge before executing this command. Task completion means code has been merged into the main branch.

### Q: What if the review found issues but they were chosen not to be fixed?

A: The reason must be stated in `review.md` and approved. If there are unfixed blocker issues, the task cannot be marked as complete.

### Q: Can an archived task still be modified?

A: It can be read but modifying is not recommended. If issues are found, create a new task for the fix.

### Q: What if the task was completed by multiple people?

A: List all contributors in the "Task Completion Summary". The `completed_by` field records who executed the final archival operation.

### Q: Should the Issue be closed as well?

A: Using `/sync-issue` will update the Issue status, but whether to close is up to the user. Typically, the Issue should be closed after task completion.

## Notes

### Do Not Archive Prematurely

Only archive tasks after **truly completing** all work. Common "not completed" situations:
- ❌ Code committed but tests fail
- ❌ PR created but not merged
- ❌ Review not approved
- ❌ Known issues still to fix
- ❌ Documentation incomplete

### Ensure Data Completeness

Confirm all documents have been created before archiving:
- `analysis.md`
- `plan.md`
- `implementation.md`
- `review.md`

### Verify Move Was Successful

After moving the directory, must verify:
- Source directory (`active/{task-id}`) does not exist
- Target directory (`completed/{task-id}`) exists with complete contents

## Related Commands

- `/check-task` - View task status, confirm completion conditions are met
- `/sync-issue` - Sync task status to GitHub Issue
- `/block-task` - If the task cannot be completed, use this to mark as blocked

## Workflow Position

This command corresponds to the **finalize** step in `.agents/workflows/feature-development.yaml`.

## Example

```bash
# Mark TASK-20260103-135501 as complete and archive
/complete-task TASK-20260103-135501
```

## Rollback

If a task was archived by mistake, you can manually rollback:

```bash
# Move task back to active directory
mv .ai-workspace/completed/{task-id} .ai-workspace/active/

# Update task status
# Edit task.md, change status back to active, remove completed_at
```

But proceed with caution — accidental archival usually indicates a process issue.
