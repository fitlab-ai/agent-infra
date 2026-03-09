---
name: "block-task"
description: "Mark task as blocked and record blocking reason"
usage: "/block-task <task-id> [--reason <blocking reason>]"
---

# Block Task Command

## Description

When a task encounters an issue that prevents continuation, use this command to mark the task as blocked, record the detailed blocking reason, and move the task to the `blocked` directory to await resolution.

## CRITICAL: Status Update Requirement

After executing this command, you **must** immediately update task status and move the task directory. See rule 7.

## Use Cases

### When to Use This Command

Mark a task as blocked in the following situations:

**Technical Issues**:
- ❌ Build failure that cannot be fixed
- ❌ Test failure with unknown cause
- ❌ Bug in a dependency library
- ❌ Environment configuration issue
- ❌ Toolchain issue

**Requirement Issues**:
- ❓ Requirements unclear, need clarification
- ❓ Requirement conflict discovered
- ❓ Missing necessary requirement information
- ❓ Product decision needed

**Resource Issues**:
- ⏳ Waiting for external dependency
- ⏳ Waiting for third-party API or service
- ⏳ Waiting for database migration
- ⏳ Waiting for infrastructure readiness

**Decision Issues**:
- 🤔 Architecture decision needed
- 🤔 Security review needed
- 🤔 Performance optimization approach selection needed
- 🤔 Human review and approval needed

### When NOT to Use This Command

The following situations should **NOT** be marked as blocked:

- ✅ Code review found issues → Use `/refine-task` to fix
- ✅ Implementation hit difficulties but solvable → Continue implementation
- ✅ Test failure with known cause → Fix the test
- ✅ Documentation incomplete → Complete the documentation

## Execution Flow

### 1. Verify Task Exists

Check if the task file exists:
```bash
ls -la .ai-workspace/active/{task-id}/task.md
```

If the task is not in the `active` directory, check if it's already in the `blocked` or `completed` directory.

### 2. Analyze Blocking Reason

Before marking as blocked, must carefully analyze and record the following information:

**Problem Description**:
- What specific problem was encountered?
- At which step did the problem occur?
- What are the symptoms?

**Root Cause**:
- Why did this problem occur?
- What is the root cause?
- Are there error logs or diagnostic information?

**Attempted Solutions**:
- What methods have been tried?
- Why didn't they solve the problem?

**Help Needed**:
- Who is needed to help resolve this?
- What resources or information are needed?
- How long is the estimated resolution time?

### 3. Update Task Status (CRITICAL)

**Must update** `.ai-workspace/active/{task-id}/task.md`:

```yaml
status: blocked
current_step: {current step, keep unchanged}
updated_at: {current time, format: yyyy-MM-dd HH:mm:ss}
blocked_at: {current time, format: yyyy-MM-dd HH:mm:ss}
blocked_by: {current AI}
blocked_reason: {brief description of blocking reason}
```

**Add "Blocking Information" section to task.md** (insert before "Notes"):

```markdown
---

## ⚠️ Blocking Information

### Block Summary

- **Blocked At**: {current time}
- **Blocked Step**: {current_step}
- **Blocked By**: {current AI}
- **Block Type**: {Technical/Requirement/Resource/Decision}
- **Severity**: {High/Medium/Low}
- **Estimated Resolution Time**: {estimate}

### Problem Description

{Detailed description of the problem, including error messages, logs, screenshots, etc.}

### Root Cause

{Analysis of the root cause}

### Attempted Solutions

1. **Attempt 1**: {Description}
   - Result: {Failed/Partially successful}
   - Reason: {Why it didn't resolve the issue}

2. **Attempt 2**: {Description}
   - Result: {Failed/Partially successful}
   - Reason: {Why it didn't resolve the issue}

### Help Needed

**Who**: {Developer/Architect/Product Manager/DevOps/Security Team}

**What**:
- Clarify XX requirement
- Resolve XX technical issue
- Provide XX resource
- Make XX decision

**Additional Information**:
{Any extra information that could help resolve the issue}

### Unblock Conditions

The task can be unblocked and resumed when the following conditions are met:
- [ ] Condition 1
- [ ] Condition 2
- [ ] Condition 3

### Fallback Plans

If the issue cannot be resolved within a reasonable timeframe, consider:
- Plan 1: {Description}
- Plan 2: {Description}

---
```

