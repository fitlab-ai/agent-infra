---
name: implement-task
description: "Implement a task from its technical plan and output a report"
---

# Implement Task

Implement the approved task and produce `implementation.md` or `implementation-r{N}.md`.

## Boundary / Critical Rules

- Follow the latest approved plan artifact: `plan.md` or `plan-r{N}.md`
- Never auto-run `git add` or `git commit`
- Create a new implementation artifact for each round and never overwrite an older one
- After executing this skill, you **must** immediately update task.md

## Steps

### 1. Verify Prerequisites

Check these files first:
- `.agents/workspace/active/{task-id}/task.md`
- At least one technical plan artifact: `plan.md` or `plan-r{N}.md`

If either file is missing, stop and ask the user to complete the prerequisite step.

### 2. Determine the Input Plan and Implementation Round

Scan `.agents/workspace/active/{task-id}/` and record:
- the highest-round plan file as `{plan-artifact}`
- the next implementation artifact as `implementation.md` or `implementation-r{N}.md`
- `{implementation-round}` and `{implementation-artifact}`

If any `plan-r{N}.md` exists, read the highest-round plan file. Otherwise read `plan.md`.

### 3. Read the Technical Plan

Read `{plan-artifact}` carefully and extract:
- implementation steps
- files to create or modify
- test strategy
- constraints, risks, and any approved tradeoffs

### 4. Implement the Code

Follow `.agents/workflows/feature-development.yaml` and the plan in order.

> Detailed implementation rules, testing discipline, and deviation handling live in `reference/implementation-rules.md`. Read `reference/implementation-rules.md` before executing this step.

### 5. Run Test Verification

Use the project test command from the `test` skill and keep iterating until all required tests pass.

If tests fail, Attempt to fix the issue and re-run tests first. Only stop when you confirm an external blocker, missing environment, or unclear requirement that is out of scope for the task.

### 6. Write the Implementation Report

Create `.agents/workspace/active/{task-id}/{implementation-artifact}`.

> Report structure, required sections, and the full template live in `reference/report-template.md`. Read `reference/report-template.md` before writing the report.

### 7. Update Task Status

Get the current time:

```bash
date "+%Y-%m-%d %H:%M:%S"
```

Update `.agents/workspace/active/{task-id}/task.md`:
- `current_step`: implementation
- `assigned_to`: {current agent}
- `updated_at`: {current time}
- record `{implementation-artifact}` for Round `{implementation-round}`
- append:
  `- {yyyy-MM-dd HH:mm:ss} — **Implementation (Round {N})** by {agent} — Code implemented, {n} files modified, {n} tests passed → {implementation-artifact}`

### 8. Inform the User

Output the implementation summary and include all TUI command variants for the next review step.

## Completion Checklist

- [ ] Implemented the approved code changes
- [ ] Created `{implementation-artifact}`
- [ ] All required tests passed
- [ ] Updated task.md and appended the Activity Log entry
- [ ] Included every TUI command format in the user-facing next step

## STOP

Stop after the checklist is complete. Do not auto-commit.

## Notes

- Round 1 uses `implementation.md`; later rounds use `implementation-r{N}.md`
- Record any deviation from `{plan-artifact}` in the report
- New tests must validate meaningful business behavior, not just passthrough data

## Error Handling

- Task not found: `Task {task-id} not found`
- Missing plan: `Technical plan not found, please run the plan-task skill first`
- Test failure after local fixes: explain the external blocker and stop without creating the implementation artifact
