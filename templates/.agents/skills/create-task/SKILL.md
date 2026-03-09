---
name: create-task
description: >
  Create a task from a natural language description and perform requirement
  analysis. Triggered when the user describes a new feature, bug, or
  improvement they want to work on. The only outputs are task.md and
  analysis.md -- no business code is written. Argument: task description text.
---

# Create Task

## Boundary / Critical Rules

**This skill's only output is `task.md` and `analysis.md`.**

- Do NOT write, modify, or create any business code or configuration files
- Do NOT directly implement the described feature
- Do NOT skip the workflow to jump into plan/implement phases
- Only: Parse description -> Create task file -> Requirement analysis -> Output analysis document -> Inform user of next step

The user's description is a **to-do item**, not an **immediate execution instruction**.

After executing this skill, you **must** immediately update task status in task.md.

## Steps

### 1. Parse User Description

Extract from the natural language description:
- **Task title**: Concise title (max 50 characters)
- **Task type**: `feature` | `bugfix` | `refactor` | `docs` | `chore` (inferred from description)
- **Workflow**: `feature-development` | `bug-fix` | `refactoring` (inferred from type)
- **Detailed description**: Cleaned-up version of user's original description

If the description is unclear, **ask the user for clarification** before proceeding.

**Type inference rules**:
- Contains "add", "new", "support", "implement" -> `feature`
- Contains "fix", "resolve", "bug", "error" -> `bugfix`
- Contains "refactor", "optimize", "improve", "clean up" -> `refactor`
- Contains "document", "javadoc", "comment", "readme" -> `docs`
- Other -> `chore`

**Workflow mapping**:
- `feature` / `docs` / `chore` -> `feature-development`
- `bugfix` -> `bug-fix`
- `refactor` -> `refactoring`

### 2. Create Task Directory and File

Get the current timestamp:

```bash
date +%Y%m%d-%H%M%S
```

- Create task directory: `.ai-workspace/active/TASK-{yyyyMMdd-HHmmss}/`
- Use `.agents/templates/task.md` template to create task file: `task.md`

**Important**:
- Directory naming: `TASK-{yyyyMMdd-HHmmss}` (**must** include `TASK-` prefix)
- Example: `TASK-20260306-143022`
- Task ID = directory name

Task metadata (in task.md YAML front matter):
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

Note: `created_by` is `human` since the task originates from the user's description.

### 3. Execute Requirement Analysis

Follow the `requirement-analysis` step in `.agents/workflows/feature-development.yaml`:

**Required tasks** (analysis only, do NOT write any business code):
- [ ] Understand the user's described requirement
- [ ] Search related code files (**read-only**)
- [ ] Analyze code structure and impact scope
- [ ] Identify potential technical risks and dependencies
- [ ] Assess effort and complexity

### 4. Output Analysis Document

Create `.ai-workspace/active/{task-id}/analysis.md` with these sections:

## Output Template

```markdown
# Requirement Analysis Report

## Requirement Source

**Source type**: User natural language description
**Original description**:
> {user's original description}

## Requirement Understanding
{Rephrase the requirement in your own words to confirm understanding}

## Related Files
- `{file-path}:{line-number}` - {description}

## Impact Assessment
**Direct impact**:
- {Affected modules and files}

**Indirect impact**:
- {Other parts that may be affected}

## Technical Risks
- {Risk description and mitigation ideas}

## Dependencies
- {Required dependencies and coordination with other modules}

## Effort and Complexity Assessment
- Complexity: {High/Medium/Low}
- Risk level: {High/Medium/Low}
```

### 5. Update Task Status

Update `.ai-workspace/active/{task-id}/task.md`:
- `current_step`: requirement-analysis
- `assigned_to`: {current AI agent}
- `updated_at`: {current time}
- Mark analysis.md as completed
- Mark requirement-analysis as complete in workflow progress

### 6. Inform User

Output format:
```
Task created and analysis complete.

Task info:
- Task ID: {task-id}
- Title: {title}
- Type: {type}
- Workflow: {workflow}

Output files:
- Task file: .ai-workspace/active/{task-id}/task.md
- Analysis: .ai-workspace/active/{task-id}/analysis.md

Next step - review the analysis, then design the technical plan:
  execute the plan-task skill with {task-id}
```

## Completion Checklist

- [ ] Created task file `.ai-workspace/active/{task-id}/task.md`
- [ ] Created analysis document `.ai-workspace/active/{task-id}/analysis.md`
- [ ] Updated `current_step` to requirement-analysis in task.md
- [ ] Updated `updated_at` to current time in task.md
- [ ] Updated `assigned_to` in task.md
- [ ] Marked requirement-analysis as complete in workflow progress
- [ ] Informed user of next step (plan-task)
- [ ] **Did NOT modify any business code or config files** (only task.md and analysis.md)

## STOP

After completing the checklist, **stop immediately**. Do not continue to plan, implement, or any subsequent steps.
Wait for the user to review the analysis and manually invoke the `plan-task` skill.

## Notes

1. **Clarity**: If the user description is vague or missing key information, ask for clarification first
2. **Difference from analyze-issue**: `analyze-issue` creates tasks from GitHub Issues; `create-task` creates from free-form descriptions
3. **Human checkpoint**: Analysis completion is a recommended review point before proceeding

## Error Handling

- Empty description: Prompt "Please provide a task description"
- Overly vague description: Ask clarifying questions before creating the task
