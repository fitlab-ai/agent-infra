---
name: restore-task
description: "Restore local task files from platform Issue comments"
---

# Restore Task

Restore local task workspace files from platform Issue comments that contain sync markers.

## Boundary / Critical Rules

- Restore files only from comments marked with `<!-- sync-issue:{task-id}:... -->`
- Restore into `.agents/workspace/active/{task-id}/` by default
- Stop immediately if the target directory already exists and ask the user to resolve the conflict first
- After executing this skill, you **must** immediately update the restored `task.md`

## Steps

### 1. Verify Input and Environment

Check:
- required `{issue-number}`
- optional `{task-id}`
- read `.agents/rules/issue-pr-commands.md` first and use its authentication commands to verify current platform access

If the user provided `{task-id}`, validate the `TASK-{yyyyMMdd-HHmmss}` format.

### 2. Fetch Issue Comments

Read all Issue comments by following the "Read Issue comments" command in `.agents/rules/issue-pr-commands.md`, preserving the original order and comment IDs.

### 3. Determine the task-id and Files to Restore

Filter comments by these hidden markers:

```html
<!-- sync-issue:{task-id}:{file-stem} -->
<!-- sync-issue:{task-id}:{file-stem}:{part}/{total} -->
```

Rules:
- when `{task-id}` was provided, match only that task
- when `{task-id}` was omitted, infer it from the `<!-- sync-issue:{task-id}:task -->` comment first
- if you cannot determine a unique task-id, stop and tell the user
- ignore `summary` marker comments because they are complete-task aggregate output rather than restorable local task files
- map `{file-stem}` back to filenames:
  - `task` -> `task.md`
  - `analysis` / `analysis-r{N}` -> matching `.md`
  - `plan` / `plan-r{N}` -> matching `.md`
  - `implementation` / `implementation-r{N}` -> matching `.md`
  - `review` / `review-r{N}` -> matching `.md`
  - `refinement` / `refinement-r{N}` -> matching `.md`

### 4. Process Chunks and Check the Local Directory

Read `.agents/rules/issue-sync.md` before executing this step.

For each file:
- collect its single comment or chunked comments
- for `task.md` comments, reverse the `<details>` frontmatter wrapper described in issue-sync.md before reassembling the file body
- when `{part}/{total}` exists, sort by part and verify the set is complete
- extract the file body by removing the hidden marker, heading, and footer
- concatenate chunk bodies into the final file content

Before writing any file, verify that:
- `.agents/workspace/active/{task-id}/` does not exist

If the directory already exists, stop immediately and tell the user to handle it manually first.

### 5. Write the Local Files

Create `.agents/workspace/active/{task-id}/` and write files back in this order:

1. `task.md`
2. every other restored artifact file in filename order

Write only files that were actually recovered from Issue comments. Do not invent missing files.

### 6. Update the Restored task.md

Get the current time:

```bash
date "+%Y-%m-%d %H:%M:%S%:z"
```

Update the restored `task.md`:
- `status`: `active`
- `assigned_to`: {current AI agent}
- `updated_at`: {current time}
- keep the original `current_step`
- append this entry to `## Activity Log`:
  ```
  - {YYYY-MM-DD HH:mm:ss±HH:MM} — **Restore Task** by {agent} — Restored task from Issue #{issue-number}
  ```

### 7. Verification Gate

Run the verification gate:

```bash
node .agents/scripts/validate-artifact.js gate restore-task .agents/workspace/active/{task-id} --format text
```

Handle the result as follows:
- exit code 0 (all checks passed) -> continue to the "Inform User" step
- exit code 1 (validation failed) -> fix the reported issues and run the gate again
- exit code 2 (network blocked) -> stop and tell the user that human intervention is required

Keep the gate output in your reply as fresh evidence. Do not claim completion without output from this run.

### 8. Inform User

> Execute this step only after the verification gate passes.

> **IMPORTANT**: All TUI command formats listed below must be output in full. Do not show only the format for the current AI agent. If `.agents/.airc.json` configures custom TUIs (via `customTools`), read each tool's `name` and `invoke`, then add the matching command line in the same format (`${skillName}` becomes the skill name and `${projectName}` becomes the project name).

Output format:

```text
Task {task-id} was restored from Issue #{issue-number}.

Summary:
- Restored files: {count}
- Task directory: .agents/workspace/active/{task-id}/
- Current step: {current_step}

Next step - check task status:
  - Claude Code / OpenCode: /check-task {task-id}
  - Gemini CLI: /{{project}}:check-task {task-id}
  - Codex CLI: $check-task {task-id}
```

## Completion Checklist

- [ ] Fetched and parsed Issue comments
- [ ] Restored `task.md` and every available artifact file
- [ ] Updated the restored task.md
- [ ] Ran and passed the verification gate
- [ ] Showed the next-step commands in every TUI format, including any custom TUIs

## STOP

Stop after completing the checklist. Do not continue the workflow automatically.

## Error Handling

- Issue missing or inaccessible
- Platform CLI unavailable or unauthenticated
- No sync-marked comments found
- Unable to determine a unique `task-id`
- Target directory already exists
- Missing chunks or incomplete chunk ordering
