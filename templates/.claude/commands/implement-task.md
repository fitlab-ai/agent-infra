---
name: "implement-task"
description: "Implement task based on technical plan and output implementation report"
usage: "/implement-task <task-id>"
---

# Implement Task Command

## Description

Implement the task based on the technical plan, write code and tests, and output an implementation report.

## CRITICAL: Status Update Requirement

After executing this command, you **must** immediately update task status. See rule 7.

## Execution Flow

### 1. Verify Prerequisites

Check required files:
- `.ai-workspace/active/{task-id}/task.md` - Task file
- `.ai-workspace/active/{task-id}/plan.md` - Technical plan

Note: `{task-id}` format is `TASK-{yyyyMMdd-HHmmss}`, e.g., `TASK-20260205-202013`

If either file is missing, prompt the user to complete the prerequisite step first.

### 2. Read Technical Plan

Carefully read `plan.md` to understand:
- Technical approach and implementation strategy
- Detailed implementation steps
- Files to be created/modified
- Test strategy

### 3. Execute Code Implementation

Follow the `implementation` step in `.agents/workflows/feature-development.yaml`:

**Required tasks**:
- [ ] Implement feature code according to the plan
- [ ] Write comprehensive unit tests
- [ ] Run tests locally to verify functionality
- [ ] Update relevant documentation and comments
- [ ] Follow project coding standards

**Implementation principles**:
1. **Strictly follow the plan**: Do not deviate from the technical plan
2. **Implement step by step**: Execute in the order specified in plan.md
3. **Test frequently**: Run tests after completing each step
4. **Keep it simple**: Do not over-engineer or add extra features

### 4. Run Test Verification

```bash
# Run tests based on project type
mvn test -pl :{module-name}  # Maven project
npm test                      # Node.js project
pytest                        # Python project
```

Ensure all tests pass.

### 5. Output Implementation Report

Create `.ai-workspace/active/{task-id}/implementation.md`, which must include the following sections:

```markdown
# Implementation Report

## Modified File List

### New Files
- `{file-path}` - {Description}

### Modified Files
- `{file-path}` - {Change summary}

## Key Code Explanation

### {Module/Feature Name}
**File**: `{file-path}:{line-number}`

**Implementation Logic**:
{Explanation of important logic}

**Key Code**:
```{language}
{Key code snippet}
```

## Test Results

### Unit Tests
- Test file: `{test-file-path}`
- Test cases: {Count}
- Pass rate: {Percentage}

**Test Output**:
```
{Test run results}
```

### Integration Tests
{If applicable}

## Deviations from Plan

{If implementation differs from the plan, explain the reasons}

## Items for Review

**Points requiring reviewer attention**:
- {Point 1}
- {Point 2}

## Known Issues

{Issues discovered during implementation or items to optimize}

## Suggestions for Next Steps

{Suggestions for code review or future optimization directions}
```

### 6. Update Task Status

Update `.ai-workspace/active/{task-id}/task.md`:
- `current_step`: implementation
- `assigned_to`: {current AI}
- `updated_at`: {current time}
- Mark implementation.md as completed
- Mark code implementation as complete in workflow progress

### 7. Inform User

Output format:
```
Task {task-id} implementation complete

**Implementation Summary**:
- Modified files: {count}
- New files: {count}
- Tests passed: {count}/{total}

**Output Files**:
- Implementation report: .ai-workspace/active/{task-id}/implementation.md

**Next Steps**:
Use the following command for code review:
- Claude Code / OpenCode: `/review-task {task-id}`
- Gemini CLI: `/{project}:review-task {task-id}`
- Codex CLI: `/prompts:{project}-review-task {task-id}`
```

## Completion Checklist

After executing this command, confirm:

- [ ] Completed all code implementation
- [ ] Created implementation report `.ai-workspace/active/{task-id}/implementation.md`
- [ ] Updated `current_step` to implementation in task.md
- [ ] Updated `updated_at` to current time in task.md
- [ ] Updated `assigned_to` to your name in task.md
- [ ] Marked technical-design as complete in workflow progress
- [ ] Marked implementation as in progress in workflow progress
- [ ] Marked implementation.md as completed in task.md
- [ ] Informed user of next step (/review-task)

## Parameters

- `<task-id>`: Task ID, format TASK-{yyyyMMdd-HHmmss} (required)

## Usage Example

```bash
# Implement task
/implement-task TASK-20251227-104654
```

## Notes

1. **Prerequisites**:
   - Must have completed technical plan design (plan.md exists)
   - Plan must have been approved through human review

2. **Implementation Standards**:
   - Strictly follow steps in plan.md
   - Do not add unplanned features
   - Follow project coding standards

3. **Test Requirements**:
   - All new code must have unit tests
   - Test coverage must not fall below existing levels
   - All tests must pass

4. **Code Quality**:
   - Follow project coding standards
   - Add necessary comments
   - Keep code concise

5. **Git Operations**:
   - Do **NOT** automatically execute git commit
   - Wait for code review after implementation is complete
   - Only commit after review is approved

## Related Commands

- `/plan-task <task-id>` - Design technical plan (prerequisite step)
- `/review-task <task-id>` - Code review (next step)
- `/check-task <task-id>` - View task status

## Error Handling

- Task not found: Prompt "Task {task-id} not found"
- Missing technical plan: Prompt "Technical plan not found, please run /plan-task first"
- Test failure: Output test errors, ask whether to continue
- Build failure: Output build errors, stop implementation
