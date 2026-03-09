---
description: Mark task as blocked and record blocking reason
argument-hint: <task-id> [reason]
---

Mark task $1 as blocked, record the detailed blocking reason, and move it to the blocked directory.

**Use cases**:
- Build failure that cannot be resolved
- Test failure with unknown cause
- Dependency library has a bug
- Requirements are unclear, need clarification
- Waiting for external dependency

**Should NOT be marked as blocked**:
- Code review found issues -> use /refine-task $1 to fix
- Implementation hit difficulties but can be resolved -> continue implementing

Execute the following steps:

1. Verify task exists:
   ```bash
   test -f .ai-workspace/active/$1/task.md && echo "Task exists" || echo "ERROR: Task not found"
   ```

2. Analyze and record blocking reason:
   User-provided blocking reason: $2
   If the above value is empty, ask the user to specify the blocking reason.
   Determine the following:
   - Block type: Technical/Requirement/Resource/Decision
   - Problem description, root cause, attempted solutions, help needed

3. Get current time:
   ```bash
   date '+%Y-%m-%d %H:%M:%S'
   ```

4. Update task status:
   Use the Edit tool to update task.md:
   - status: blocked
   - updated_at: current time
   - blocked_at: current time
   - blocked_by: codex
   - blocked_reason: brief description of the blocking reason

5. Add a "Blocking Information" section to task.md (blocking summary, problem description, root cause, attempted solutions, unblock conditions)

6. Move to blocked directory:
   ```bash
   mkdir -p .ai-workspace/blocked && mv .ai-workspace/active/$1 .ai-workspace/blocked/
   ```

7. Verify move succeeded:
   ```bash
   test ! -d .ai-workspace/active/$1 && echo "Removed from active" || echo "Still in active"
   test -d .ai-workspace/blocked/$1 && echo "Moved to blocked" || echo "Move failed"
   ```

8. Inform user:
   ```
   Task $1 has been marked as blocked
   Archive location: .ai-workspace/blocked/$1/
   ```
   - Suggest next steps:
     - After resolving the blocking issue, manually move back to active directory
     - After recovery, check task status:
       - Claude Code / OpenCode: /check-task $1
       - Gemini CLI: /{project}:check-task $1
       - Codex CLI: /prompts:{project}-check-task $1

**Unblocking**:
```bash
mv .ai-workspace/blocked/$1 .ai-workspace/active/
```
Then update task.md: change status back to active, remove blocked-related fields.

**Notes**:
- Blocking information should be detailed, accurate, and objective
- Actively follow up on problem resolution progress after marking as blocked
