---
name: commit
description: "Commit the current changes to Git"
---

# Commit Changes

Create a Git commit without overwriting user work and update the related task state when needed.

## 1. Check Local Modifications (CRITICAL)

Before any edit, inspect:

```bash
git status --short
git diff
```

Respect existing user changes. If your planned edit conflicts with them, stop and ask before proceeding.

## 2. Update Copyright Headers

Use the current year dynamically and only update files that are already modified.

> The full copyright workflow lives in `reference/copyright-check.md`. Read `reference/copyright-check.md` before editing any header.

## 3. Build the Commit Message

Review status, diff, and recent history, then prepare a Conventional Commit with the correct co-author lines.

> Commit message rules, examples, and multi-agent co-authorship details live in `reference/commit-message.md`. Read `reference/commit-message.md` before writing the commit.

## 4. Create the Commit

Stage specific files only and run `git commit` with the prepared message.

## 5. Update Task Status When Applicable

Get the current time:

```bash
date "+%Y-%m-%d %H:%M:%S"
```

> The full four-case status matrix, prerequisite checks, and multi-TUI next-step commands live in `reference/task-status-update.md`. Read `reference/task-status-update.md` before updating task state.

Append the Commit Activity Log entry and choose exactly one next-step case:
- final commit -> `complete-task {task-id}`
- more work remains -> update task.md and stop
- ready for review -> `review-task {task-id}`
- ready for PR -> `create-pr`

## Notes

- Never commit secrets such as `.env`, credentials, or keys
- Keep the current agent first in the co-author block
- Do not use `git add -A` or `git add .`

## Error Handling

- If the task status update fails, warn the user but do not block the commit
