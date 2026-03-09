---
name: "plan-task"
description: "Design technical solution and output implementation plan"
usage: "/plan-task <task-id>"
---

# Plan Task Command

## Description

Design a technical solution for the specified task and output a detailed implementation plan.

## CRITICAL: Status Update Requirement

After executing this command, you **must** immediately update task status. See rule 7.

## Execution Flow

### 1. Find Task File

Search for the task in the following priority order:
- Check `.ai-workspace/active/{task-id}/task.md` (primary)
- If not found, check `.ai-workspace/blocked/{task-id}/task.md`
- If not found, check `.ai-workspace/completed/{task-id}/task.md`
- If none found, prompt that the task does not exist

Once found, record the task status and task directory path.

Note: `{task-id}` format is `TASK-{yyyyMMdd-HHmmss}`, e.g., `TASK-20260205-202013`

### 2. Read Requirement Analysis

Read `.ai-workspace/{status}/{task-id}/analysis.md`:
- If not found, prompt the user to perform requirement analysis first
- If found, read and understand the requirements

### 3. Understand Problem and Constraints

- [ ] Read analysis.md to understand the root cause and impact scope
- [ ] Identify technical constraints (from the "Technical Dependencies and Constraints" section of analysis.md)
- [ ] Identify special requirements (e.g., security fixes need to consider patched versions, bug fixes need to prevent regressions, feature development needs to consider extensibility)

### 4. Design Solution

Follow the `technical-design` step in the corresponding workflow (e.g., `.agents/workflows/feature-development.yaml`):

- [ ] Based on information in analysis.md, propose multiple feasible solutions
- [ ] Compare pros and cons of each solution (effectiveness, cost, risk, maintainability)
- [ ] Select the most suitable solution and explain the reasoning
- [ ] Create detailed implementation steps
- [ ] List files to be created/modified
- [ ] Design verification strategy (tests, validation, regression checks)
- [ ] Assess impact (performance, security, compatibility)
- [ ] Create risk control and rollback plan

### 5. Output Plan Document

Create `.ai-workspace/{status}/{task-id}/plan.md`, which must include the following sections:

```markdown
# Technical Plan and Implementation

## Decision

### Problem Understanding
{Problem understanding and root cause based on analysis.md}

### Constraints
- Technical constraints: {Technical dependencies and limitations}
- Business constraints: {Business requirements and limitations}
- Time constraints: {Delivery timeline requirements}

### Alternative Solution Comparison
{If multiple solutions exist, detailed comparison of pros and cons}

### Final Selection
- **Solution**: {Selected solution}
- **Reasoning**: {Selection reasoning}

## Technical Approach

### Core Strategy
{Detailed solution strategy}

### Key Technical Points
- {Technical point 1}
- {Technical point 2}

### Implementation Details
{Specific implementation based on problem type, e.g., code changes, dependency upgrades, configuration adjustments}

## Implementation Steps

### Step 1: {Step name}
**Action**: {Specific action}
**Expected Result**: {Expected result}

### Step 2: {Step name}
...

## File Manifest

### Files to Create
- `{file-path}` - {Description}

### Files to Modify
| # | File Path | Changes | Est. Lines |
|---|-----------|---------|------------|
| 1 | {path} | {Changes} | {Lines} |

## Verification Strategy

### Functional Verification
- Unit tests: {Test scope and acceptance criteria}
- Integration tests: {Test scope and acceptance criteria}

### Problem Verification
{Confirm the problem is resolved, e.g., feature works, bug no longer reproduces, vulnerability is fixed}

### Regression Verification
{Ensure no new issues are introduced}

## Impact Assessment

### Performance Impact
{Performance impact analysis and optimization suggestions}

### Security Impact
{Security risk assessment and protective measures}

### Compatibility Impact
{Compatibility analysis and considerations}

## Risk Control

### Potential Risks
| Risk | Level | Mitigation |
|------|-------|------------|
| {Risk} | {Level} | {Mitigation} |

### Rollback Plan
{How to rollback if implementation fails}

## Expected Deliverables
- {Deliverable 1}
- {Deliverable 2}
```

### 6. Update Task Status

Update `.ai-workspace/active/{task-id}/task.md`:
- `current_step`: technical-design
- `assigned_to`: claude
- `updated_at`: {current time}
- Mark plan.md as completed
- Mark technical-design as complete in workflow progress

### 7. Inform User

Output format:
```
Technical plan complete for task {task-id}

**Plan Summary**:
- Final solution: {Solution name}
- Effort estimate: {Estimate}
- Risk level: {Level}

**Output Files**:
- Plan document: .ai-workspace/active/{task-id}/plan.md

**Next Steps**:
IMPORTANT: Human review checkpoint - please review the technical plan

After review approval, start implementation:
- Claude Code / OpenCode: `/implement-task {task-id}`
- Gemini CLI: `/{project}:implement-task {task-id}`
- Codex CLI: `/prompts:{project}-implement-task {task-id}`
```

## Completion Checklist

After executing this command, confirm:

- [ ] Created plan document `.ai-workspace/active/{task-id}/plan.md`
- [ ] Updated `current_step` to technical-design in task.md
- [ ] Updated `updated_at` to current time in task.md
- [ ] Updated `assigned_to` to your name in task.md
- [ ] Marked requirement-analysis as complete in workflow progress
- [ ] Marked technical-design as in progress in workflow progress
- [ ] Marked plan.md as completed in task.md
- [ ] Informed user this is a human review checkpoint requiring review before continuing

## Parameters

- `<task-id>`: Task ID, format TASK-{yyyyMMdd-HHmmss} (required)

## Usage Example

```bash
# Design technical solution for task
/plan-task TASK-20251227-104654
```

## Notes

1. **Prerequisites**:
   - Must have completed requirement analysis (analysis.md exists)
   - If not, prompt user to run `/analyze-issue`, `/analyze-dependabot`, or `/analyze-codescan`

2. **Human Review Checkpoint**:
   - This is a **mandatory** human review checkpoint
   - Wait for human review after plan design is complete
   - Implementation can only proceed after review is approved

3. **Plan Quality**:
   - Think thoroughly, do not rush to implementation
   - Consider and compare multiple solutions
   - List implementation steps in detail

4. **Document Completeness**:
   - Ensure all required sections are included
   - Implementation steps should be detailed and actionable
   - Test strategy should be specific and clear

## Related Commands

**Prerequisite Steps**:
- `/analyze-issue <number>` - Analyze GitHub Issue
- `/analyze-dependabot <alert-number>` - Analyze Dependabot dependency vulnerability alert
- `/analyze-codescan <alert-number>` - Analyze Code Scanning alert

**Next Steps**:
- `/implement-task <task-id>` - Implement task
- `/check-task <task-id>` - View task status

## Error Handling

- Task not found: Prompt "Task {task-id} not found, please check the task ID"
- Missing analysis: Prompt "Analysis document not found, please run /analyze-issue, /analyze-dependabot, or /analyze-codescan first"
- plan.md already exists: Ask whether to overwrite or create a new version
