---
name: refine-task
description: >
  Process code review feedback and fix the issues found in review. Fix items by
  priority (Blocker -> Major -> Minor). Only handle issues explicitly marked in
  the review; do not add unrelated changes. Triggered when the user asks to fix
  review findings. Argument: task-id.
---

# Refine Review Findings

## Boundary / Critical Rules

- Only fix issues that were explicitly identified in review -- do not add unrelated changes or extra "improvements"
- Do NOT auto-commit. Never execute `git commit` or `git add`
- After executing this skill, you **must** immediately update task status in task.md

## Steps

### 1. Verify Prerequisites

Check required files:
- `.agents/workspace/active/{task-id}/task.md` - Task file
- At least one review artifact: `review.md` or `review-r{N}.md`

Note: `{task-id}` format is `TASK-{yyyyMMdd-HHmmss}`, for example `TASK-20260306-143022`

If `task.md` is missing or there is no review artifact, prompt the user to complete the prerequisite step first.

Then perform this discovery and validation:
1. Scan review artifact files in the task directory (`review.md`, `review-r{N}.md`)
2. Use the highest-round review artifact as the input for this refinement round and record it as `{review-artifact}`
3. Scan refinement artifact files (`refinement.md`, `refinement-r{N}.md`) and determine the current refinement artifact:
   - If neither `refinement.md` nor `refinement-r*.md` exists -> this is Round 1 and must create `refinement.md`
   - If `refinement.md` exists and no `refinement-r*.md` exists -> this is Round 2 and must create `refinement-r2.md`
   - If `refinement-r{N}.md` exists -> this is Round N+1 and must create `refinement-r{N+1}.md`
   - Record `{refinement-round}` and `{refinement-artifact}`
4. Scan implementation report files (`implementation.md`, `implementation-r{N}.md`) and use the highest-round artifact as the implementation context `{implementation-artifact}`
   - Record `{implementation-artifact}`
5. **Consistency check**: verify that the most recent Code Review entry in `task.md` `## Activity Log` matches the round number and filename of the latest review artifact found in Step 2

If the Activity Log entry does not match the actual file, stop immediately and prompt:
`Review artifact mismatch: Activity Log references {expected} but file not found. Please verify the review artifact exists.`

### 2. Read Review and Implementation Context

Carefully read the latest review artifact `{review-artifact}` and implementation artifact `{implementation-artifact}` identified in Step 1 to understand:
- All blockers (must fix)
- All major issues (should fix)
- Minor issues (optional improvements)
- Reviewer recommendations and suggestions
- The context of the current implementation and previous refinements

### 3. Plan the Fixes

Classify and prioritize:
1. **Blockers first**: all blockers must be resolved
2. **Then major issues**: handle all major issues
3. **Finally minor issues**: fix if appropriate (optional)

For each issue, determine:
- Which files need to be modified
- What exact change is required
- How to verify the fix

### 4. Execute the Fixes

Fix issues in priority order:

**For each fix**:
1. Read the affected file
2. Apply the fix
3. Verify that the change resolves the review finding
4. Run relevant tests

**Refinement principles**:
- Only fix marked review issues -- do not add unrelated changes
- Do not add extra "improvements" beyond the scope of the review
- Keep the changes minimal and focused

### 5. Run Test Verification

Execute the project's test command. Reference the `test` skill for the project-specific test command.

Ensure all tests still pass after the fixes.

### 6. Create Refinement Report

Create `.agents/workspace/active/{task-id}/{refinement-artifact}`.

### 7. Update Task Status

Get the current time:

```bash
date "+%Y-%m-%d %H:%M:%S"
```

Update `.agents/workspace/active/{task-id}/task.md`:
- `current_step`: refinement
- `assigned_to`: {current AI agent}
- `updated_at`: {current time}
- Record the refinement artifact for this round: `{refinement-artifact}` (Round `{refinement-round}`)
- **Append** to `## Activity Log` (do NOT overwrite previous entries):
  ```
  - {yyyy-MM-dd HH:mm:ss} — **Refinement (Round {N}, for {review-artifact})** by {agent} — Fixed {n} blockers, {n} major, {n} minor issues → {refinement-artifact}
  ```

