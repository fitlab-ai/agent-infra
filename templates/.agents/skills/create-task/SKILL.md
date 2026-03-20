---
name: create-task
description: >
  Create a task skeleton from the user's natural-language description.
  Triggered when the user describes a new feature, bug, or improvement request.
  The only output is task.md; do not write any business code. Argument: task description text.
---

# Create Task

## Boundary / Critical Rules

**The only output of this skill is `task.md`.**

- Do not write, modify, or create any business code or configuration files
- Do not perform requirements analysis; analysis is handled separately by `analyze-task`
- Do not directly implement the requested functionality
- Do not skip the workflow and jump directly to planning or implementation
- Only do this: parse the description -> create the task file -> update task status -> inform the user of the next step

The user's description is a **work item**, not an **instruction to execute immediately**.

After executing this skill, you **must** immediately update task status in task.md.

## Steps

### 1. Parse the User Description

Extract from the natural-language description:
- **Task title**: a concise title (maximum 50 characters)
- **Task type**: `feature` | `bugfix` | `refactor` | `docs` | `chore` (infer from the description)
- **Workflow**: `feature-development` | `bug-fix` | `refactoring` (infer from the type)
- **Detailed description**: the cleaned-up original user request

If the description is unclear, **ask the user to clarify first**.

**Type inference**: choose the best matching type from the following candidates based on the semantics of the task description:

- `feature` - new functionality or capability
- `bugfix` - defect or error fix
- `refactor` - refactoring, optimization, or code improvement
- `docs` - documentation-related work
- `chore` - other miscellaneous work

**Workflow mapping**:
- `feature` / `docs` / `chore` -> `feature-development`
- `bugfix` -> `bug-fix`
- `refactor` -> `refactoring`

### 2. Create the Task Directory and File

Get the current timestamp:

```bash
date +%Y%m%d-%H%M%S
```

- Create the task directory: `.agent-workspace/active/TASK-{yyyyMMdd-HHmmss}/`
- Use the `.agents/templates/task.md` template to create the task file: `task.md`

**Important**:
- Directory naming: `TASK-{yyyyMMdd-HHmmss}` (**must** include the `TASK-` prefix)
- Example: `TASK-20260306-143022`
- Task ID = directory name

Task metadata (`task.md` YAML front matter):
```yaml
id: TASK-{yyyyMMdd-HHmmss}
type: feature|bugfix|refactor|docs|chore
workflow: feature-development|bug-fix|refactoring
status: active
created_at: {yyyy-MM-dd HH:mm:ss}
updated_at: {yyyy-MM-dd HH:mm:ss}
created_by: human
current_step: requirement-analysis
assigned_to: {current AI agent}
```

Note: `created_by` is `human` because the task comes from the user's description.

### 3. Update Task Status

Get the current time:

```bash
date "+%Y-%m-%d %H:%M:%S"
```

Update `.agent-workspace/active/{task-id}/task.md`:
- `current_step`: requirement-analysis
- `assigned_to`: {current AI agent}
- `updated_at`: {current time}
- **Append** to `## Activity Log` (do NOT overwrite previous entries):
  ```
  - {yyyy-MM-dd HH:mm:ss} — **Task Created** by {agent} — Task created from description
  ```

### 4. Inform User

> **IMPORTANT**: All TUI command formats listed below must be output in full. Do not show only the format for the current AI agent.

Output format:
```
Task created.

Task information:
- Task ID: {task-id}
- Title: {title}
- Type: {type}
- Workflow: {workflow}

Output file:
- Task file: .agent-workspace/active/{task-id}/task.md

Next step - run requirements analysis:
  - Claude Code / OpenCode: /analyze-task {task-id}
  - Gemini CLI: /{{project}}:analyze-task {task-id}
  - Codex CLI: $analyze-task {task-id}
```

## Completion Checklist

- [ ] Created the task file `.agent-workspace/active/{task-id}/task.md`
- [ ] Updated `current_step` to requirement-analysis in task.md
- [ ] Updated `updated_at` to the current time in task.md
- [ ] Updated `assigned_to` in task.md
- [ ] Appended an Activity Log entry to task.md
- [ ] Informed the user of the next step (must include all TUI command formats; do not filter)
- [ ] **Did not modify any business code or configuration files** (only task.md)

## STOP

After completing the checklist, **stop immediately**. Do not continue to planning, implementation, or any follow-up step.
Wait for the user to run the `analyze-task` skill.

## Notes

1. **Clarity**: if the user description is vague or missing key information, ask for clarification first
2. **Difference from `import-issue`**: `import-issue` imports from a GitHub Issue; `create-task` creates from a free-form description
3. **Workflow order**: after creating a task, `analyze-task` must run before `plan-task`

## Error Handling

- Empty description: output "Please provide a task description"
- Description too vague: ask clarification questions before creating the task
