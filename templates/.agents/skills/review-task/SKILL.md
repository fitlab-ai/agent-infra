---
name: review-task
description: >
  Review task implementation code and output a code review report with
  findings categorized by severity (Blocker / Major / Minor). Triggered
  when the user requests code review after implementation is complete.
  Argument: task-id.
---

# Code Review

## Boundary / Critical Rules

- This skill only reads code and produces `review.md` -- it does not modify business code
- After executing this skill, you **must** immediately update task status in task.md

## Steps

### 1. Verify Prerequisites

Check required files:
- `.ai-workspace/active/{task-id}/task.md` - Task file
- `.ai-workspace/active/{task-id}/implementation.md` - Implementation report

Note: `{task-id}` format is `TASK-{yyyyMMdd-HHmmss}`, e.g. `TASK-20260306-143022`

If either file is missing, prompt the user to complete the prerequisite step first.

### 2. Read Implementation Report

Carefully read `implementation.md` to understand:
- List of modified files
- Key functionality implemented
- Test situation
- Items the implementer flagged for attention

### 3. Execute Code Review

Follow the `code-review` step in `.agents/workflows/feature-development.yaml`:

**Required review areas**:
- [ ] Code quality and coding standards (per project instructions)
- [ ] Bug and potential issue detection
- [ ] Test coverage and test quality
- [ ] Error handling and edge cases
- [ ] Performance and security issues
- [ ] Code comments and documentation
- [ ] Consistency with technical plan

**Review principles**:
1. **Strict but fair**: Point out issues, but also acknowledge strengths
2. **Be specific**: Provide exact file paths and line numbers
3. **Provide suggestions**: Don't just flag problems -- offer solutions
4. **Categorize by severity**: Distinguish must-fix from nice-to-have

Also review the `git diff` to see all changes in context.

### 4. Output Review Report

Create `.ai-workspace/active/{task-id}/review.md`.

### 5. Update Task Status

Update `.ai-workspace/active/{task-id}/task.md`:
- `current_step`: code-review
- `assigned_to`: {reviewer}
- `updated_at`: {current time}
- Mark review.md as completed
- Mark code-review as complete in workflow progress

### 6. Inform User

Output based on review result:

**If approved**:
```
Code review complete for task {task-id}. Verdict: Approved.
- Blockers: 0 | Major: {n} | Minor: {n}

Next step - commit changes using the commit skill.
```

**If changes requested**:
```
Code review complete for task {task-id}. Verdict: Changes Requested.
- Blockers: {n} | Major: {n} | Minor: {n}
- Report: .ai-workspace/active/{task-id}/review.md

Next step - fix issues:
  execute the refine-task skill with {task-id}
```

**If rejected**:
```
Code review complete for task {task-id}. Verdict: Rejected - needs major rework.
- Report: .ai-workspace/active/{task-id}/review.md

Next step - re-implement:
  execute the implement-task skill with {task-id}
```

## Output Template

```markdown
# Code Review Report

## Review Summary

- **Reviewer**: {reviewer name}
- **Review time**: {timestamp}
- **Review scope**: {file count and main modules}
- **Overall verdict**: {Approved / Changes Requested / Rejected}

## Findings

### Blockers (Must Fix)

#### 1. {Issue title}
**File**: `{file-path}:{line-number}`
**Description**: {Detailed description}
**Suggested fix**: {Specific suggestion}
**Severity**: High

### Major Issues (Should Fix)

#### 1. {Issue title}
**File**: `{file-path}:{line-number}`
**Description**: {Detailed description}
**Suggested fix**: {Specific suggestion}
**Severity**: Medium

### Minor Issues (Nice to Have)

#### 1. {Optimization point}
**File**: `{file-path}:{line-number}`
**Suggestion**: {Optimization suggestion}

## Strengths

- {Well-done aspect 1}
- {Well-done aspect 2}

## Standards Compliance

### Coding Standards
- [ ] Naming conventions
- [ ] Code style
- [ ] Comment standards
- [ ] Test standards

### Code Quality Metrics
- Cyclomatic complexity: {Assessment}
- Code duplication: {Assessment}
- Test coverage: {Percentage or assessment}

## Test Review

### Test Coverage
- Unit tests: {Assessment}
- Edge cases: {Covered?}
- Error scenarios: {Covered?}

### Test Quality
- Test naming: {Assessment}
- Assertion adequacy: {Assessment}
- Test independence: {Assessment}

## Security Review

- SQL injection risk: {Check result}
- XSS risk: {Check result}
- Access control: {Check result}
- Sensitive data exposure: {Check result}

## Performance Review

- Algorithm complexity: {Assessment}
- Resource management: {Check result}
- Potential bottlenecks: {Assessment}

## Consistency with Plan

- [ ] Implementation matches technical plan
- [ ] No deviation from design intent
- [ ] No unplanned features added

## Verdict and Recommendations

### Approval Decision
- [ ] Approved - no blocking issues
- [ ] Changes requested - has issues to address
- [ ] Rejected - needs major rework

### Next Steps
{Recommendations based on review result}
```

## Completion Checklist

- [ ] Completed code review of all modified files
- [ ] Created review report `.ai-workspace/active/{task-id}/review.md`
- [ ] Updated `current_step` to code-review in task.md
- [ ] Updated `updated_at` to current time in task.md
- [ ] Updated `assigned_to` to reviewer name in task.md
- [ ] Marked code-review as complete in workflow progress
- [ ] Informed user of next step based on review result

## Notes

1. **Prerequisites**: Must have completed implementation (implementation.md exists)
2. **Objectivity**: Be strict but fair; acknowledge good work alongside issues
3. **Specificity**: Always reference exact file paths and line numbers
4. **Severity classification**: Blockers must be fixed; major issues should be fixed; minor issues are optional

## Error Handling

- Task not found: Prompt "Task {task-id} not found"
- Missing implementation report: Prompt "Implementation report not found, please run the implement-task skill first"
