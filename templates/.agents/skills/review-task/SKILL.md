---
name: review-task
description: >
  Review implemented task changes and output a code review report, categorized by
  severity (Blocker / Major / Minor). Triggered when the user requests code
  review after implementation is complete. Argument: task-id.
---

# Code Review

## Boundary / Critical Rules

- This skill only reads code and produces a review report (`review.md` or `review-r{N}.md`) -- it does not modify business code
- After executing this skill, you **must** immediately update task status in task.md

## Steps

### 1. Verify Prerequisites

Check required files:
- `.agent-workspace/active/{task-id}/task.md` - Task file
- At least one implementation report: `implementation.md` or `implementation-r{N}.md`

Note: `{task-id}` format is `TASK-{yyyyMMdd-HHmmss}`, for example `TASK-20260306-143022`

If either file is missing, prompt the user to complete the prerequisite step first.

### 2. Determine Review Round

Scan review artifacts in `.agent-workspace/active/{task-id}/`:
- If neither `review.md` nor `review-r*.md` exists -> this is Round 1 and must create `review.md`
- If `review.md` exists and no `review-r*.md` exists -> this is Round 2 and must create `review-r2.md`
- If `review-r{N}.md` exists -> this is Round N+1 and must create `review-r{N+1}.md`

Record:
- `{review-round}`: the current review round
- `{review-artifact}`: the review report filename for this round

### 3. Read Implementation and Refinement Reports

Scan implementation reports in the task directory (`implementation.md`, `implementation-r{N}.md`) and read the highest-round file to understand:
- The list of modified files
- The key functionality that was implemented
- Test results
- Any items the implementer marked for reviewer attention

If refinement artifacts exist (`refinement.md`, `refinement-r{N}.md`), read the highest-round file to understand:
- Which review findings were already fixed
- The effect of those fixes on code and tests
- How the current code state changed relative to the previous review

### 4. Perform Code Review

Follow the `code-review` step in `.agents/workflows/feature-development.yaml`:

**Required review areas**:
- [ ] Code quality and coding standards (per project instructions)
- [ ] Bug and risk detection
- [ ] Test coverage and test quality
- [ ] Error handling and edge cases
- [ ] Performance and security concerns
- [ ] Code comments and documentation
- [ ] Alignment with the technical plan

**Review principles**:
1. **Strict but fair**: Point out issues while also calling out what was done well
2. **Specific**: Provide exact file paths and line numbers
3. **Actionable**: Do not only point out problems; give fix suggestions
4. **Severity-based**: Distinguish must-fix issues from optional improvements

Also review `git diff` to inspect the full context of all changes.

### 5. Output Review Report

Create `.agent-workspace/active/{task-id}/{review-artifact}`.

### 6. Update Task Status

Get the current time:

```bash
date "+%Y-%m-%d %H:%M:%S"
```

Update `.agent-workspace/active/{task-id}/task.md`:
- `current_step`: code-review
- `assigned_to`: {reviewer}
- `updated_at`: {current time}
- Record the review artifact for this round: `{review-artifact}` (Round `{review-round}`)
- Mark code-review as complete in workflow progress and include the actual round when the task template supports it
- **Append** to `## Activity Log` (do NOT overwrite previous entries):
  ```
  - {yyyy-MM-dd HH:mm:ss} — **Code Review (Round {N})** by {agent} — Verdict: {Approved/Changes Requested/Rejected}, blockers: {n}, major: {n}, minor: {n} → {artifact-filename}
  ```

### 7. Inform User

> **IMPORTANT**: All TUI command formats listed below must be output in full. Do not show only the format for the current AI agent.

Output based on the review result:

> **⚠️ CONDITION CHECK — you must determine the conditions below first, then choose exactly one matching output branch:**
>
> 1. If `Blocker = 0` and `Major = 0` and `Minor = 0` -> use "Output Branch A - Passed with No Issues"
> 2. If `Blocker = 0` and (`Major > 0` or `Minor > 0`) -> use "Output Branch B - Passed with Issues"
> 3. If `Blocker > 0` and the issues can be resolved in a focused follow-up fix, **without requiring broad rework** -> use "Output Branch C - Changes Requested"
> 4. If the issues require major rework, redesign, or re-implementation -> use "Output Branch D - Rejected"
>
> **Do not skip the decision. Do not mix templates from different branches. You must output exactly one branch. As soon as `Blocker > 0`, you must not output any "Approved" template.**

**📋 Output Branch A - Passed with No Issues** (Condition: Blocker = 0 and Major = 0 and Minor = 0):
```
Code review complete for task {task-id}. Verdict: Approved.
- Blockers: 0 | Major issues: 0 | Minor issues: 0

Next step - commit changes:
  - Claude Code / OpenCode: /commit
  - Gemini CLI: /{{project}}:commit
  - Codex CLI: $commit
```

