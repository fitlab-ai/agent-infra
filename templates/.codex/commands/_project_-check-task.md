---
description: View task current status and progress
argument-hint: <task-id>
---

View the current status, progress, and context files of task $1.

Execute the following steps:

1. Find task file:
   Search in the following priority order:
   - .ai-workspace/active/$1/task.md (priority)
   - .ai-workspace/blocked/$1/task.md
   - .ai-workspace/completed/$1/task.md
   If none found, inform the user the task does not exist.

2. Read task information:
   Get from task.md: id, type, workflow, status, current_step, assigned_to, created_at, updated_at

3. Check whether context files exist:
   - analysis.md - Requirement analysis
   - plan.md - Technical plan
   - implementation.md - Implementation report
   - review.md - Review report

4. Output status report:
   ```
   Task Status Report

   **Basic Information**:
   - Task ID: $1
   - Task title: <title>
   - Task type: <type>
   - Created at: <created_at>

   **Current Status**:
   - Workflow: <workflow>
   - Current step: <current_step>
   - Assigned to: <assigned_to>

   **Workflow Progress**:
   Status of each step

   **Context Files**:
   Existence status of each file

   **Next Step Suggestions**:
   Provide specific command suggestions based on current status
   ```

**Next step suggestion rules**:
- Requirement analysis complete:
  - Claude Code / OpenCode: /plan-task $1
  - Gemini CLI: /{project}:plan-task $1
  - Codex CLI: /prompts:{project}-plan-task $1
- Technical plan complete -> Wait for human review; after approval:
  - Claude Code / OpenCode: /implement-task $1
  - Gemini CLI: /{project}:implement-task $1
  - Codex CLI: /prompts:{project}-implement-task $1
- Implementation complete:
  - Claude Code / OpenCode: /review-task $1
  - Gemini CLI: /{project}:review-task $1
  - Codex CLI: /prompts:{project}-review-task $1
- Review complete (approved):
  - Claude Code / OpenCode: /commit
  - Gemini CLI: /{project}:commit
  - Codex CLI: /prompts:{project}-commit
- Review complete (changes needed):
  - Claude Code / OpenCode: /refine-task $1
  - Gemini CLI: /{project}:refine-task $1
  - Codex CLI: /prompts:{project}-refine-task $1
- Task blocked -> Show blocking reason and unblock conditions
