---
name: implement-task
description: >
  Implement a task based on the technical plan, write code and tests, and
  output an implementation report. Triggered when the user requests task
  implementation or coding after the technical plan has been reviewed and
  approved. Argument: task-id.
---

# Implement Task

## Boundary / Critical Rules

- Strictly follow `plan.md` -- do not deviate without documenting the reason
- Do NOT auto-commit. Never execute `git commit` or `git add` automatically
- After executing this skill, you **must** immediately update task status in task.md

## Steps

### 1. Verify Prerequisites

Check required files:
- `.ai-workspace/active/{task-id}/task.md` - Task file
- `.ai-workspace/active/{task-id}/plan.md` - Technical plan

Note: `{task-id}` format is `TASK-{yyyyMMdd-HHmmss}`, e.g. `TASK-20260306-143022`

If either file is missing, prompt the user to complete the prerequisite step first.

### 2. Read Technical Plan

Carefully read `plan.md` to understand:
- Technical approach and solution strategy
- Detailed implementation steps
- Files to create/modify
- Test strategy
- Any constraints or risks

### 3. Execute Code Implementation

Follow the `implementation` step in `.agents/workflows/feature-development.yaml`:

**Required tasks**:
- [ ] Implement functionality code following the plan
- [ ] Write comprehensive unit tests
- [ ] Run tests locally to verify functionality
- [ ] Update related documentation and comments
- [ ] Follow project coding standards (see project instructions)

**Implementation principles**:
1. **Strictly follow the plan**: Do not deviate from the technical plan
2. **Step by step**: Execute plan steps in order
3. **Test continuously**: Run tests after completing each step
4. **Keep it simple**: Do not over-engineer or add unplanned features

### 4. Run Test Verification

Execute the project's test command. Reference the `test` skill for the project-specific test command:

```bash
# Check .agents/skills/test/SKILL.md for the project's test command
# Common patterns:
# npm test          (Node.js)
# mvn test          (Maven)
# pytest            (Python)
# go test ./...     (Go)
```

Ensure all tests pass. If tests fail, fix the issues before proceeding.

### 5. Output Implementation Report

Create `.ai-workspace/active/{task-id}/implementation.md`.

### 6. Update Task Status

Update `.ai-workspace/active/{task-id}/task.md`:
- `current_step`: implementation
- `assigned_to`: {current AI agent}
- `updated_at`: {current time}
- Mark implementation.md as completed
- Mark implementation as complete in workflow progress

### 7. Inform User

Output format:
```
Implementation complete for task {task-id}.

Summary:
- Modified files: {count}
- New files: {count}
- Tests passed: {count}/{total}

Output file:
- Implementation report: .ai-workspace/active/{task-id}/implementation.md

Next step - code review:
  execute the review-task skill with {task-id}
```

## Output Template

```markdown
# Implementation Report

## Modified Files

### New Files
- `{file-path}` - {Description}

### Modified Files
- `{file-path}` - {Summary of changes}

## Key Code Explanation

### {Module/Feature Name}
**File**: `{file-path}:{line-number}`

**Implementation logic**:
{Explanation of important logic}

**Key code**:
```{language}
{Key code snippet}
```

## Test Results

### Unit Tests
- Test file: `{test-file-path}`
- Test cases: {count}
- Pass rate: {percentage}

**Test output**:
```
{Test run results}
```

## Differences from Plan

{If implementation differs from plan, explain why}

## Items for Review

**Points that need reviewer attention**:
- {Attention point 1}
- {Attention point 2}

## Known Issues

{Issues discovered during implementation or items to optimize later}

## Next Steps

{Suggestions for code review or follow-up work}
```

## Completion Checklist

- [ ] Completed all code implementation
- [ ] Created implementation report `.ai-workspace/active/{task-id}/implementation.md`
- [ ] All tests pass
- [ ] Updated `current_step` to implementation in task.md
- [ ] Updated `updated_at` to current time in task.md
- [ ] Updated `assigned_to` in task.md
- [ ] Marked implementation as complete in workflow progress
- [ ] Informed user of next step (review-task)

## STOP

After completing the checklist, **stop**. Do not auto-commit. Wait for code review before submission.

## Notes

1. **Prerequisites**: Must have a reviewed technical plan (plan.md exists and approved)
2. **No auto-commit**: Do NOT execute `git commit` or `git add` automatically. Remind the user to commit manually
3. **Test requirement**: All new code must have unit tests; test coverage must not decrease
4. **Code quality**: Follow project coding standards
5. **Plan deviation**: If you need to deviate from the plan, document the reason in the implementation report

## Error Handling

- Task not found: Prompt "Task {task-id} not found"
- Missing plan: Prompt "Technical plan not found, please run the plan-task skill first"
- Test failure: Output test errors, ask user whether to continue
- Build failure: Output build errors, stop implementation
