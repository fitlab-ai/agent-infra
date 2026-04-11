---
name: create-task
description: "Create a task from a natural-language description"
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
- **Task title**: a concise title (maximum 50 characters), in the same language as the user's description - do not translate it to English or apply Conventional Commits formatting
- **Task type**: `feature` | `bugfix` | `refactor` | `docs` | `chore` (infer from the description)
- **Workflow**: `feature-development` | `bug-fix` | `refactoring` (infer from the type)
- **Branch name**: format `<project>-<type>-<slug>`
  - `<project>` comes from the `project` field in `.agents/.airc.json`
  - `<type>` is the inferred task type
  - `<slug>` is a kebab-case slug built from 3-6 English keywords extracted from the task title
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

- Create the task directory: `.agents/workspace/active/TASK-{yyyyMMdd-HHmmss}/`
- Use the `.agents/templates/task.md` template to create the task file: `task.md`

**Important**:
- Directory naming: `TASK-{yyyyMMdd-HHmmss}` (**must** include the `TASK-` prefix)
- Example: `TASK-20260306-143022`
- Task ID = directory name

Task metadata (`task.md` YAML front matter):
```yaml
id: TASK-{yyyyMMdd-HHmmss}
type: feature|bugfix|refactor|docs|chore
branch: <project>-<type>-<slug>
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

Update `.agents/workspace/active/{task-id}/task.md`:
- `current_step`: requirement-analysis
- `assigned_to`: {current AI agent}
- `updated_at`: {current time}
- `## Context` -> `- **Branch**:`: update it to the generated branch name
- **Append** to `## Activity Log` (do NOT overwrite previous entries):
  ```
  - {yyyy-MM-dd HH:mm:ss} — **Task Created** by {agent} — Task created from description
  ```

### 4. Verification Gate

Run the verification gate to confirm the task artifact and sync state are valid:

```bash
node .agents/scripts/validate-artifact.js gate create-task .agents/workspace/active/{task-id} --format text
```

Handle the result as follows:
- exit code 0 (all checks passed) -> continue to the "Inform User" step
- exit code 1 (validation failed) -> fix the reported issues and run the gate again
- exit code 2 (network blocked) -> stop and tell the user that human intervention is required

Keep the gate output in your reply as fresh evidence. Do not claim completion without output from this run.

### 5. Inform User

> Execute this step only after the verification gate passes.

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
- Task file: .agents/workspace/active/{task-id}/task.md

Next step - run requirements analysis:
  - Claude Code / OpenCode: /analyze-task {task-id}
  - Gemini CLI: /{{project}}:analyze-task {task-id}
  - Codex CLI: $analyze-task {task-id}

Or create a GitHub Issue first:
  - Claude Code / OpenCode: /create-issue {task-id}
  - Gemini CLI: /{{project}}:create-issue {task-id}
  - Codex CLI: $create-issue {task-id}
```

## Completion Checklist

- [ ] Created the task file `.agents/workspace/active/{task-id}/task.md`
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
3. **Workflow order**: after creating a task, typically run `analyze-task` before `plan-task`; if you need GitHub tracking first, you may run `create-issue` first

## Error Handling

- Empty description: output "Please provide a task description"
- Description too vague: ask clarification questions before creating the task
