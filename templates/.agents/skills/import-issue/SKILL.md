---
name: import-issue
description: "Import a GitHub Issue and create a task"
---

# Import Issue

Import the specified GitHub Issue and create a task. Argument: issue number.

## Boundary / Critical Rules

- The only output is `task.md`
- Do not write or modify business code; import only
- After executing this skill, you **must** immediately update task status

## Execution Flow

### 1. Retrieve Issue Information

```bash
gh issue view <issue-number> --json number,title,body,labels
```

Extract: issue number, title, description, and labels.
Use the Issue title as-is for the task title (preserve the Issue's original language).

### 2. Check for an Existing Task

Search `.agents/workspace/active/` for an existing task linked to this Issue.
- If found, ask the user whether to re-import or continue with the existing task
- If not found, create a new task

### 3. Create the Task Directory and File

```bash
date +%Y%m%d-%H%M%S
```

- Create the directory: `.agents/workspace/active/TASK-{yyyyMMdd-HHmmss}/`
- Use the `.agents/templates/task.md` template to create `task.md`

Task metadata:
```yaml
id: TASK-{yyyyMMdd-HHmmss}
issue_number: <issue-number>
type: feature|bugfix|refactor|docs|chore
workflow: feature-development|bug-fix|refactoring
status: active
created_at: {yyyy-MM-dd HH:mm:ss}
updated_at: {yyyy-MM-dd HH:mm:ss}
created_by: human
current_step: requirement-analysis
assigned_to: {current AI agent}
```

### 4. Update Task Status

Get the current time:

```bash
date "+%Y-%m-%d %H:%M:%S"
```

Update `.agents/workspace/active/{task-id}/task.md`:
- `current_step`: requirement-analysis
- `assigned_to`: {current AI agent}
- `updated_at`: {current time}
- **Append** to `## Activity Log` (do NOT overwrite previous entries):
  ```
  - {yyyy-MM-dd HH:mm:ss} — **Import Issue** by {agent} — Issue #{number} imported
  ```

### 5. Verification Gate

Run the verification gate to confirm the task artifact and sync state are valid:

```bash
node .agents/scripts/validate-artifact.js gate import-issue .agents/workspace/active/{task-id} --format text
```

Handle the result as follows:
- exit code 0 (all checks passed) -> continue to the "Inform User" step
- exit code 1 (validation failed) -> fix the reported issues and run the gate again
- exit code 2 (network blocked) -> stop and tell the user that human intervention is required

Keep the gate output in your reply as fresh evidence. Do not claim completion without output from this run.

### 6. Inform User

> Execute this step only after the verification gate passes.

> **IMPORTANT**: All TUI command formats listed below must be output in full. Do not show only the format for the current AI agent.

```
Issue #{number} imported.

Task information:
- Task ID: {task-id}
- Title: {title}
- Workflow: {workflow}

Output file:
- Task file: .agents/workspace/active/{task-id}/task.md

Next step - run requirements analysis:
  - Claude Code / OpenCode: /analyze-task {task-id}
  - Gemini CLI: /{{project}}:analyze-task {task-id}
  - Codex CLI: $analyze-task {task-id}
```

## Completion Checklist

- [ ] Created the task file `.agents/workspace/active/{task-id}/task.md`
- [ ] Recorded `issue_number` in task.md
- [ ] Updated `current_step` to requirement-analysis
- [ ] Updated `updated_at` to the current time
- [ ] Appended an Activity Log entry to task.md
- [ ] Informed the user of the next step (must include all TUI command formats; do not filter)
- [ ] **Did not modify any business code**

## STOP

After completing the checklist, **stop immediately**. Do not continue to later steps.

## Notes

1. **Issue validation**: verify that the Issue exists before continuing
2. **Duplicate task**: if this Issue already has a linked task, ask the user before creating a new one
3. **Next step**: after import, run `analyze-task` before `plan-task`

## Error Handling

- Issue not found: output "Issue #{number} not found, please check the issue number"
- Network error: output "Cannot connect to GitHub, please check network"
- Permission error: output "No access to this repository"
