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

### 2. Ensure the Task Branch

Read the branch field in `## Context` from `task.md` and check whether the current Git branch matches it.

- if a task branch is already recorded, switch to it when the current branch does not match
- if no branch is recorded, check whether the current branch follows the naming convention and belongs to this task
  - if yes: record the current branch and continue
  - if no: create and switch to a new task branch that follows the naming rule

After this step, write the final branch name back to `task.md`.

> Branch naming rules, Git commands, and edge-case handling live in `reference/branch-management.md`. Read `reference/branch-management.md` before executing this step.

### 3. Narrow the Milestone

If task.md contains a valid `issue_number`, read `.agents/rules/issue-sync.md` first to complete upstream repository detection plus permission detection; then read `.agents/rules/milestone-inference.md` and follow "Phase 2: `implement-task`" to narrow the Issue milestone before implementation starts; if `has_triage=false`, keep the current milestone unchanged.

### 4. Determine the Input Plan and Implementation Round

Scan `.agents/workspace/active/{task-id}/` and record:
- the highest-round plan file as `{plan-artifact}`
- the next implementation artifact as `implementation.md` or `implementation-r{N}.md`
- `{implementation-round}` and `{implementation-artifact}`

If any `plan-r{N}.md` exists, read the highest-round plan file. Otherwise read `plan.md`.

### 5. Read the Technical Plan

Read `{plan-artifact}` carefully and extract:
- implementation steps
- files to create or modify
- test strategy
- constraints, risks, and any approved tradeoffs

### 6. Implement the Code

Follow `.agents/workflows/feature-development.yaml` and the plan in order.

> Detailed implementation rules, testing discipline, and deviation handling live in `reference/implementation-rules.md`. Read `reference/implementation-rules.md` before executing this step.

### 7. Run Test Verification

Use the project test command from the `test` skill and keep iterating until all required tests pass.

If tests fail, Attempt to fix the issue and re-run tests first. Only stop when you confirm an external blocker, missing environment, or unclear requirement that is out of scope for the task.

### 8. Write the Implementation Report

Create `.agents/workspace/active/{task-id}/{implementation-artifact}`.

> Report structure, required sections, and the full template live in `reference/report-template.md`. Read `reference/report-template.md` before writing the report.

### 9. Update Task Status

Get the current time:

```bash
date "+%Y-%m-%d %H:%M:%S%:z"
```

Update `.agents/workspace/active/{task-id}/task.md`:
- `current_step`: implementation
- `assigned_to`: {current agent}
- `updated_at`: {current time}
- review the `## Requirements` section and only change items from `- [ ]` to `- [x]` when they are clearly satisfied by this round's implemented code and passing tests
- record `{implementation-artifact}` for Round `{implementation-round}`
- append:
  `- {YYYY-MM-DD HH:mm:ss±HH:MM} — **Implementation (Round {N})** by {agent} — Code implemented, {n} files modified, {n} tests passed → {implementation-artifact}`

If task.md contains a valid `issue_number`, perform these sync actions (skip and continue on any failure; read `.agents/rules/issue-sync.md` first and complete upstream repository detection plus permission detection):
- Set `status: in-progress` by following issue-sync.md
- Create or update the `<!-- sync-issue:{task-id}:task -->` comment (follow the task.md comment sync rule in issue-sync.md)
- Publish the `{implementation-artifact}` comment

### 10. Verification Gate

Run the verification gate to confirm the task artifact and sync state are valid:

```bash
node .agents/scripts/validate-artifact.js gate implement-task .agents/workspace/active/{task-id} {implementation-artifact} --format text
```

Handle the result as follows:
- exit code 0 (all checks passed) -> continue to the "Inform User" step
- exit code 1 (validation failed) -> fix the reported issues and run the gate again
- exit code 2 (network blocked) -> stop and tell the user that human intervention is required

Keep the gate output in your reply as fresh evidence. Do not claim completion without output from this run.

### 11. Inform User

> Execute this step only after the verification gate passes.

> **IMPORTANT**: All TUI command formats listed below must be output in full. Do not show only the format for the current AI agent. If `.agents/.airc.json` configures custom TUIs (via `customTools`), read each tool's `name` and `invoke`, then add the matching command line in the same format (`${skillName}` becomes the skill name and `${projectName}` becomes the project name). Use the output template in `reference/output-template.md`.

## Completion Checklist

- [ ] Implemented the approved code changes
- [ ] Created `{implementation-artifact}`
- [ ] All required tests passed
- [ ] Updated task.md and appended the Activity Log entry
- [ ] Included every TUI command format, including any custom TUIs, in the user-facing next step

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
