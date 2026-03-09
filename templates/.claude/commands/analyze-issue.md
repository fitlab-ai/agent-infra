---
name: "analyze-issue"
description: "Analyze GitHub Issue and create requirement analysis document"
usage: "/analyze-issue <issue-number>"
---

# Analyze Issue Command

## Description

Analyze the specified GitHub Issue, create a task, and output a requirement analysis document.

## CRITICAL: Status Update Requirement

After executing this command, you **must** immediately update task status. See rule 7.

## Execution Flow

### 1. Fetch Issue Information

```bash
gh issue view <issue-number> --json number,title,body,labels
```

### 2. Create Task Directory and File

Check if a task already exists for this Issue:
- Search for related tasks in `.ai-workspace/active/`
- If found, ask whether to re-analyze
- If not found, create task directory: `.ai-workspace/active/TASK-{yyyyMMdd-HHmmss}/`
- Create task file using `.agents/templates/task.md` template: `task.md`

### 3. Perform Requirement Analysis

Follow the `requirement-analysis` step in `.agents/workflows/feature-development.yaml`:

**Required tasks**:
- [ ] Read and understand the Issue description
- [ ] Search for related code files (using Glob/Grep tools)
- [ ] Analyze code structure and impact scope
- [ ] Identify potential technical risks and dependencies
- [ ] Assess effort and complexity

### 4. Output Analysis Document

Create `.ai-workspace/active/{task-id}/analysis.md`, which must include the following sections:

```markdown
# Requirement Analysis Report

## Requirement Understanding
{Restate the requirement in your own words to confirm understanding}

## Related Files
- `{file-path}:{line-number}` - {description}

## Impact Scope Assessment
**Direct Impact**:
- {Affected modules and files}

**Indirect Impact**:
- {Other parts potentially affected}

## Technical Risks
- {Risk description and mitigation ideas}

## Dependencies
- {Required dependencies and coordination with other modules}

## Effort and Complexity Assessment
- Complexity: {High/Medium/Low}
- Effort: {Estimated time}
- Risk Level: {High/Medium/Low}
```

### 5. Update Task Status

Update `.ai-workspace/active/{task-id}/task.md`:
- `current_step`: requirement-analysis
- `assigned_to`: claude
- `updated_at`: {current time}
- Mark analysis.md as completed

### 6. Inform User

Output format:
```
Issue #{number} analysis complete

**Task Information**:
- Task ID: {task-id}
- Task Title: {title}
- Workflow: feature-development

**Output Files**:
- Task file: .ai-workspace/active/{task-id}/task.md
- Analysis document: .ai-workspace/active/{task-id}/analysis.md

**Next Steps**:
After reviewing the requirement analysis, design a technical plan:
- Claude Code / OpenCode: `/plan-task {task-id}`
- Gemini CLI: `/{project}:plan-task {task-id}`
- Codex CLI: `/prompts:{project}-plan-task {task-id}`
```

## Completion Checklist

After executing this command, confirm:

- [ ] Created task file `.ai-workspace/active/{task-id}/task.md`
- [ ] Created analysis document `.ai-workspace/active/{task-id}/analysis.md`
- [ ] Updated `current_step` to requirement-analysis in task.md
- [ ] Updated `updated_at` to current time in task.md
- [ ] Updated `assigned_to` to your name in task.md
- [ ] Marked requirement-analysis as complete in workflow progress
- [ ] Informed user of next step (/plan-task)
- [ ] If linked to an Issue, recorded Issue number in task.md

## Parameters

- `<issue-number>`: GitHub Issue number (required)

## Usage Example

```bash
# Analyze Issue #207
/analyze-issue 207
```

## Notes

1. **Issue Validation**:
   - Check if the Issue exists before execution
   - If the Issue does not exist, prompt the user

2. **Task Conflict**:
   - If a related task already exists, ask the user:
     - Re-analyze (overwrite existing analysis.md)
     - Continue using existing analysis

3. **Workflow Compliance**:
   - Strictly follow `.agents/workflows/feature-development.yaml` definitions
   - Output files must meet workflow requirements

4. **Human Review Checkpoint**:
   - Suggest human review after analysis is complete
   - Confirm requirement understanding is correct before proceeding to next step

## Related Commands

- `/plan-task <task-id>` - Design technical plan
- `/check-task <task-id>` - View task status

## Error Handling

- Issue not found: Prompt "Issue #{number} does not exist, please check the Issue number"
- Network error: Prompt "Unable to connect to GitHub, please check network connection"
- Permission error: Prompt "No access to this repository"
