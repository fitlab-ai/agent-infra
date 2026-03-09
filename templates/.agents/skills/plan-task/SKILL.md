---
name: plan-task
description: >
  Design a technical solution for a task and output a detailed implementation
  plan. Triggered when the user requests a design or technical plan for a task
  that has completed requirement analysis. This is a mandatory human review
  checkpoint. Argument: task-id.
---

# Design Technical Solution

## Boundary / Critical Rules

- This skill produces `plan.md` only -- no business code changes
- This is a **mandatory human review checkpoint** -- do not auto-proceed to implementation
- After executing this skill, you **must** immediately update task status in task.md

## Steps

### 1. Verify Prerequisites

Check required files:
- `.ai-workspace/active/{task-id}/task.md` - Task file
- `.ai-workspace/active/{task-id}/analysis.md` - Requirement analysis

Note: `{task-id}` format is `TASK-{yyyyMMdd-HHmmss}`, e.g. `TASK-20260306-143022`

If either file is missing, prompt the user to complete the prerequisite step first.

### 2. Read Requirement Analysis

Carefully read `analysis.md` to understand:
- The requirement and its context
- Related files and code structure
- Impact scope and dependencies
- Technical risks identified
- Effort and complexity assessment

### 3. Understand the Problem

- Read relevant source code files identified in the analysis
- Understand the current architecture and patterns
- Identify constraints (backward compatibility, performance, etc.)
- Consider edge cases and error scenarios

### 4. Design Technical Solution

Follow the `technical-design` step in `.agents/workflows/feature-development.yaml`:

**Required tasks**:
- [ ] Define the technical approach and rationale
- [ ] Consider alternative solutions and explain trade-offs
- [ ] Detail implementation steps in order
- [ ] List all files to create/modify
- [ ] Define verification strategy (tests, manual checks)
- [ ] Assess impact and risks of the solution

**Design principles**:
1. **Simplicity**: Prefer the simplest solution that meets requirements
2. **Consistency**: Follow existing code patterns and conventions
3. **Testability**: Design for easy testing
4. **Reversibility**: Prefer changes that are easy to revert

### 5. Output Plan Document

Create `.ai-workspace/active/{task-id}/plan.md`.

### 6. Update Task Status

Update `.ai-workspace/active/{task-id}/task.md`:
- `current_step`: technical-design
- `assigned_to`: {current AI agent}
- `updated_at`: {current time}
- Mark plan.md as completed
- Mark technical-design as complete in workflow progress

### 7. Inform User

Output format:
```
Technical plan complete for task {task-id}.

Plan summary:
- Approach: {brief description}
- Files to modify: {count}
- Files to create: {count}
- Estimated complexity: {assessment}

Output file:
- Technical plan: .ai-workspace/active/{task-id}/plan.md

IMPORTANT: Human review checkpoint.
Please review the technical plan before proceeding to implementation.

Next step:
  execute the implement-task skill with {task-id}
```

## Output Template

```markdown
# Technical Plan

## Problem Understanding
{Summarize the problem to solve and key constraints}

## Constraints
- {Constraint 1}
- {Constraint 2}

## Solution Alternatives

### Option A: {Name}
- **Approach**: {Description}
- **Pros**: {Advantages}
- **Cons**: {Disadvantages}

### Option B: {Name}
- **Approach**: {Description}
- **Pros**: {Advantages}
- **Cons**: {Disadvantages}

### Decision
{Which option and why}

## Technical Approach
{Detailed description of the chosen solution}

## Implementation Steps

### Step 1: {Title}
- **File**: `{file-path}`
- **Action**: {What to do}
- **Details**: {Specifics}

### Step 2: {Title}
...

## File Manifest

### New Files
- `{file-path}` - {Purpose}

### Modified Files
- `{file-path}` - {What changes}

## Verification Strategy

### Unit Tests
- {Test case 1}
- {Test case 2}

### Manual Verification
- {Verification step}

## Impact Assessment
- Breaking changes: {Yes/No - details}
- Performance impact: {Assessment}
- Security considerations: {Assessment}

## Risk Control
- {Risk 1}: {Mitigation}
- {Risk 2}: {Mitigation}
```

## Completion Checklist

- [ ] Read and understood requirement analysis
- [ ] Considered alternative solutions
- [ ] Created plan document `.ai-workspace/active/{task-id}/plan.md`
- [ ] Updated `current_step` to technical-design in task.md
- [ ] Updated `updated_at` to current time in task.md
- [ ] Marked plan.md as completed in task.md
- [ ] Marked technical-design as complete in workflow progress
- [ ] Informed user this is a human review checkpoint
- [ ] Informed user of next step (implement-task)

## STOP

After completing the checklist, **stop immediately**.
This is a **mandatory human review checkpoint** -- the user must review and approve the plan before implementation can proceed.

## Notes

1. **Prerequisites**: Must have completed requirement analysis (analysis.md exists)
2. **Human review**: This is a mandatory checkpoint -- do not auto-proceed to implementation
3. **Plan quality**: The plan should be specific enough that another AI agent could implement it without additional context

## Error Handling

- Task not found: Prompt "Task {task-id} not found, please check the task ID"
- Missing analysis: Prompt "Analysis not found, please run the create-task or analyze-issue skill first"