**📋 Output Branch B - Passed with Issues** (Condition: Blocker = 0 and (`Major > 0` or `Minor > 0`)):
```
Code review complete for task {task-id}. Verdict: Approved.
- Blockers: 0 | Major issues: {n} | Minor issues: {n}
- Review report: .agent-workspace/active/{task-id}/{review-artifact}

Next step - fix issues before commit (recommended):
  - Claude Code / OpenCode: /refine-task {task-id}
  - Gemini CLI: /{{project}}:refine-task {task-id}
  - Codex CLI: $refine-task {task-id}

Or commit directly (skip fixes):
  - Claude Code / OpenCode: /commit
  - Gemini CLI: /{{project}}:commit
  - Codex CLI: $commit
```

**📋 Output Branch C - Changes Requested** (Condition: Blocker > 0, and the issues are fixable without major rework):
```
Code review complete for task {task-id}. Verdict: Changes Requested.
- Blockers: {n} | Major issues: {n} | Minor issues: {n}
- Review report: .agent-workspace/active/{task-id}/{review-artifact}

Next step - refine the issues:
  - Claude Code / OpenCode: /refine-task {task-id}
  - Gemini CLI: /{{project}}:refine-task {task-id}
  - Codex CLI: $refine-task {task-id}
```

**📋 Output Branch D - Rejected** (Condition: major rework, redesign, or re-implementation is required):
```
Code review complete for task {task-id}. Verdict: Rejected, major rework required.
- Review report: .agent-workspace/active/{task-id}/{review-artifact}

Next step - re-implement:
  - Claude Code / OpenCode: /implement-task {task-id}
  - Gemini CLI: /{{project}}:implement-task {task-id}
  - Codex CLI: $implement-task {task-id}
```

## Output Template

```markdown
# Code Review Report

- **Review round**: Round {review-round}
- **Artifact file**: `{review-artifact}`
- **Implementation input**:
  - `{implementation-artifact}`
  - `{refinement-artifact}` (if present)

## Review Summary

- **Reviewer**: {reviewer name}
- **Review time**: {timestamp}
- **Review scope**: {file count and major modules}
- **Overall verdict**: {Approved / Changes Requested / Rejected}

## Findings

### Blockers (must fix)

#### 1. {Issue title}
**File**: `{file-path}:{line-number}`
**Description**: {Detailed description}
**Suggested fix**: {Concrete suggestion}
**Severity**: High

### Major Issues (should fix)

#### 1. {Issue title}
**File**: `{file-path}:{line-number}`
**Description**: {Detailed description}
**Suggested fix**: {Concrete suggestion}
**Severity**: Medium

### Minor Issues (optional improvements)

#### 1. {Improvement point}
**File**: `{file-path}:{line-number}`
**Suggestion**: {Improvement suggestion}

## Highlights

- {Positive aspect 1}
- {Positive aspect 2}

## Standards Compliance

### Coding Standards
- [ ] Naming conventions
- [ ] Code style
- [ ] Comment standards
- [ ] Testing standards

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
- Assertion sufficiency: {Assessment}
- Test independence: {Assessment}

## Security Review

- SQL injection risk: {Check result}
- XSS risk: {Check result}
- Access control: {Check result}
- Sensitive data exposure: {Check result}

## Performance Review

- Algorithmic complexity: {Assessment}
- Resource management: {Check result}
- Potential bottlenecks: {Assessment}

## Alignment with Plan

- [ ] Implementation matches the technical plan
- [ ] No deviation from design intent
- [ ] No out-of-scope functionality was added

## Conclusion and Recommendation

### Approval Decision
- [ ] Approved - no blocking issues
- [ ] Changes Requested - issues need to be resolved
- [ ] Rejected - major rework required

### Next Steps
{Recommendation based on the review result}
```

## Completion Checklist

- [ ] Completed code review for all modified files
- [ ] Created review report `.agent-workspace/active/{task-id}/{review-artifact}`
- [ ] Updated `current_step` to code-review in task.md
- [ ] Updated `updated_at` to the current time in task.md
- [ ] Updated `assigned_to` to the reviewer name in task.md
- [ ] Appended an Activity Log entry to task.md
- [ ] Marked code-review as complete in workflow progress
- [ ] Informed the user of the next step based on the review result (must include all TUI command formats without filtering)

## Notes

1. **Prerequisite**: At least one implementation round must already exist (`implementation.md` or `implementation-r{N}.md`)
2. **Objectivity**: Be strict but fair; acknowledge strong work while pointing out issues
3. **Specificity**: Always cite exact file paths and line numbers
4. **Severity categories**: Blockers must be fixed; major issues should be fixed; minor issues are optional
5. **Versioning rule**: First review uses `review.md`; later rounds use `review-r{N}.md`

## Error Handling

- Task not found: Prompt "Task {task-id} not found"
- Missing implementation report: Prompt "Implementation report not found, please run the implement-task skill first"
