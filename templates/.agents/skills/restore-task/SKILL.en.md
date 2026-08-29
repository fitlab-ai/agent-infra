---
name: restore-task
description: >
  Restore local task files from platform Issue comments.
  Use when local task files are missing and need rebuilding from platform Issue comments.
---

# Restore Task
> `--agent` values are defined in `.agents/rules/task-management.md` under “Collaborator Token Specification”.


Restore local task workspace files from platform Issue comments that contain sync markers.

## Boundary / Critical Rules

- Restore files only from comments that match the marker registry in `.agents/rules/issue-sync.md`
- Restore into a controlled staging directory under `.agents/workspace/`, then let lifecycle validate and place it under `active/{task-id}/`
- Stop immediately if the target directory already exists and ask the user to resolve the conflict first
- After executing this skill, you **must** immediately update the restored `task.md`

Version stamp rule: when creating or updating `task.md` frontmatter, read `.agents/rules/version-stamp.md` first and write or refresh `agent_infra_version`.

## Task id short ref

> If `{task-id}` matches `^[#]?[0-9]+$` (bare numeric or `#`-prefixed), follow the "SKILL parameter resolver" section of `.agents/rules/task-short-id.md`; treat `{task-id}` as the resolved full `TASK-YYYYMMDD-HHMMSS` form for every downstream command.

## Step Start: Local Lifecycle Boundary

Comment parsing must not write the formal active directory. Step 6 declares one restore intent that validates staging and atomically commits base metadata, the started/done pair, final placement, and short-id allocation.

## Steps

### 1. Verify Input and Environment

Check:
- required `{issue-number}`
- optional `{task-id}`
- read `.agents/rules/issue-pr-commands.md` first and use its authentication commands to verify current platform access

If the user provided `{task-id}`, validate the `TASK-{yyyyMMdd-HHmmss}` format.

### 2. Fetch Issue Comments

Run `agent-infra-internal platform-comment list --issue {issue-number}` to read all paginated comments while preserving order and comment IDs; the intent owns platform context, authentication, and upstream resolution.

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
  - `review-analysis` / `review-analysis-r{N}` -> matching `.md`
  - `plan` / `plan-r{N}` -> matching `.md`
  - `review-plan` / `review-plan-r{N}` -> matching `.md`
  - `code` / `code-r{N}` -> matching `.md`
  - `review-code` / `review-code-r{N}` -> matching `.md`
  - `pr-review` / `pr-review-r{N}` -> matching `.md`

### 4. Process Chunks and Check the Local Directory

Read `.agents/rules/issue-sync.md` before executing this step.

For each file:
- collect its single comment or chunked comments
- for `task.md` comments, reverse the `<details>` frontmatter wrapper described in issue-sync.md before reassembling the file body
- when a chunk marker includes part and total indexes, sort by part and verify the set is complete
- extract the file body by removing the hidden marker, heading, and footer
- concatenate chunk bodies into the final file content

Before writing any file, verify that:
- no formal active, blocked, or completed directory exists for the task id
- the unique `.agents/workspace/.restore-staging-*` path shares the active workspace filesystem

If the directory already exists, stop immediately and tell the user to handle it manually first.

### 5. Write the Local Files

Create the controlled staging directory and write files back in this order:

1. `task.md`
2. every other restored artifact file in filename order

Write only files that were actually recovered from Issue comments. Do not invent missing files.

### 6. Apply the Restore Lifecycle Intent

```bash
agent-infra-internal task-lifecycle {task-id} restore --agent {standard-agent-token} \
  --staging-dir "{staging-dir}" --issue-number {issue-number}
```

Only `status=applied|no-op` means restore completed. The core validates task/Issue identity, file types, and artifact topology before exposing the active path, then commits metadata, Activity Log, placement, and short-id allocation. On `status=failed`, show recovery fields and retry the same intent; do not move staging or allocate manually.

### 7. Inform User

Report the restored task id, restored file count, and the active task directory.



## Completion Checklist

- [ ] Fetched Issue comments from the platform
- [ ] Restored task files locally
- [ ] Updated restored task metadata
- [ ] Reported the restored directory

### 8. Stop

Stop after the completion checklist. Do not commit automatically.