### 8. Inform User

> **IMPORTANT**: All TUI command formats listed below must be output in full. Do not show only the format for the current AI agent.

> **⚠️ CONDITION CHECK — before showing the two next steps below, you must judge the result of this refinement round first:**
>
> - If this round fixed any `Blocker` or `Major` issue, or the changes touched core logic or test scope broadly, **default recommendation** is "Run review again"
> - If this round fixed only `Minor` issues and the change scope is small and low-risk, "Commit directly" may be offered as an option
> - If any `Blocker` or `Major` issue remains unresolved, **do not** imply that direct commit is acceptable; explicitly tell the user to continue fixing or re-run review
>
> **Do not present "Commit directly" as the default path unless you are sure no high-risk issue remains.**

Output format:
```
Refinement complete for task {task-id}.

Fix summary:
- Blockers fixed: {count}/{total}
- Major issues fixed: {count}/{total}
- Minor issues fixed: {count}/{total}
- All tests passing: {yes/no}
- Review input: {review-artifact}
- Refinement artifact: {refinement-artifact}

Next step - re-review or commit:
- Run review again (default recommendation; prioritize this after Blocker/Major fixes):
  - Claude Code / OpenCode: /review-task {task-id}
  - Gemini CLI: /{{project}}:review-task {task-id}
  - Codex CLI: $review-task {task-id}
- Commit directly (only when only Minor issues were fixed and risk is low):
  - Claude Code / OpenCode: /commit
  - Gemini CLI: /{{project}}:commit
  - Codex CLI: $commit
```

## Output Template

```markdown
# Refinement Report

- **Refinement round**: Round {refinement-round}
- **Artifact file**: `{refinement-artifact}`
- **Review input**: `{review-artifact}`
- **Implementation context**: `{implementation-artifact}`

### Review Feedback Handling

#### Blocker Fixes
1. **{Issue title}** (from {review-artifact})
   - **Fix**: {What changed}
   - **File**: `{file-path}:{line-number}`
   - **Validation**: {How it was verified}

#### Major Issue Fixes
1. **{Issue title}** (from {review-artifact})
   - **Fix**: {What changed}
   - **File**: `{file-path}:{line-number}`

#### Minor Issue Handling
1. **{Issue title}** (from {review-artifact})
   - **Fix**: {What changed}

#### Unresolved Issues
- {Issue}: {Reason it was not handled, for example disagreement with the review suggestion}

### Test Results After Refinement
- All tests passing: {yes/no}
- Test output: {Summary}
```

## Completion Checklist

- [ ] Read and understood all review findings
- [ ] Fixed all blockers
- [ ] Fixed all major issues
- [ ] Addressed minor issues when appropriate
- [ ] All tests pass after the fixes
- [ ] Created refinement report `{refinement-artifact}`
- [ ] Updated task status in task.md
- [ ] Appended an Activity Log entry to task.md
- [ ] Informed the user of the next step (must include all TUI command formats without filtering)

## Notes

1. **Prerequisite**: A review report must exist (`review.md` or `review-r{N}.md`)
2. **No auto-commit**: Do NOT execute `git commit`. Remind the user to commit manually
3. **Scope discipline**: Only fix issues marked in review -- do not add extra changes
4. **Disagreement**: If you disagree with a review finding, record your reasoning in "Unresolved Issues"
5. **Re-review**: After fixing blockers, re-run `review-task` to validate the result
6. **Consistency requirement**: The latest review artifact, Activity Log entry, and refinement report title must all reference the same review round
7. **Versioning rule**: First refinement uses `refinement.md`; later rounds use `refinement-r{N}.md`

## STOP

After completing the checklist, **stop immediately**. Wait for the user to review the fixes and decide whether to run review again or commit.

## Error Handling

- Task not found: Prompt "Task {task-id} not found"
- Missing review report: Prompt "Review report not found, please run the review-task skill first"
- Review artifact mismatch: Prompt "Review artifact mismatch: Activity Log references {expected} but file not found. Please verify the review artifact exists."
- Test failure after fixes: Output the test errors and ask the user how to proceed
