---
name: "check-task"
description: "View task current status and progress"
usage: "/check-task <task-id>"
---

# Task Status Command

## Description

View the current status, progress, and context files of the specified task.

## Execution Flow

### 1. Read Task File

Read `.ai-workspace/active/{task-id}/task.md` (if the task is completed, also check the `completed/` directory)

### 2. Check Context Files

Check whether the following files exist:
- `analysis.md` - Requirement analysis
- `plan.md` - Technical plan
- `implementation.md` - Implementation report
- `review.md` - Review report

### 3. Analyze Current Status

Based on the task file and context files, determine:
- Which step is currently being executed
- Which steps are completed
- Which steps are pending
- The currently assigned AI
- Whether waiting for human review

### 4. Output Status Report

Output formatted status information:

```
📋 Task Status Report

**Basic Information**:
- Task ID: {task-id}
- Task Title: {title}
- Task Type: {type}
- Related Issue: #{issue-number}
- Created: {created_at}
- Updated: {updated_at}

**Current Status**:
- Workflow: {workflow}
- Current Step: {current_step}
- Assigned To: {assigned_to}
- Status: {status}

**Workflow Progress**:
✅ Requirement Analysis (completed on {date})
✅ Technical Design (completed on {date})
⏳ Code Implementation (in progress)
⏸️  Code Review (pending)
⏸️  Issue Fix (pending)

**Context Files**:
✅ analysis.md (2.5 KB)
✅ plan.md (8.3 KB)
⏳ implementation.md (in progress)
❌ review.md (not created)

**File Paths**:
- Task file: .ai-workspace/active/{task-id}/task.md
- Context directory: .ai-workspace/active/{task-id}/

**Next Step Suggestion**:
{Suggestion based on current status}
```

## Parameters

- `<task-id>`: Task ID, format TASK-{yyyyMMdd-HHmmss} (required)

## Usage Example

```bash
# View task status
/check-task TASK-20251227-104654
```

## Status Description

### Task Status

- `active` - In progress
- `blocked` - Blocked
- `completed` - Completed

### Step Status

- ✅ Completed
- ⏳ In progress
- ⏸️ Pending
- ❌ Failed/Blocked

### Next Step Suggestions

Auto-generate suggestions based on current status:

**If in requirement analysis phase**:
```
Continue requirement analysis, after completion use:
- Claude Code / OpenCode: /plan-task {task-id}
- Gemini CLI: /{project}:plan-task {task-id}
- Codex CLI: /prompts:{project}-plan-task {task-id}
```

**If requirement analysis complete, awaiting human review**:
```
⚠️  Awaiting human review of requirement analysis
After review approval, use:
- Claude Code / OpenCode: /plan-task {task-id}
- Gemini CLI: /{project}:plan-task {task-id}
- Codex CLI: /prompts:{project}-plan-task {task-id}
```

**If in technical design phase**:
```
Continue technical design, wait for human review after completion
```

**If design complete, awaiting human review**:
```
⚠️  Awaiting human review of technical plan
After review approval, use:
- Claude Code / OpenCode: /implement-task {task-id}
- Gemini CLI: /{project}:implement-task {task-id}
- Codex CLI: /prompts:{project}-implement-task {task-id}
```

**If in code implementation phase**:
```
Continue code implementation, after completion use:
- Claude Code / OpenCode: /review-task {task-id}
- Gemini CLI: /{project}:review-task {task-id}
- Codex CLI: /prompts:{project}-review-task {task-id}
```

**If implementation complete, awaiting review**:
```
Use the following command for code review:
- Claude Code / OpenCode: /review-task {task-id}
- Gemini CLI: /{project}:review-task {task-id}
- Codex CLI: /prompts:{project}-review-task {task-id}
```

**If review complete, ready to commit**:
```
Use the following command to commit code:
- Claude Code / OpenCode: /commit
- Gemini CLI: /{project}:commit
- Codex CLI: /prompts:{project}-commit
```

**If task is blocked**:
```
⚠️  Task is blocked
Blocking reason: {reason}
Please resolve the blocking issue before continuing
```

## Notes

1. **Multi-directory search**:
   - Search in `active/` directory first
   - If not found, check `completed/` directory
   - If still not found, check `blocked/` directory

2. **Concise output**:
   - Output should be clear and structured
   - Use emoji for readability
   - Highlight key information

3. **Smart suggestions**:
   - Provide next step suggestions based on current status
   - Indicate human review checkpoints
   - Provide specific command examples

## Related Commands

- `/analyze-issue <number>` - Analyze Issue
- `/plan-task <task-id>` - Design technical plan
- `/implement-task <task-id>` - Implement task

## Error Handling

- Task not found: Prompt "Task {task-id} not found, please check the task ID"
- Corrupted task file: Prompt "Task file format error"
