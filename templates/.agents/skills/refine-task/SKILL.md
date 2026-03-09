---
name: refine-task
description: >
  Handle code review feedback and fix issues found during review. Fixes are
  applied in priority order (Blocker -> Major -> Minor). Only addresses
  issues flagged in the review -- no extra changes. Triggered when the user
  requests fixing review issues. Argument: task-id.
---

# Fix Review Issues

## Boundary / Critical Rules

- Fix only what was flagged in the review -- do NOT add unrelated changes or extra "improvements"
- Do NOT auto-commit. Never execute `git commit` or `git add` automatically
- After executing this skill, you **must** immediately update task status in task.md

## Steps

### 1. Verify Prerequisites

Check required files:
- `.ai-workspace/active/{task-id}/task.md` - Task file
- `.ai-workspace/active/{task-id}/review.md` - Review report

Note: `{task-id}` format is `TASK-{yyyyMMdd-HHmmss}`, e.g. `TASK-20260306-143022`

If either file is missing, prompt the user to complete the prerequisite step first.

### 2. Read Review Report

Carefully read `review.md` to understand:
- All blocker issues (must fix)
- All major issues (should fix)
- Minor issues (optional optimizations)
- Reviewer's suggestions and recommendations

### 3. Plan Fixes

Categorize and prioritize issues:
1. **Blockers first**: All blocker issues must be resolved
2. **Then major issues**: Address all major issues
3. **Then minor issues**: Address if time permits (optional)

For each issue, determine:
- Which file(s) need changes
- What specific changes to make
- How to verify the fix

### 4. Execute Code Fixes

Fix issues in priority order:

**For each fix**:
1. Read the affected file
2. Apply the fix
3. Verify the fix addresses the review comment
4. Run relevant tests

**Fix principles**:
- Fix only what was flagged -- do NOT add unrelated changes
- Do NOT add extra "improvements" beyond what was requested
- Keep changes minimal and focused

### 5. Run Test Verification

Execute the project's test command. Reference the `test` skill for the project-specific test command.

Ensure all tests still pass after fixes.

### 6. Create Refinement Report

Update `.ai-workspace/active/{task-id}/implementation.md` by appending a refinement section.

### 7. Update Task Status

Update `.ai-workspace/active/{task-id}/task.md`:
- `current_step`: refinement
- `assigned_to`: {current AI agent}
- `updated_at`: {current time}

### 8. Inform User

Output format:
```
Refinement complete for task {task-id}.

Fixes applied:
- Blockers fixed: {count}/{total}
- Major issues fixed: {count}/{total}
- Minor issues fixed: {count}/{total}
- All tests pass: {Yes/No}

Next step - re-review or commit:
- Re-review: execute the review-task skill with {task-id}
- Commit directly: execute the commit skill
```

## Output Template

Append to `implementation.md`:

```markdown
## Refinement Record

### Review Feedback Processing

#### Blockers Fixed
1. **{Issue title}** (from review.md)
   - **Fix**: {What was changed}
   - **File**: `{file-path}:{line-number}`
   - **Verification**: {How verified}

#### Major Issues Fixed
1. **{Issue title}** (from review.md)
   - **Fix**: {What was changed}
   - **File**: `{file-path}:{line-number}`

#### Minor Issues Addressed
1. **{Issue title}** (from review.md)
   - **Fix**: {What was changed}

#### Issues Not Addressed
- {Issue}: {Reason for not addressing, e.g. disagreed with suggestion}

### Test Results After Refinement
- All tests pass: {Yes/No}
- Test output: {Summary}
```

## Completion Checklist

- [ ] Read and understood all review findings
- [ ] Fixed all blocker issues
- [ ] Fixed all major issues
- [ ] Addressed minor issues where appropriate
- [ ] All tests pass after fixes
- [ ] Updated implementation.md with refinement record
- [ ] Updated task status in task.md
- [ ] Informed user of next step

## Notes

1. **Prerequisites**: Must have a review report (review.md exists)
2. **No auto-commit**: Do NOT execute `git commit` automatically. Remind the user to commit manually
3. **Scope discipline**: Only fix what was flagged in the review -- no additional changes
4. **Disagreements**: If you disagree with a review comment, document your reasoning in the "Issues Not Addressed" section
5. **Re-review**: After fixing blockers, it is recommended to re-run the review-task skill to verify

## Error Handling

- Task not found: Prompt "Task {task-id} not found"
- Missing review report: Prompt "Review report not found, please run the review-task skill first"
- Test failure after fix: Output test errors, ask user how to proceed