### 4. Move to Blocked Directory (CRITICAL)

Move the task from the `active` directory to the `blocked` directory:

```bash
# Ensure blocked directory exists
mkdir -p .ai-workspace/blocked

# Move task directory
mv .ai-workspace/active/{task-id} .ai-workspace/blocked/
```

**Verify the move was successful**:
```bash
# Verify source directory no longer exists
test ! -d .ai-workspace/active/{task-id} && echo "Removed from active" || echo "ERROR: active directory still exists"

# Verify target directory exists
test -d .ai-workspace/blocked/{task-id} && echo "Moved to blocked" || echo "ERROR: move failed"
```

### 5. Optional: Sync to Issue

If the task is linked to a GitHub Issue, use `/sync-issue` to update the Issue status:

```bash
/sync-issue {issue-number}
```

Add blocking note to the Issue:
```markdown
⚠️ Task is currently blocked

**Blocked At**: {current time}
**Blocking Reason**: {brief description}
**Help Needed**: {what's needed}

See task file for details: `.ai-workspace/blocked/{task-id}/task.md`
```

You can add a `blocked` label to the Issue.

### 6. Notify Stakeholders

Inform the user and relevant parties that the task is blocked:

**Output format**:
```
⚠️  Task {task-id} has been marked as blocked

**Task Information**:
- Task ID: {task-id}
- Task Type: {type}
- Blocked Step: {current_step}
- Blocked At: {current time}

**Blocking Reason**:
{Brief description of blocking reason}

**Help Needed**:
{Who is needed, what is needed}

**Blocked Location**:
- `.ai-workspace/blocked/{task-id}/`

**Next Steps**:
1. Review the "Blocking Information" section in the task file for details
2. After resolving the blocking issue, manually move back to active directory:
   ```bash
   mv .ai-workspace/blocked/{task-id} .ai-workspace/active/
   # Then update status to active in task.md, remove blocked_* fields
   ```
3. After recovery, check task status and continue workflow:
   - Claude Code / OpenCode: `/check-task {task-id}`
   - Gemini CLI: `/{project}:check-task {task-id}`
   - Codex CLI: `/prompts:{project}-check-task {task-id}`

**Related Resources**:
- Issue: #{issue-number} (synced)
- Related docs: {list related docs}
```

### 7. Create Block Log (Optional)

Maintain a blocked tasks list in the project:

```bash
# Append to block log
echo "{current time} | {task-id} | {blocking reason} | {help needed}" >> .ai-workspace/logs/blocked-tasks.log
```

## Completion Checklist

After executing this command, confirm:

- [ ] Thoroughly analyzed blocking reason
- [ ] Updated `status` to blocked in task.md
- [ ] Updated `updated_at` to current time in task.md
- [ ] Added `blocked_at` field in task.md
- [ ] Added `blocked_by` field in task.md
- [ ] Added `blocked_reason` field in task.md
- [ ] Added complete "Blocking Information" section in task.md
- [ ] Moved task from active to blocked directory
- [ ] Verified the move was successful
- [ ] If there's a linked Issue, synced the update
- [ ] Notified user and relevant parties
- [ ] Specified unblock conditions

## Unblocking

When the issue is resolved, manually unblock:

```bash
# Move task back to active directory
mv .ai-workspace/blocked/{task-id} .ai-workspace/active/
```

**Update task.md**:
```yaml
status: active
# Remove the following fields:
# blocked_at
# blocked_by
# blocked_reason
```

