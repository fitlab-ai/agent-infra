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

- Strictly follow the latest technical plan artifact (`plan.md` or `plan-r{N}.md`) -- do not deviate without documenting the reason
- Do NOT auto-commit. Never execute `git commit` or `git add` automatically
- This skill outputs an implementation report (`implementation.md` or `implementation-r{N}.md`) and must never overwrite an existing round artifact
- After executing this skill, you **must** immediately update task status in task.md

## Steps

### 1. Verify Prerequisites

Check required files:
- `.agents/workspace/active/{task-id}/task.md` - Task file
- At least one technical plan artifact: `plan.md` or `plan-r{N}.md`

Note: `{task-id}` format is `TASK-{yyyyMMdd-HHmmss}`, e.g. `TASK-20260306-143022`

If either file is missing, prompt the user to complete the prerequisite step first.

### 2. Determine the Input Plan and Implementation Round

Scan `.agents/workspace/active/{task-id}/` for technical plan files (`plan.md`, `plan-r{N}.md`):
- Read the highest-round plan file and record it as `{plan-artifact}`

Scan `.agents/workspace/active/{task-id}/` for implementation report files:
- If neither `implementation.md` nor `implementation-r*.md` exists -> this is Round 1 and must create `implementation.md`
- If `implementation.md` exists and no `implementation-r*.md` exists -> this is Round 2 and must create `implementation-r2.md`
- If `implementation-r{N}.md` exists -> this is Round N+1 and must create `implementation-r{N+1}.md`

Record:
- `{plan-artifact}`: the technical plan file used for this implementation
- `{implementation-round}`: the current implementation round
- `{implementation-artifact}`: the implementation report filename for this round

Note: multi-round implementation should only happen after a review verdict of Rejected. A normal first implementation always creates `implementation.md`.

### 3. Read Technical Plan

Carefully read `{plan-artifact}` to understand:
- Technical approach and solution strategy
- Detailed implementation steps
- Files to create/modify
- Test strategy
- Any constraints or risks

### 4. Execute Code Implementation

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

### 5. Run Test Verification

Execute the project's test command. Reference the `test` skill for the project-specific test command:

```bash
# Check .agents/skills/test/SKILL.md for the project's test command
# Common patterns:
# npm test          (Node.js)
# mvn test          (Maven)
# pytest            (Python)
# go test ./...     (Go)
```

If tests fail:
- Analyze the failure first, and prioritize fixing problems introduced by the current implementation, plus any test or documentation updates required to match the approved plan
- Re-run the tests after each fix until they pass, or until you confirm the remaining issue is an external blocker outside the current task scope
- Only stop when the failure is blocked by external dependencies, missing environment, or unclear requirements that cannot be resolved within the task; in that case, report the blocker and do not create the implementation report, update task.md as implementation-complete, or output the Step 8 completion template

Proceed to Steps 6, 7, and 8 only after the full test suite passes.

### 6. Output Implementation Report

Create `.agents/workspace/active/{task-id}/{implementation-artifact}`.

Requirements:
- Do not overwrite any existing implementation report
- Record the actual round number and artifact filename in the report
- If this is a re-implementation round, explain what triggered it

### 7. Update Task Status

Get the current time:

```bash
date "+%Y-%m-%d %H:%M:%S"
```

Update `.agents/workspace/active/{task-id}/task.md`:
- `current_step`: implementation
- `assigned_to`: {current AI agent}
- `updated_at`: {current time}
- Record the implementation artifact for this round: `{implementation-artifact}` (Round `{implementation-round}`)
- Mark implementation as complete in workflow progress and include the actual round when the task template supports it
- **Append** to `## Activity Log` (do NOT overwrite previous entries):
  ```
  - {yyyy-MM-dd HH:mm:ss} — **Implementation (Round {N})** by {agent} — Code implemented, {n} files modified, {n} tests passed → {artifact-filename}
  ```

### 8. Inform User

> **IMPORTANT**: All TUI command formats listed below must be output in full. Do not show only the format for the current AI agent.

Output format:
```
Implementation complete for task {task-id}.

Summary:
- Modified files: {count}
- New files: {count}
- Tests passed: {count}/{total}

Output file:
- Implementation report: .agents/workspace/active/{task-id}/{implementation-artifact} (Round {implementation-round})

Next step - code review:
  - Claude Code / OpenCode: /review-task {task-id}
  - Gemini CLI: /{{project}}:review-task {task-id}
  - Codex CLI: $review-task {task-id}
```

## Output Template

```markdown
# Implementation Report

- **Implementation round**: Round {implementation-round}
- **Artifact file**: `{implementation-artifact}`

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
- [ ] Created implementation report `.agents/workspace/active/{task-id}/{implementation-artifact}`
- [ ] All tests pass
- [ ] Updated `current_step` to implementation in task.md
- [ ] Updated `updated_at` to current time in task.md
- [ ] Updated `assigned_to` in task.md
- [ ] Appended entry to Activity Log in task.md
- [ ] Marked implementation as complete in workflow progress
- [ ] Informed user of next step (must include all TUI command formats — do not filter)

## STOP

After completing the checklist, **stop**. Do not auto-commit. Wait for code review before submission.

## Notes

1. **Prerequisites**: Must have a reviewed technical plan (`plan.md` or `plan-r{N}.md` exists and is approved)
2. **No auto-commit**: Do NOT execute `git commit` or `git add` automatically. Remind the user to commit manually
3. **Test requirement**: All new code must have unit tests; test coverage must not decrease
4. **Code quality**: Follow project coding standards
5. **Plan deviation**: If you need to deviate from the plan, document the reason in the implementation report
6. **Versioning rule**: First-round implementation uses `implementation.md`; later re-implementations use `implementation-r{N}.md`

## Error Handling

- Task not found: Prompt "Task {task-id} not found"
- Missing plan: Prompt "Technical plan not found, please run the plan-task skill first"
- Test failure: Attempt to fix the issue and re-run tests first; stop only when an external blocker, missing environment, or unclear requirement prevents completion, and report that blocker
- Build failure: Output build errors, stop implementation
