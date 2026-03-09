---
description: Mark task completed and archive to completed directory
argument-hint: <task-id>
---

Mark task $1 as completed, update task metadata, and archive to the completed directory.

**Prerequisites check**:
Before executing, confirm all conditions are met:
- All workflow steps completed
- Code reviewed and approved (review.md shows approval)
- Code committed to Git
- All tests pass
**Do not execute if any conditions above are not met.**

Execute the following steps:

1. Verify task exists:
   ```bash
   test -f .ai-workspace/active/$1/task.md && echo "✅ Task exists" || echo "❌ ERROR: Task not found"
   ```

2. Read and verify task status:
   - Check all steps are marked complete ✅
   - Check file completeness: analysis.md, plan.md, implementation.md, review.md all exist

3. Get current time:
   ```bash
   date '+%Y-%m-%d %H:%M:%S'
   ```

4. Update task status:
   Use Edit tool to update task.md:
   - status: completed
   - current_step: finalize
   - updated_at: current time
   - completed_at: current time

5. Append completion summary to task.md (deliverables, completion criteria, etc.)

6. Archive task:
   ```bash
   mkdir -p .ai-workspace/completed && mv .ai-workspace/active/$1 .ai-workspace/completed/
   ```

7. Verify move was successful:
   ```bash
   test ! -d .ai-workspace/active/$1 && echo "✅ Removed from active" || echo "❌ active still exists"
   test -d .ai-workspace/completed/$1 && echo "✅ Archived to completed" || echo "❌ Archive failed"
   ```

8. Inform user:
   - Task $1 completed and archived to .ai-workspace/completed/$1/
   - Suggest next steps if other pending tasks exist

**Notes**:
- Only archive after truly completing all work
- Confirm all documents are created before archiving