**Add resolution record to the "Blocking Information" section**:
```markdown
### Resolution Record

- **Resolved At**: {current time}
- **Resolved By**: {resolver}
- **Resolution Method**: {how it was resolved}
- **Block Duration**: {time from block to resolution}
```

Then continue task execution.

## FAQ

### Q: What if I'm unsure whether to mark as blocked?

A: Follow these principles:
- If the issue **you cannot solve** and needs external help → mark as blocked
- If the issue **you can solve** but just needs time → do not mark as blocked
- If **uncertain**, try resolving for 1-2 hours first; if no progress, then mark as blocked

### Q: Can a task be blocked at any step?

A: Yes. Any step that encounters an unresolvable issue should be marked as blocked, rather than forcing ahead.

### Q: How detailed should the blocking reason be?

A: The more detailed the better. Imagine you're writing an incident report — the goal is to help the person taking over quickly understand and resolve the issue.

### Q: What if there are multiple blocking issues?

A: List all issues in the "Blocking Information" section, sorted by priority.

### Q: Will blocked tasks still be tracked?

A: Yes. The `blocked` directory should be checked regularly to ensure issues receive attention and get resolved.

### Q: Should a block timeout be set?

A: It's recommended to note the "Estimated Resolution Time" in the blocking information. If the issue is not resolved past the expected time, you should:
1. Re-evaluate the issue
2. Consider fallback plans
3. Escalate the issue priority

## Block Types and Handling

### Technical Issue Blocks

**Characteristics**: Build failure, test failure, tool issues
**Handling**:
1. Collect detailed error logs
2. Search for similar issue solutions
3. If it's a tool bug, report to tool maintainers
4. Consider using alternative tools or methods

### Requirement Issue Blocks

**Characteristics**: Requirements unclear, requirement conflicts
**Handling**:
1. List specific questions
2. Provide multiple possible interpretations
3. Note the impact of each interpretation
4. Ask the product manager or user to clarify

### Resource Issue Blocks

**Characteristics**: Waiting for external dependency, service unavailable
**Handling**:
1. Specify the resource being waited for and estimated time
2. Check if there's a temporary workaround
3. Consider working on other tasks in parallel
4. Track resource preparation progress

### Decision Issue Blocks

**Characteristics**: Architecture decision needed, approach selection needed
**Handling**:
1. List all feasible approaches
2. Analyze pros and cons of each
3. Provide recommended approach with reasoning
4. Ask relevant people to make the decision

## Notes

### Mark Promptly

- Don't delay. Once it's clear the issue cannot be resolved, mark as blocked immediately
- Don't try to "force through". Forcing ahead may cause bigger problems

### Communicate Clearly

- Blocking information should be detailed, accurate, and objective
- Avoid vague descriptions like "some issues" or "not working well"
- Provide specific error messages, logs, and reproduction steps

### Follow Up Proactively

- After marking as blocked, proactively follow up on resolution progress
- Regularly update the blocking status
- If there's new information or attempts, promptly update the "Blocking Information" section

## Related Commands

- `/check-task` - View task status, including blocked tasks
- `/sync-issue` - Sync blocking status to GitHub Issue
- `/unblock-task` - Unblock task (if this command is implemented)

## Workflow Position

This command can be used at any workflow step when encountering an issue that prevents continuation.

## Examples

```bash
# Mark task as blocked with a reason
/block-task TASK-20260103-135501 --reason "Build failure: missing dependency org.example:foo:1.2.3"

# Mark as blocked, edit detailed reason later
/block-task TASK-20260103-135501
```

## Statistics and Monitoring

Recommend regularly checking blocked tasks:

```bash
# List all blocked tasks
ls -la .ai-workspace/blocked/

# Count blocked tasks
ls -1 .ai-workspace/blocked/ | wc -l

# View block duration for blocked tasks
# Can write a script to analyze blocked_at fields
```

For long-term blocked tasks, consider:
1. Re-evaluating priority
2. Seeking additional resources
3. Considering task cancellation
