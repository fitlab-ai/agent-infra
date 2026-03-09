---
name: "review-task"
description: "Review task implementation and output code review report"
usage: "/review-task <task-id> [--pr-number]"
---

# Review Task Command

## Description

Review the task's code implementation, check code quality, standard compliance, test coverage, etc., and output a review report.

## CRITICAL: Status Update Requirement

After executing this command, you **must** immediately update task status. See rule 7.

## Execution Flow

### 1. Verify Prerequisites

Check required files:
- `.ai-workspace/active/{task-id}/task.md` - Task file
- `.ai-workspace/active/{task-id}/implementation.md` - Implementation report

Note: `{task-id}` format is `TASK-{yyyyMMdd-HHmmss}`, e.g., `TASK-20260205-202013`

If either file is missing, prompt the user to complete the prerequisite step first.

### 2. Read Implementation Report

Carefully read `implementation.md` to understand:
- List of modified files
- Key implemented features
- Test status
- Points flagged by the implementer for attention

### 3. Execute Code Review

Follow the `code-review` step in `.agents/workflows/feature-development.yaml`:

**Required review items**:
- [ ] Code quality and coding standards (follow CLAUDE.md)
- [ ] Bug and potential issue detection
- [ ] Test coverage and test quality
- [ ] Error handling and edge cases
- [ ] Performance and security issues
- [ ] Code comments and documentation
- [ ] Consistency with technical plan

**Review principles**:
1. **Strict but fair**: Point out issues, but also acknowledge strengths
2. **Specific and clear**: Provide specific files and line numbers
3. **Offer suggestions**: Not only point out issues, but also provide improvement suggestions
4. **Prioritize**: Distinguish between must-fix and nice-to-have optimizations

### 4. Invoke Professional Review Tools (Optional)

If deeper review is needed, you can invoke:

**Option 1: Quick review** (recommended for daily PRs)
```bash
/code-review:code-review <pr-number>
```
- 5 parallel Sonnet agents
- CLAUDE.md standard compliance
- Bug detection and historical context analysis

**Option 2: Deep review** (recommended for important features)
```bash
/pr-review-toolkit:review-pr
```
- 6 specialized review agents
- Multi-dimensional review: code comment accuracy, test coverage, error handling, type design, etc.

### 5. Output Review Report

Create `.ai-workspace/active/{task-id}/review.md`, which must include the following sections:

```markdown
# Code Review Report

## Review Summary

- **Reviewer**: {Reviewer}
- **Review Time**: {Time}
- **Review Scope**: {Number of files and main modules}
- **Overall Assessment**: {Approved/Changes Requested/Rejected}

## Review Findings

### 🔴 Must Fix (Blocker)

#### 1. {Issue title}
**File**: `{file-path}:{line-number}`
**Issue Description**: {Detailed description}
**Fix Suggestion**: {Specific suggestion}
**Severity**: High

### 🟡 Suggested Changes (Major)

#### 1. {Issue title}
**File**: `{file-path}:{line-number}`
**Issue Description**: {Detailed description}
**Fix Suggestion**: {Specific suggestion}
**Severity**: Medium

### 🟢 Optimization Suggestions (Minor)

#### 1. {Optimization point}
**File**: `{file-path}:{line-number}`
**Suggestion**: {Optimization suggestion}

## Strengths and Highlights

- {Well-done point 1}
- {Well-done point 2}

## Standards Compliance

### CLAUDE.md Compliance
- [ ] Coding standards
- [ ] Naming conventions
- [ ] Comment standards
- [ ] Test standards

### Code Quality Metrics
- Cyclomatic complexity: {Assessment}
- Code duplication: {Assessment}
- Test coverage: {Percentage}

## Test Review

### Test Coverage
- Unit tests: {Assessment}
- Edge cases: {Covered?}
- Error cases: {Covered?}

### Test Quality
- Test naming: {Assessment}
- Assertion completeness: {Assessment}
- Test independence: {Assessment}

## Security Review

- SQL injection risk: {Check result}
- XSS risk: {Check result}
- Access control: {Check result}
- Sensitive data exposure: {Check result}

## Performance Review

- Algorithm complexity: {Assessment}
- Database queries: {Optimization suggestions}
- Resource cleanup: {Check result}

## Plan Consistency

- [ ] Implementation matches technical plan
- [ ] No deviation from design intent
- [ ] No unplanned features

## Summary and Recommendations

### Approval Decision
- [ ] ✅ Approved for merge (no blocker issues)
- [ ] ⚠️ Approved after changes (has suggested changes)
- [ ] ❌ Major changes needed (has blocker issues)

### Next Steps
{Suggestions based on review results}
```

### 6. Update Task Status

Update `.ai-workspace/active/{task-id}/task.md`:
- `current_step`: code-review
- `assigned_to`: {reviewer}
- `updated_at`: {current time}
- Mark review.md as completed
- Mark code-review as complete in workflow progress

