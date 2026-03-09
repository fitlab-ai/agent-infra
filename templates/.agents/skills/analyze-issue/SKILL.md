---
name: analyze-issue
description: >
  Analyze a GitHub Issue and create a task file with requirement
  analysis document. Triggered when the user requests Issue analysis.
  Argument: issue number.
---

# Analyze Issue

Analyze the specified GitHub Issue and create a task with requirement analysis. Argument: issue number.

## CRITICAL: Behavior Boundary

**This skill's only output is `task.md` and `analysis.md`.**
Do NOT write or modify business code. Analysis only.

## CRITICAL: Status Update Requirement

After executing this skill, you **must** immediately update task status.

## Execution Flow

### 1. Fetch Issue Information

```bash
gh issue view <issue-number> --json number,title,body,labels
```

Extract: issue number, title, description, labels.

### 2. Check for Existing Task

Search `.ai-workspace/active/` for a task already linked to this issue.
- If found, ask user whether to re-analyze or continue with existing analysis
- If not found, create a new task

### 3. Create Task Directory and File

```bash
date +%Y%m%d-%H%M%S
```

- Create directory: `.ai-workspace/active/TASK-{yyyyMMdd-HHmmss}/`
- Use `.agents/templates/task.md` template to create `task.md`

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
assigned_to: ai
```

### 4. Execute Requirement Analysis

Follow the `requirement-analysis` step in `.agents/workflows/feature-development.yaml`:

**Required tasks** (read-only, no business code):
- [ ] Read and understand the Issue description
- [ ] Search related code files
- [ ] Analyze code structure and impact scope
- [ ] Identify potential technical risks and dependencies
- [ ] Assess effort and complexity

### 5. Output Analysis Document

Create `.ai-workspace/active/{task-id}/analysis.md`:

```markdown
# Requirement Analysis Report

## Requirement Understanding
{Rephrase the Issue requirement in your own words}

## Related Files
- `{file-path}:{line-number}` - {Description}

## Impact Assessment

**Direct impact**:
- {Affected modules and files}

**Indirect impact**:
- {Other parts that may be affected}

## Technical Risks
- {Risk description and mitigation ideas}

## Dependencies
- {Required dependencies and coordination}

## Effort and Complexity Assessment
- Complexity: {High/Medium/Low}
- Effort: {Estimated time}
- Risk level: {High/Medium/Low}
```

### 6. Update Task Status

Update `.ai-workspace/active/{task-id}/task.md`:
- `current_step`: requirement-analysis
- `assigned_to`: ai
- `updated_at`: {current time}
- Mark analysis.md as completed
- Mark requirement-analysis as complete in workflow progress

### 7. Inform User

```
Issue #{number} analysis complete.

Task info:
- Task ID: {task-id}
- Title: {title}
- Workflow: {workflow}

Output files:
- Task file: .ai-workspace/active/{task-id}/task.md
- Analysis: .ai-workspace/active/{task-id}/analysis.md

Next step - review analysis, then execute the plan-task skill with {task-id}.
```

## Completion Checklist

- [ ] Created task file `.ai-workspace/active/{task-id}/task.md`
- [ ] Created analysis document `.ai-workspace/active/{task-id}/analysis.md`
- [ ] Recorded issue_number in task.md
- [ ] Updated `current_step` to requirement-analysis
- [ ] Updated `updated_at` to current time
- [ ] Marked requirement-analysis as complete in workflow progress
- [ ] Informed user of next step (plan-task skill)
- [ ] **Did NOT modify any business code**

## STOP

After completing the checklist, **stop immediately**. Do not continue to subsequent steps.

## Notes

1. **Issue validation**: Check that the Issue exists before proceeding
2. **Duplicate tasks**: If a task for this Issue already exists, ask user before creating another
3. **Human checkpoint**: Analysis completion is a recommended review point

## Error Handling

- Issue not found: Prompt "Issue #{number} not found, please check the issue number"
- Network error: Prompt "Cannot connect to GitHub, please check network"
- Permission error: Prompt "No access to this repository"
