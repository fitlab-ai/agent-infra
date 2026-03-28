---
name: plan-task
description: "Design a technical plan for a task"
---

# Design Technical Plan

## Boundary / Critical Rules

- This skill only outputs a technical plan document (`plan.md` or `plan-r{N}.md`) and does not modify any business code
- This is a **mandatory human review checkpoint**; do not automatically proceed to implementation
- After executing this skill, you **must** immediately update task status in task.md

## Steps

### 1. Verify Prerequisites

Check required files:
- `.agents/workspace/active/{task-id}/task.md` - Task file
- At least one analysis artifact: `analysis.md` or `analysis-r{N}.md`

Note: `{task-id}` format is `TASK-{yyyyMMdd-HHmmss}`, for example `TASK-20260306-143022`

If any required file is missing, prompt the user to complete the prerequisite step first.

### 2. Determine the Plan Round

Scan `.agents/workspace/active/{task-id}/` for plan artifact files:
- If neither `plan.md` nor `plan-r*.md` exists -> this is Round 1 and must create `plan.md`
- If `plan.md` exists and no `plan-r*.md` exists -> this is Round 2 and must create `plan-r2.md`
- If `plan-r{N}.md` exists -> this is Round N+1 and must create `plan-r{N+1}.md`

Record:
- `{plan-round}`: the current plan round
- `{plan-artifact}`: the artifact filename for this round

### 3. Read Requirements Analysis

Scan the task directory for analysis artifact files (`analysis.md`, `analysis-r{N}.md`):
- If any `analysis-r{N}.md` exists, read the highest N file
- otherwise read `analysis.md`
Use it to understand:
- the requirements and background
- related files and code structure
- impact scope and dependencies
- identified technical risks
- effort and complexity assessment

### 4. Understand the Problem

- Read the relevant source files identified in the analysis
- Understand the current architecture and patterns
- Identify constraints (backward compatibility, performance, etc.)
- Consider edge cases and failure scenarios

### 5. Design the Technical Plan

Follow the `technical-design` step in `.agents/workflows/feature-development.yaml`:

**Required tasks**:
- [ ] Define the technical approach and rationale
- [ ] Consider alternatives and explain the tradeoffs
- [ ] List implementation steps in detailed order
- [ ] List all files that need to be created or modified
- [ ] Define the verification strategy (tests, manual checks)
- [ ] Assess impact and risks

**Design principles**:
1. **Simplicity**: prefer the simplest approach that satisfies the requirement
2. **Consistency**: follow existing code patterns and conventions
3. **Testability**: design for straightforward testing
4. **Reversibility**: prefer changes that are easy to roll back

### 6. Output Plan Document

Create `.agents/workspace/active/{task-id}/{plan-artifact}`.

### 7. Update Task Status

Get the current time:

```bash
date "+%Y-%m-%d %H:%M:%S"
```

Update `.agents/workspace/active/{task-id}/task.md`:
- `current_step`: technical-design
- `assigned_to`: {current AI agent}
- `updated_at`: {current time}
- Record the plan artifact for this round: `{plan-artifact}` (Round `{plan-round}`)
- If the task template contains a `## Design` section, update it to link to `{plan-artifact}`
- Mark technical-design as complete in workflow progress and include the actual round when the task template supports it
- **Append** to `## Activity Log` (do NOT overwrite previous entries):
  ```
  - {yyyy-MM-dd HH:mm:ss} — **Technical Design (Round {N})** by {agent} — Plan completed, awaiting human review → {artifact-filename}
  ```

If task.md contains a valid `issue_number`, perform these sync actions (skip and continue on any failure):
- Read `.agents/rules/issue-sync.md` before syncing
- Set `status: pending-design-work`
- Publish the `{plan-artifact}` comment

### 8. Inform User

> **IMPORTANT**: All TUI command formats listed below must be output in full. Do not show only the format for the current AI agent.

Output format:
```
Technical plan complete for task {task-id}.

Plan summary:
- Round: Round {plan-round}
- Approach: {brief description}
- Files to modify: {count}
- Files to create: {count}
- Estimated complexity: {assessment}

Output file:
- Technical plan: .agents/workspace/active/{task-id}/{plan-artifact}

Important: human review checkpoint.
Please review the technical plan before continuing to implementation.

Next step - implement the task:
  - Claude Code / OpenCode: /implement-task {task-id}
  - Gemini CLI: /{{project}}:implement-task {task-id}
  - Codex CLI: $implement-task {task-id}
```

## Output Template

```markdown
# Technical Plan

- **Plan round**: Round {plan-round}
- **Artifact file**: `{plan-artifact}`

## Problem Understanding
{Summarize the problem to solve and the key constraints}

## Constraints
- {Constraint 1}
- {Constraint 2}

## Option Comparison

### Option A: {Name}
- **Approach**: {Description}
- **Pros**: {Advantages}
- **Cons**: {Drawbacks}

### Option B: {Name}
- **Approach**: {Description}
- **Pros**: {Advantages}
- **Cons**: {Drawbacks}

### Decision
{Which option was chosen and why}

## Technical Approach
{Detailed description of the selected approach}

## Implementation Steps

### Step 1: {Title}
- **File**: `{file-path}`
- **Action**: {What to do}
- **Details**: {Specific details}

### Step 2: {Title}
...

## File List

### New Files
- `{file-path}` - {Purpose}

### Modified Files
- `{file-path}` - {Planned changes}

## Verification Strategy

### Unit Tests
- {Test case 1}
- {Test case 2}

### Manual Validation
- {Validation step}

## Impact Assessment
- Breaking change: {Yes/No - details}
- Performance impact: {Assessment}
- Security considerations: {Assessment}

## Risk Control
- {Risk 1}: {Mitigation}
- {Risk 2}: {Mitigation}
```

## Completion Checklist

- [ ] Read and understood the requirements analysis
- [ ] Considered alternative options
- [ ] Created the plan document `.agents/workspace/active/{task-id}/{plan-artifact}`
- [ ] Updated `current_step` to technical-design in task.md
- [ ] Updated `updated_at` to the current time in task.md
- [ ] Recorded `{plan-artifact}` as a completed artifact in task.md
- [ ] Marked technical-design as complete in workflow progress
- [ ] Appended an Activity Log entry to task.md
- [ ] Informed the user that this is a human review checkpoint
- [ ] Informed the user of the next step (must include all TUI command formats; do not filter)

## STOP

After completing the checklist, **stop immediately**.
This is a **mandatory human review checkpoint**; the user must review and approve the plan before implementation can continue.

## Notes

1. **Prerequisite**: at least one round of requirements analysis must already be complete (`analysis.md` or `analysis-r{N}.md` exists)
2. **Human review**: this is a mandatory checkpoint; do not automatically proceed to implementation
3. **Plan quality**: the plan should be detailed enough that another AI agent can implement it without extra context
4. **Versioning rule**: the first plan uses `plan.md`; later revisions use `plan-r{N}.md`

## Error Handling

- Task not found: output "Task {task-id} not found, please check the task ID"
- Analysis missing: output "Analysis not found, please run the analyze-task skill first"