### 7. Inform User

Output format:
```
Task {task-id} code review complete

**Review Results**:
- Must fix: {count} items
- Suggested changes: {count} items
- Optimization suggestions: {count} items
- Overall assessment: {Assessment}

**Output Files**:
- Review report: .ai-workspace/active/{task-id}/review.md

**Next Steps** (choose based on review results):
- If no blocker issues:
  - Claude Code / OpenCode: `/commit`
  - Gemini CLI: `/{project}:commit`
  - Codex CLI: `/prompts:{project}-commit`
- If changes needed:
  - Claude Code / OpenCode: `/refine-task {task-id}`
  - Gemini CLI: `/{project}:refine-task {task-id}`
  - Codex CLI: `/prompts:{project}-refine-task {task-id}`
- If major changes needed:
  - Claude Code / OpenCode: `/implement-task {task-id}`
  - Gemini CLI: `/{project}:implement-task {task-id}`
  - Codex CLI: `/prompts:{project}-implement-task {task-id}`
```

## Completion Checklist

After executing this command, confirm:

- [ ] Completed code review
- [ ] Created review report `.ai-workspace/active/{task-id}/review.md`
- [ ] Updated `current_step` to code-review in task.md
- [ ] Updated `updated_at` to current time in task.md
- [ ] Updated `assigned_to` to your name (reviewer) in task.md
- [ ] Marked implementation as complete in workflow progress
- [ ] Marked code-review as in progress in workflow progress
- [ ] Marked review.md as completed in task.md
- [ ] Informed user of next step (based on review results)
- [ ] If review passed, informed user to use /commit to commit
- [ ] If fixes needed, informed user to use /refine-task to fix issues

## Parameters

- `<task-id>`: Task ID, format TASK-{yyyyMMdd-HHmmss} (required)
- `--pr-number`: Optional, if PR already created, provide PR number for deeper review via plugins

## Usage Example

### Example 1: Basic Code Review

```bash
# Review task after code implementation is complete
/review-task TASK-20251227-104654
```

**Expected Output**:
```
Task TASK-20251227-104654 code review complete

**Review Results**:
- Must fix: 2 items
- Suggested changes: 3 items
- Optimization suggestions: 5 items
- Overall assessment: Changes Requested

**Output Files**:
- Review report: .ai-workspace/active/TASK-20251227-104654/review.md

**Next Steps** (changes needed):
- Claude Code / OpenCode: `/refine-task TASK-20251227-104654`
- Gemini CLI: `/{project}:refine-task TASK-20251227-104654`
- Codex CLI: `/prompts:{project}-refine-task TASK-20251227-104654`
```

### Example 2: Deep Review with PR

```bash
# If PR already created, invoke professional review tools
/review-task TASK-20251227-104654 --pr-number 123
```

This will invoke `/pr-review-toolkit:review-pr` for multi-dimensional deep review after the basic review.

### Example 3: Full Workflow

**Feature development flow**:
```bash
# 1. Analyze Issue
/analyze-issue 207

# 2. Design technical plan
/plan-task TASK-20251227-104654

# 3. Implement feature
/implement-task TASK-20251227-104654

# 4. Code review ← current step
/review-task TASK-20251227-104654

# 5. If review passes, commit code
/commit

# 6. Create Pull Request
/create-pr
```

**Security fix flow**:
```bash
# 1. Analyze security alert
/analyze-dependabot 23

# 2. Design fix plan
/plan-task TASK-20251227-110000

# 3. Implement fix
/implement-task TASK-20251227-110000

# 4. Code review ← current step
/review-task TASK-20251227-110000

# 5. If review passes, commit code
/commit

# 6. Create Pull Request
/create-pr
```

## Notes

1. **Prerequisites**:
   - Must have completed code implementation (implementation.md exists)
   - Recommend running tests to ensure functionality works

2. **Review Standards**:
   - Strictly follow coding standards in CLAUDE.md
   - Focus on security and performance issues
   - Ensure adequate test coverage

3. **Review Depth**:
   - Daily features: Basic review is sufficient
   - Important features: Recommend using `--pr-number` to invoke professional review tools

4. **Objectivity and Fairness**:
   - Point out issues and acknowledge strengths
   - Provide specific improvement suggestions
   - Distinguish severity levels

## Related Commands

- `/implement-task <task-id>` - Implement task (prerequisite step)
- `/commit` - Commit code (next step)
- `/code-review:code-review <pr-number>` - Deep PR review
- `/pr-review-toolkit:review-pr` - Professional multi-dimensional review

## Error Handling

- Task not found: Prompt "Task {task-id} not found"
- Missing implementation report: Prompt "Implementation report not found, please run /implement-task first"
- PR not found: Prompt "PR #{number} not found, please check the PR number"
