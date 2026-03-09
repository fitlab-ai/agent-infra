---
name: "refine-task"
description: "Handle code review feedback and fix issues"
usage: "/refine-task <task-id>"
---

# Refinement Task Command

## Description

Handle issues found during code review, fix the code, and re-enter the review process. This command is used when the code-review step finds changes are needed.

## CRITICAL: Status Update Requirement

After executing this command, you **must** immediately update task status. See rule 7.

## Execution Flow

### 1. Verify Prerequisites

Check required files:
- `.ai-workspace/active/{task-id}/task.md` - Task file
- `.ai-workspace/active/{task-id}/review.md` - Review report (or review-supplement.md)
- `.ai-workspace/active/{task-id}/implementation.md` - Implementation report

Note: `{task-id}` format is `TASK-{yyyyMMdd-HHmmss}`, e.g., `TASK-20260205-202013`

If any file is missing, prompt the user to complete the prerequisite step first.

### 2. Read Review Report

Carefully read the review report (`review.md` or `review-supplement.md` or `review-final.md`), extract issues to fix:

**Issue categories**:
1. **🔴 Must Fix (Blocker)** - Blocking issues, must be fixed before merge
2. **🟡 Suggested Changes (Major)** - Important suggestions, strongly recommended to fix
3. **🟢 Optimization Suggestions (Minor)** - Optional optimizations, can consider fixing

**Extract information**:
- Issue title
- File path and line number
- Issue description
- Fix suggestion

### 3. Plan Fix Tasks with TodoWrite

Create a fix task checklist based on the review report:

```
Use TodoWrite tool to create todos:
- [ ] Fix issue 1: {Issue title}
- [ ] Fix issue 2: {Issue title}
- [ ] Fix issue 3: {Issue title}
...
```

**Priority**:
1. Fix all 🔴 must-fix issues first
2. Then fix 🟡 suggested changes
3. Finally consider 🟢 optimization suggestions

### 4. Execute Code Fixes

Fix issues one by one in priority order:

**Fix workflow**:
1. Read the relevant file, understand the issue context
2. Fix the code according to review suggestions
3. Ensure the fix doesn't introduce new issues
4. Mark the issue as completed in TodoWrite

**Fix principles**:
- Fix strictly according to review suggestions
- If a suggestion is unclear, ask the user
- If new issues are discovered, fix them as well
- Maintain consistent code style

### 5. Run Tests (if there were test failures)

If the review report mentions test issues:

```bash
# Run unit tests
mvn test

# Run specific tests
mvn test -Dtest=TestClassName

# Run integration tests
mvn verify
```

Ensure all tests pass before continuing.

### 6. Update Task Status (CRITICAL)

**Must update** `.ai-workspace/active/{task-id}/task.md`:

```yaml
current_step: refinement
assigned_to: {current AI, e.g., claude}
updated_at: {current time, format: yyyy-MM-dd HH:mm:ss}
```

**Mark in workflow progress**:
```markdown
## Workflow Progress

- [x] requirement-analysis (completed)
- [x] technical-design (completed)
- [x] implementation (completed)
- [x] code-review (completed - issues found)
- [x] refinement (fixing in progress)  ← mark as in progress
- [ ] finalize (pending)
```

### 7. Create Fix Report

Create `.ai-workspace/active/{task-id}/refinement-report.md` to record the fix status:

```markdown
# Code Fix Report

## Fix Summary

- **Fixed by**: {Fixer}
- **Fix time**: {Time}
- **Fix scope**: {Number of issues fixed}
- **Fix source**: Code review feedback

## Fixed Issues

### 🔴 Fixed Blocker Issues

#### 1. {Issue title}
**Original issue**: {Issue description}
**Fix method**: {Detailed description of what was fixed}
**Modified file**: `{file-path}:{line-number}`

### 🟡 Fixed Suggested Changes

#### 1. {Issue title}
**Original issue**: {Issue description}
**Fix method**: {Detailed description of what was fixed}
**Modified file**: `{file-path}:{line-number}`

### 🟢 Adopted Optimization Suggestions

#### 1. {Optimization title}
**Original suggestion**: {Suggestion description}
**Implementation**: {Detailed description of how it was implemented}
**Modified file**: `{file-path}:{line-number}`

## Unfixed Issues (if any)

### {Issue title}
**Reason**: {Why it was not fixed}
**Plan**: {How it will be handled}

## Test Results

- [ ] Unit tests pass
- [ ] Integration tests pass
- [ ] Regression tests pass
- [ ] New tests added (if needed)

## Next Steps

Code has been fixed, ready to re-enter the review process.
```

### 8. Prepare for Re-review

After fixes are complete, inform the user:

**Output format**:
```
Task {task-id} code fixes complete

**Fixed Issues**:
- Must fix: {count} items ✅
- Suggested changes: {count} items ✅
- Optimization suggestions: {count} items ✅

**Output Files**:
- Fix report: .ai-workspace/active/{task-id}/refinement-report.md

**Next Steps**:
Please choose one of the following:
1. Re-review the code:
   - Claude Code / OpenCode: `/review-task {task-id}`
   - Gemini CLI: `/{project}:review-task {task-id}`
   - Codex CLI: `/prompts:{project}-review-task {task-id}`
2. If changes are minor and you're confident, commit directly:
   - Claude Code / OpenCode: `/commit`
   - Gemini CLI: `/{project}:commit`
   - Codex CLI: `/prompts:{project}-commit`
3. If fixes involve significant changes, re-review is recommended
```

## Completion Checklist

After executing this command, confirm:

- [ ] Read review report and extracted all issues
- [ ] Created fix task checklist with TodoWrite
- [ ] Fixed all issues in priority order
- [ ] All tests pass (if applicable)
- [ ] Updated `current_step` to refinement in task.md
- [ ] Updated `updated_at` to current time in task.md
- [ ] Updated `assigned_to` to your name in task.md
- [ ] Marked refinement as in progress in workflow progress
- [ ] Created refinement-report.md to record fix status
- [ ] Informed user of next step (re-review or commit)

## FAQ

### Q: What if the review report is very long with many issues?

A: Prioritize fixing 🔴 blocker issues. If there are too many issues, suggest:
1. Fix all blocker issues first
2. Commit the fixes, then re-review
3. Continue fixing based on the new review results

### Q: What if I disagree with the review feedback?

A: Communicate with the user:
1. Explain your reasoning
2. Provide alternative solutions
3. Let the user decide whether to fix

### Q: Do I need to update the implementation report after fixing?

A: No. Just create refinement-report.md. The implementation report stays as-is, recording the initial implementation.

### Q: Can I skip some suggested changes?

A: Yes, but you must explain the reason in refinement-report.md. Blocker issues must all be fixed.

## Related Commands

- `/review-task` - Re-review the fixed code
- `/implement-task` - If major changes are needed, go back to implementation step
- `/commit` - If fixes are minor and you're confident, commit directly

## Workflow Position

This command corresponds to the **refinement** step in `.agents/workflows/feature-development.yaml`.

## Example

```bash
# Handle review feedback for TASK-20260103-135501
/refine-task TASK-20260103-135501
```
