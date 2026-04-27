---
name: create-issue
description: "Create an Issue from a task file"
---

# Create Issue

Create the base Issue from `task.md` and write `issue_number` back to the task.

## Boundary / Critical Rules

- Build the Issue title and body from `task.md` only
- Issue title format: `type(scope): description` - map `type` from task.md (`feature` -> `feat`, `bugfix` -> `fix`, `refactor` -> `refactor`, `docs` -> `docs`, `chore` -> `chore`), infer scope from the affected module (omit it if unclear), and use the task title from task.md verbatim for the description (do not translate or rewrite)
- Do not read `analysis.md`, `plan.md`, `implementation.md`, or review artifacts
- The only durable outputs are the Issue and the `issue_number` update in task.md
- After executing this skill, you **must** immediately update task.md

## Steps

### 1. Verify Prerequisites

Check:
- `.agents/workspace/active/{task-id}/task.md`
- read `.agents/rules/issue-pr-commands.md` first, then follow its prerequisite steps to complete authentication and code-hosting platform detection

If `issue_number` already exists and is not empty or `N/A`, confirm with the user before creating a replacement Issue.

### 2. Extract Task Information

Extract the title, `## Description`, `## Requirements`, `type`, and `milestone` from task.md. Build the Issue title by mapping task.md `type` to a Conventional Commits type, inferring scope, and formatting it as `cc_type(scope): task_title` or `cc_type: task_title` when scope is unclear. If task.md does not provide an explicit `milestone` field, infer it by following "Phase 1: `create-issue`" in `.agents/rules/milestone-inference.md`.

### 3. Build Issue Content

Detect Issue templates through `.agents/rules/issue-pr-commands.md` and decide whether to use a matched template path or the fallback path.

> Template detection, field mapping for `textarea`, `input`, `dropdown`, and `checkboxes`, and the fallback body rules live in `reference/template-matching.md`. Read `reference/template-matching.md` before building the body.

> Label filtering, Issue Type fallback, `issue-types` API handling, `milestone` logic, `--milestone`, and `in:` label rules live in `reference/label-and-type.md`. Read `reference/label-and-type.md` before creating the Issue.

### 4. Create the Issue

Create and enrich the Issue by following the "Create Issue" and "Set the Issue Type" sections in `.agents/rules/issue-pr-commands.md`. Omit label arguments when nothing valid remains.

Handle labels, milestone, Issue Type, and assignee behavior by following the permission-degradation rules in `.agents/rules/issue-pr-commands.md` and `.agents/rules/issue-sync.md`.

### 5. Update Task Status

Get the current time:

```bash
date "+%Y-%m-%d %H:%M:%S%:z"
```

Write back `issue_number`, update `updated_at`, and append the Create Issue Activity Log entry.

### 5.1 Backfill Existing Artifacts

If artifact files already exist in the task directory, backfill them in this order:

1. `task.md` -> the task comment marker defined in `.agents/rules/issue-sync.md` (idempotent create or update)
2. Backfill existing `analysis*.md`, `plan*.md`, `implementation*.md`, `review*.md`, and `refinement*.md` files in filename order

Every backfill action must follow the raw publishing, task.md sync, and chunking rules in `.agents/rules/issue-sync.md`.

### 6. Verification Gate

Run the verification gate to confirm the task artifact and sync state are valid:

```bash
node .agents/scripts/validate-artifact.js gate create-issue .agents/workspace/active/{task-id} --format text
```

Handle the result as follows:
- exit code 0 (all checks passed) -> continue to the "Inform User" step
- exit code 1 (validation failed) -> fix the reported issues and run the gate again
- exit code 2 (network blocked) -> stop and tell the user that human intervention is required

Keep the gate output in your reply as fresh evidence. Do not claim completion without output from this run.

### 7. Inform User

> Execute this step only after the verification gate passes.

> **IMPORTANT**: All TUI command formats listed below must be output in full. Do not show only the format for the current AI agent. If `.agents/.airc.json` configures custom TUIs (via `customTUIs`), read each tool's `name` and `invoke`, then add the matching command line in the same format (`${skillName}` becomes the skill name and `${projectName}` becomes the project name).

Show the Issue number, URL, labels, Issue Type, milestone result, confirm that `issue_number` was written back, and include the next-step commands in every TUI format:

```
Next step - run requirements analysis:
  - Claude Code / OpenCode: /analyze-task {task-id}
  - Gemini CLI: /{{project}}:analyze-task {task-id}
  - Codex CLI: $analyze-task {task-id}
```

## Completion Checklist

- [ ] Created the Issue
- [ ] Used `task.md` as the only content source
- [ ] Recorded `issue_number` in task.md
- [ ] Updated `updated_at` and appended the Activity Log entry
- [ ] Included all TUI formats, including any custom TUIs, for the next-step commands

## STOP

Stop after the checklist. Do not start detailed progress sync here.

## Notes

- `create-issue` creates the base Issue; later status, comments, and checkboxes are maintained by workflow skills and platform automation
- If no valid labels survive filtering, create the Issue without labels instead of failing
- If Issue Type or milestone setup fails, continue and record the fallback outcome

## Error Handling

- Task not found: `Task {task-id} not found`
- the platform CLI unavailable or unauthenticated
- Empty description in task.md
- Issue creation failure
