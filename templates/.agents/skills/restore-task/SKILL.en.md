---
name: restore-task
description: "Restore local task files from platform Issue comments"
---

# Restore Task

Restore local task workspace files from platform Issue comments that contain sync markers.

## Boundary / Critical Rules

- Restore files only from comments that match the marker registry in `.agents/rules/issue-sync.md`
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

Filter comments by the task, artifact, and chunked artifact markers defined in `.agents/rules/issue-sync.md`.

Rules:
- when `{task-id}` was provided, match only that task
- when `{task-id}` was omitted, infer it from the task comment marker first
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
- when a chunk marker includes part and total indexes, sort by part and verify the set is complete
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

Append an Activity Log entry indicating the task was restored from the platform Issue.

### 7. Inform User

Report the restored task id, restored file count, and the active task directory.

## Completion Checklist

- [ ] Fetched Issue comments from the platform
- [ ] Restored task files locally
- [ ] Updated restored task metadata
- [ ] Reported the restored directory

### 8. Stop

Stop after the completion checklist. Do not commit automatically.
